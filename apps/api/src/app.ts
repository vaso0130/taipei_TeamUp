import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import type { z, ZodType } from 'zod'
import {
  AdminDecideSchema,
  ApplySchema,
  ContactsSchema,
  CreateTeamSchema,
  InviteSchema,
  ModerationTaskSchema,
  ParticipationInputSchema,
  ReportMessageSchema,
  RespondSchema,
  SendMessageSchema,
  StartThreadSchema,
  TEAM_STATUSES,
  UpdateMeSchema,
  UpdateTeamSchema,
  type TeamStatus,
} from '@teamup/shared'
import { secureHeaders } from 'hono/secure-headers'
import { AdminService } from './admin/service.js'
import { ApplicationError, type ApplicationService } from './applications/service.js'
import { AuthError, type AuthIdentity, type TokenVerifier } from './auth/verifier.js'
import { normalizeEmail } from './crypto/email.js'
import type { EventRepository } from './events/repository.js'
import { SlidingWindowLimiter } from './http/rate-limit.js'
import { MessagingError, type MessagingService } from './messaging/service.js'
import type { ModerationService } from './moderation/service.js'
import { ContentReportError, type ContentReportService } from './reports/content-service.js'
import { ParticipationError, type ParticipationService } from './participants/service.js'
import type { CaptchaVerifier } from './security/captcha.js'
import { TeamError, type TeamService } from './teams/service.js'
import type { CleanupService, PrivacyService } from './users/privacy-service.js'
import type { UserRecord } from './users/repository.js'
import type { UserService } from './users/service.js'

export interface AuthedDeps {
  verifier: TokenVerifier
  users: UserService
  participation: ParticipationService
  teams: TeamService
  applications: ApplicationService
  messaging: MessagingService
  moderation: ModerationService
  contentReports: ContentReportService
  admin: AdminService
  privacy: PrivacyService
  cleanup: CleanupService
}

export interface AppDeps {
  events: EventRepository
  /** Absent in seed-file read-only mode (ADR-004): data routes return 503. */
  authed?: AuthedDeps
  /** Normalized emails allowed into the admin review backend. */
  adminEmails?: Set<string>
  /** Shared secret protecting the Cloud Tasks worker route. */
  taskSecret?: string
  /** reCAPTCHA verifier (spec §8); absent → checks skipped (local dev). */
  captcha?: CaptchaVerifier
  /**
   * Browser origins allowed to call the API cross-origin (the web app
   * when hosted on a different origin than Cloud Run). Empty/absent →
   * no CORS headers (same-origin deployments and local dev proxy).
   */
  allowedOrigins?: string[]
}

interface AppEnv {
  Variables: {
    auth: AuthIdentity
    user: UserRecord
  }
}

const TEAM_ERROR_STATUS: Record<string, 404 | 400 | 403 | 409> = {
  event_not_found: 404,
  team_not_found: 404,
  application_not_found: 404,
  thread_not_found: 404,
  message_not_found: 404,
  participant_not_found: 404,
  user_not_found: 404,
  forbidden: 403,
  not_allowed: 403,
  cannot_message_self: 400,
  cannot_report_own: 400,
  already_reported: 409,
  recruiting_closed: 409,
  not_recruiting: 409,
  team_full: 409,
  already_in_team: 409,
  already_in_this_team: 409,
  duplicate_application: 409,
  not_pending: 409,
  owner_cannot_leave: 409,
  team_not_empty: 409,
  contacts_not_allowed_yet: 409,
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
  const authed = deps.authed

  // Security headers (spec §8); HSTS per §7.1.
  app.use(
    secureHeaders({
      strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
    }),
  )

  // Cross-origin access for the hosted web app — explicit allowlist only.
  const allowedOrigins = deps.allowedOrigins ?? []
  if (allowedOrigins.length > 0) {
    app.use(
      '/api/*',
      cors({
        origin: allowedOrigins,
        allowHeaders: ['authorization', 'content-type', 'x-recaptcha-token'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        maxAge: 3600,
      }),
    )
  }

  // Abuse limits (spec §8): per-account sliding windows. IP-level
  // throttling and reCAPTCHA run at the edge in production.
  const teamCreateLimiter = new SlidingWindowLimiter(3, 24 * 60 * 60 * 1000)
  const messageLimiter = new SlidingWindowLimiter(30, 60 * 60 * 1000)
  const reportLimiter = new SlidingWindowLimiter(10, 60 * 60 * 1000)
  const limited = (limiter: SlidingWindowLimiter) =>
    createMiddleware<AppEnv>(async (c, next) => {
      if (!limiter.allow(c.get('user').id)) {
        return c.json({ error: 'rate_limited', message: '操作太頻繁，請稍後再試' }, 429)
      }
      await next()
    })

  /** reCAPTCHA gate on abuse-prone writes (spec §8). */
  const captchaGuard = (action: string) =>
    createMiddleware<AppEnv>(async (c, next) => {
      if (deps.captcha) {
        const token = c.req.header('x-recaptcha-token')
        if (!token || !(await deps.captcha.verify(token, action))) {
          return c.json({ error: 'captcha_failed', message: '驗證失敗，請重新操作' }, 400)
        }
      }
      await next()
    })

  app.get('/healthz', (c) => c.json({ status: 'ok' }))
  // Alias: Google's frontend intercepts /healthz on *.run.app URLs,
  // so external monitors use this path instead (container probes are
  // unaffected — they bypass the GFE).
  app.get('/api/healthz', (c) => c.json({ status: 'ok' }))

  // ---- public event configuration ----

  app.get('/api/events', async (c) => {
    const events = await deps.events.listEvents()
    return c.json({ events })
  })

  app.get('/api/events/:slug', async (c) => {
    const detail = await deps.events.getEventBySlug(c.req.param('slug'))
    if (!detail) return c.json({ error: 'event_not_found' }, 404)
    return c.json(detail)
  })

  // ---- middleware ----

  const requireData = createMiddleware<AppEnv>(async (c, next) => {
    if (!authed) {
      return c.json({ error: 'read_only_mode', message: '此環境未連接資料庫，僅供瀏覽' }, 503)
    }
    await next()
  })

  const resolveUser = async (
    token: string,
  ): Promise<{ user: UserRecord; identity: AuthIdentity } | 'unauthorized' | 'blocked'> => {
    let identity: AuthIdentity
    try {
      identity = await authed!.verifier.verify(token)
    } catch (err) {
      if (err instanceof AuthError) return 'unauthorized'
      throw err
    }
    const user = await authed!.users.ensureUser(identity.email)
    return user.status === 'active' ? { user, identity } : 'blocked'
  }

  const isAdminEmail = (email: string) => deps.adminEmails?.has(normalizeEmail(email)) ?? false

  const bearer = (header: string | undefined): string | null => {
    const [scheme, token] = (header ?? '').split(' ')
    return scheme?.toLowerCase() === 'bearer' && token ? token : null
  }

  /** Strict auth: 401 without a valid token. */
  const authenticate = createMiddleware<AppEnv>(async (c, next) => {
    if (!authed) {
      return c.json({ error: 'read_only_mode', message: '此環境未連接資料庫，僅供瀏覽' }, 503)
    }
    const token = bearer(c.req.header('authorization'))
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    const resolved = await resolveUser(token)
    if (resolved === 'unauthorized') return c.json({ error: 'unauthorized' }, 401)
    if (resolved === 'blocked') return c.json({ error: 'account_unavailable' }, 403)
    c.set('user', resolved.user)
    c.set('auth', resolved.identity)
    await next()
  })

  /** Optional auth for public pages: sets the viewer when a valid token is present. */
  const maybeAuthenticate = createMiddleware<AppEnv>(async (c, next) => {
    if (authed) {
      const token = bearer(c.req.header('authorization'))
      if (token) {
        const resolved = await resolveUser(token)
        if (typeof resolved !== 'string') {
          c.set('user', resolved.user)
          c.set('auth', resolved.identity)
        }
      }
    }
    await next()
  })

  /** Admin allowlist gate — runs after authenticate. */
  const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
    if (!isAdminEmail(c.get('auth').email)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    await next()
  })

  const parseBody = async <S extends ZodType>(
    c: Context<AppEnv>,
    schema: S,
  ): Promise<{ ok: true; data: z.output<S> } | { ok: false; issues: unknown }> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => null))
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, issues: parsed.error.issues }
  }

  const domainError = (c: Context<AppEnv>, err: unknown) => {
    if (err instanceof MessagingError) {
      return c.json({ error: err.code }, TEAM_ERROR_STATUS[err.code] ?? 400)
    }
    if (err instanceof TeamError || err instanceof ApplicationError) {
      const status = TEAM_ERROR_STATUS[err.code] ?? 400
      const detail = err instanceof TeamError ? (err.detail ?? null) : null
      return c.json({ error: err.code, detail }, status)
    }
    if (err instanceof ParticipationError) {
      const status = err.code === 'event_not_found' ? 404 : 400
      return c.json({ error: err.code, detail: err.detail ?? null }, status)
    }
    if (err instanceof ContentReportError) {
      return c.json({ error: err.code }, TEAM_ERROR_STATUS[err.code] ?? 400)
    }
    throw err
  }

  /** Inline name screening refusal: rejected → change the name; unavailable → fail closed. */
  const nameScreenError = (c: Context<AppEnv>, result: 'rejected' | 'unavailable') =>
    result === 'rejected'
      ? c.json({ error: 'name_rejected' }, 400)
      : c.json({ error: 'moderation_unavailable' }, 503)

  // ---- me / profile ----

  app.use('/api/me', authenticate)
  app.use('/api/me/*', authenticate)

  app.get('/api/me', async (c) => {
    const me = await authed!.users.toMeView(c.get('user'))
    return c.json({ ...me, isAdmin: isAdminEmail(c.get('auth').email) })
  })

  app.patch('/api/me', async (c) => {
    const body = await parseBody(c, UpdateMeSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    const screened = await authed!.moderation.screenName(
      body.data.displayName,
      'display_name',
      c.get('user').id,
      c.get('user').id,
    )
    if (screened !== 'ok') return nameScreenError(c, screened)
    await authed!.users.updateDisplayName(c.get('user').id, body.data.displayName)
    return c.json({ displayName: body.data.displayName })
  })

  /** One-click data export (spec §6.5). */
  app.get('/api/me/export', async (c) => {
    return c.json(await authed!.privacy.exportData(c.get('user')))
  })

  /** One-click account deletion: leaves teams, soft-deletes, 30-day purge. */
  app.delete('/api/me', async (c) => {
    await authed!.privacy.deleteAccount(c.get('user'))
    return c.json({ deleted: true })
  })

  // ---- participation ----

  app.use('/api/events/:slug/participation', authenticate)

  app.get('/api/events/:slug/participation', async (c) => {
    const view = await authed!.participation.get(c.req.param('slug'), c.get('user').id)
    if (!view) return c.json({ error: 'participation_not_found' }, 404)
    return c.json(view)
  })

  app.put('/api/events/:slug/participation', async (c) => {
    const body = await parseBody(c, ParticipationInputSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        await authed!.participation.upsert(c.req.param('slug'), c.get('user').id, body.data),
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  /** 找人 public list. */
  app.get('/api/events/:slug/participants', requireData, async (c) => {
    try {
      return c.json({ participants: await authed!.participation.listPublic(c.req.param('slug')) })
    } catch (err) {
      return domainError(c, err)
    }
  })

  // ---- teams ----

  app.get('/api/events/:slug/teams', requireData, maybeAuthenticate, async (c) => {
    const status = c.req.query('status')
    const filter = {
      ...(status && (TEAM_STATUSES as readonly string[]).includes(status)
        ? { status: status as TeamStatus }
        : {}),
      ...(c.req.query('role') ? { role: c.req.query('role')! } : {}),
      ...(c.req.query('skill') ? { skill: c.req.query('skill')! } : {}),
    }
    try {
      return c.json({ teams: await authed!.teams.listTeams(c.req.param('slug'), filter) })
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.post(
    '/api/events/:slug/teams',
    authenticate,
    limited(teamCreateLimiter),
    captchaGuard('create_team'),
    async (c) => {
    const body = await parseBody(c, CreateTeamSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    // Public names are screened inline (accept-or-refuse; no hidden state).
    const screened = await authed!.moderation.screenName(
      body.data.name,
      'team_name',
      c.get('user').id,
      c.get('user').id,
    )
    if (screened !== 'ok') return nameScreenError(c, screened)
    try {
      return c.json(
        await authed!.teams.createTeam(c.req.param('slug'), c.get('user').id, body.data),
        201,
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.get('/api/events/:slug/my-team', authenticate, async (c) => {
    const team = await authed!.teams.myTeam(c.req.param('slug'), c.get('user').id)
    return c.json({ team })
  })

  app.get('/api/teams/:id', requireData, maybeAuthenticate, async (c) => {
    try {
      const viewer = c.var.user as UserRecord | undefined
      return c.json(await authed!.teams.getTeamDetail(c.req.param('id'), viewer?.id ?? null))
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.patch('/api/teams/:id', authenticate, async (c) => {
    const body = await parseBody(c, UpdateTeamSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    if (body.data.name !== undefined) {
      const screened = await authed!.moderation.screenName(
        body.data.name,
        'team_name',
        c.req.param('id'),
        c.get('user').id,
      )
      if (screened !== 'ok') return nameScreenError(c, screened)
    }
    try {
      return c.json(await authed!.teams.updateTeam(c.req.param('id'), c.get('user').id, body.data))
    } catch (err) {
      return domainError(c, err)
    }
  })

  /** Owner deletes their own (sole-member) team. */
  app.delete('/api/teams/:id', authenticate, async (c) => {
    try {
      await authed!.teams.deleteTeam(c.req.param('id'), c.get('user').id)
      return c.json({ deleted: true })
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.put('/api/teams/:id/contacts', authenticate, async (c) => {
    const body = await parseBody(c, ContactsSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        await authed!.teams.designateContacts(c.req.param('id'), c.get('user').id, body.data),
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.post('/api/teams/:id/leave', authenticate, async (c) => {
    try {
      await authed!.teams.leaveTeam(c.req.param('id'), c.get('user').id)
      return c.json({ left: true })
    } catch (err) {
      return domainError(c, err)
    }
  })

  // ---- applications ----

  app.post('/api/teams/:id/applications', authenticate, captchaGuard('apply_team'), async (c) => {
    const body = await parseBody(c, ApplySchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        await authed!.applications.apply(c.req.param('id'), c.get('user').id, body.data.message),
        201,
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.post('/api/teams/:id/invitations', authenticate, async (c) => {
    const body = await parseBody(c, InviteSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        await authed!.applications.invite(
          c.req.param('id'),
          c.get('user').id,
          body.data.userId,
          body.data.message,
        ),
        201,
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.get('/api/teams/:id/applications', authenticate, async (c) => {
    try {
      return c.json({
        applications: await authed!.applications.listForTeam(c.req.param('id'), c.get('user').id),
      })
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.get('/api/events/:slug/my-applications', authenticate, async (c) => {
    return c.json({
      applications: await authed!.applications.listMine(c.req.param('slug'), c.get('user').id),
    })
  })

  app.post('/api/applications/:id/respond', authenticate, async (c) => {
    const body = await parseBody(c, RespondSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        await authed!.applications.respond(c.req.param('id'), c.get('user').id, body.data.action),
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.post('/api/applications/:id/withdraw', authenticate, async (c) => {
    try {
      await authed!.applications.withdraw(c.req.param('id'), c.get('user').id)
      return c.json({ withdrawn: true })
    } catch (err) {
      return domainError(c, err)
    }
  })

  // ---- messaging ----

  app.get('/api/events/:slug/threads', authenticate, async (c) => {
    return c.json({
      threads: await authed!.messaging.listThreads(c.req.param('slug'), c.get('user').id),
    })
  })

  app.post('/api/events/:slug/threads', authenticate, limited(messageLimiter), async (c) => {
    const body = await parseBody(c, StartThreadSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        await authed!.messaging.startThread(
          c.req.param('slug'),
          c.get('user').id,
          body.data.toUserId,
          body.data.body,
        ),
        201,
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.get('/api/threads/:id', authenticate, async (c) => {
    try {
      return c.json(await authed!.messaging.getThread(c.req.param('id'), c.get('user').id))
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.get('/api/threads/:id/messages', authenticate, async (c) => {
    try {
      return c.json({
        messages: await authed!.messaging.listMessages(c.req.param('id'), c.get('user').id),
      })
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.post('/api/threads/:id/messages', authenticate, limited(messageLimiter), async (c) => {
    const body = await parseBody(c, SendMessageSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        await authed!.messaging.send(c.req.param('id'), c.get('user').id, body.data.body),
        201,
      )
    } catch (err) {
      return domainError(c, err)
    }
  })

  /** Report a counterpart's message → escalation re-review (spec §5). */
  app.post('/api/messages/:id/report', authenticate, limited(reportLimiter), async (c) => {
    const body = await parseBody(c, ReportMessageSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      await authed!.messaging.report(c.req.param('id'), c.get('user').id, body.data.reason)
      return c.json({ reported: true }, 201)
    } catch (err) {
      return domainError(c, err)
    }
  })

  /** Report a team's public content → escalation re-review. */
  app.post('/api/teams/:id/report', authenticate, limited(reportLimiter), async (c) => {
    const body = await parseBody(c, ReportMessageSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      await authed!.contentReports.reportTeam(c.req.param('id'), c.get('user').id, body.data.reason)
      return c.json({ reported: true }, 201)
    } catch (err) {
      return domainError(c, err)
    }
  })

  /** Report a participant's public profile → escalation re-review. */
  app.post(
    '/api/events/:slug/participants/:userId/report',
    authenticate,
    limited(reportLimiter),
    async (c) => {
      const body = await parseBody(c, ReportMessageSchema)
      if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
      try {
        await authed!.contentReports.reportParticipant(
          c.req.param('slug'),
          c.req.param('userId'),
          c.get('user').id,
          body.data.reason,
        )
        return c.json({ reported: true }, 201)
      } catch (err) {
        return domainError(c, err)
      }
    },
  )

  // ---- admin review backend (spec §5.7) ----

  app.use('/api/admin/*', authenticate, requireAdmin)

  app.get('/api/admin/moderation/pending', async (c) => {
    return c.json({ items: await authed!.admin.listPending(c.get('user').id) })
  })

  /** Platform overview numbers (counts only, no content). */
  app.get('/api/admin/stats', async (c) => {
    const slug = c.req.query('event')
    if (!slug) return c.json({ error: 'validation_failed', message: 'event query required' }, 400)
    return c.json(await authed!.admin.getStats(slug))
  })

  /** Risk overview: high/medium/reported/spot-check messages (metadata only). */
  app.get('/api/admin/messages/risk', async (c) => {
    return c.json({ items: await authed!.admin.listRiskMessages() })
  })

  /** Full decrypted thread for review — the read is audit-logged. */
  app.get('/api/admin/threads/:id', async (c) => {
    const thread = await authed!.admin.getThreadForReview(c.req.param('id'), c.get('user').id)
    if (!thread) return c.json({ error: 'thread_not_found' }, 404)
    return c.json(thread)
  })

  /** Member roster (metadata only — never email or content). */
  app.get('/api/admin/users', async (c) => {
    const slug = c.req.query('event')
    if (!slug) return c.json({ error: 'validation_failed', message: 'event query required' }, 400)
    return c.json({ items: await authed!.admin.listUsers(slug) })
  })

  /** Team roster (public team fields + owner name). */
  app.get('/api/admin/teams', async (c) => {
    const slug = c.req.query('event')
    if (!slug) return c.json({ error: 'validation_failed', message: 'event query required' }, 400)
    return c.json({ items: await authed!.admin.listTeams(slug) })
  })

  /** Admin force-disband a team (members cascade out; audit-logged). */
  app.delete('/api/admin/teams/:id', async (c) => {
    const done = await authed!.admin.deleteTeam(c.req.param('id'), c.get('user').id)
    if (!done) return c.json({ error: 'team_not_found' }, 404)
    return c.json({ deleted: true })
  })

  /** Manual suspension; strike-exempt (admin) accounts are refused. */
  app.post('/api/admin/users/:id/suspend', async (c) => {
    const result = await authed!.moderation.suspend(c.req.param('id'), c.get('user').id)
    if (result === 'exempt') return c.json({ error: 'cannot_suspend_admin' }, 403)
    if (result === 'not_active') return c.json({ error: 'not_active' }, 409)
    return c.json({ suspended: true })
  })

  /** Lift a suspension (also resets the current strike window). */
  app.post('/api/admin/users/:id/reactivate', async (c) => {
    const done = await authed!.moderation.reactivate(c.req.param('id'), c.get('user').id)
    if (!done) return c.json({ error: 'not_suspended' }, 409)
    return c.json({ reactivated: true })
  })

  /** One user's moderation history (strike view, no content). */
  app.get('/api/admin/users/:id/moderation', async (c) => {
    const history = await authed!.admin.getUserModeration(c.req.param('id'))
    if (!history) return c.json({ error: 'user_not_found' }, 404)
    return c.json(history)
  })

  app.post('/api/admin/moderation/decide', async (c) => {
    const body = await parseBody(c, AdminDecideSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    await authed!.moderation.decide(body.data.target, body.data.action, c.get('user').id)
    return c.json({ decided: true })
  })

  // ---- Cloud Tasks worker callback (spec §5.2) ----

  app.post('/internal/moderation/tasks', async (c) => {
    if (!authed || !deps.taskSecret) return c.json({ error: 'not_found' }, 404)
    if (c.req.header('x-task-secret') !== deps.taskSecret) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const body = await parseBody(c, ModerationTaskSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    const visibility = await authed.moderation.processAsync(body.data.target)
    return c.json({ processed: true, visibility })
  })

  // ---- Cloud Scheduler cleanup callback (spec §6.4) ----

  app.post('/internal/cleanup', async (c) => {
    if (!authed || !deps.taskSecret) return c.json({ error: 'not_found' }, 404)
    if (c.req.header('x-task-secret') !== deps.taskSecret) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return c.json(await authed.cleanup.run())
  })

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((err, c) => {
    // Never leak internals to clients; details go to logs only.
    console.error(err)
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
