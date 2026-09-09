import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { requestId } from 'hono/request-id'
import { z, type ZodType } from 'zod'
import {
  ADMIN_EVENT_ERRORS,
  AdminDecideSchema,
  AdminEventStatusInputSchema,
  AdminReportsQuerySchema,
  ApplySchema,
  ContactsSchema,
  CreateEventInputSchema,
  CreateTeamSchema,
  DuplicateEventInputSchema,
  EVENT_SLUG_PATTERN,
  InviteSchema,
  ModerationTaskSchema,
  ParticipationInputSchema,
  ReportMessageSchema,
  RespondSchema,
  SendMessageSchema,
  StartThreadSchema,
  TEAM_STATUSES,
  UpdateEventInputSchema,
  UpdateMeSchema,
  UpdateTeamSchema,
  type AdminEventErrorCode,
  type TeamStatus,
} from '@teamup/shared'
import { secureHeaders } from 'hono/secure-headers'
import { AdminError, AdminService } from './admin/service.js'
import { ApplicationError, type ApplicationService } from './applications/service.js'
import { AuthError, type AuthIdentity, type TokenVerifier } from './auth/verifier.js'
import { normalizeEmail, secretEquals } from './crypto/email.js'
import { EventAdminError, type EventAdminService } from './events/admin-service.js'
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
  /** Admin event management (ADR-035); absent → those routes return 503 `unavailable`. */
  eventAdmin?: EventAdminService
}

/**
 * Per-account abuse limits (spec §8). These are PLATFORM rules — how
 * much load one account may put on paid/expensive paths — not event
 * rules, so they live here with environment overrides (RATE_LIMIT_*).
 */
export interface RateLimitConfig {
  teamCreatesPerDay: number
  messagesPerHour: number
  reportsPerHour: number
  /** Nickname and team-name changes (each one is an inline model review). */
  nameChangesPerHour: number
  participationWritesPerHour: number
  invitationsPerDay: number
  appliesPerDay: number
  /** Full export decrypts every field through KMS. */
  exportsPerDay: number
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  teamCreatesPerDay: 3,
  messagesPerHour: 30,
  reportsPerHour: 10,
  nameChangesPerHour: 10,
  participationWritesPerHour: 20,
  invitationsPerDay: 20,
  appliesPerDay: 20,
  exportsPerDay: 3,
}

const RATE_LIMIT_ENV: Record<keyof RateLimitConfig, string> = {
  teamCreatesPerDay: 'RATE_LIMIT_TEAM_CREATES_PER_DAY',
  messagesPerHour: 'RATE_LIMIT_MESSAGES_PER_HOUR',
  reportsPerHour: 'RATE_LIMIT_REPORTS_PER_HOUR',
  nameChangesPerHour: 'RATE_LIMIT_NAME_CHANGES_PER_HOUR',
  participationWritesPerHour: 'RATE_LIMIT_PARTICIPATION_WRITES_PER_HOUR',
  invitationsPerDay: 'RATE_LIMIT_INVITATIONS_PER_DAY',
  appliesPerDay: 'RATE_LIMIT_APPLIES_PER_DAY',
  exportsPerDay: 'RATE_LIMIT_EXPORTS_PER_DAY',
}

/** Defaults overridden by positive-integer RATE_LIMIT_* environment values. */
export function rateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const config = { ...DEFAULT_RATE_LIMITS }
  for (const key of Object.keys(RATE_LIMIT_ENV) as (keyof RateLimitConfig)[]) {
    const raw = env[RATE_LIMIT_ENV[key]]
    if (raw === undefined || raw === '') continue
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${RATE_LIMIT_ENV[key]} must be a positive integer`)
    }
    config[key] = value
  }
  return config
}

/** Maximum JSON body accepted on any route (the largest field is a 1000-char message). */
export const MAX_BODY_BYTES = 64 * 1024

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
  /** Per-account limits; defaults when absent. */
  rateLimits?: RateLimitConfig
}

interface AppEnv {
  Variables: {
    auth: AuthIdentity
    user: UserRecord
    requestId: string
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
  /** The caller must join the event (and answer its adult check) first. */
  participation_required: 409,
}

const EVENT_ADMIN_ERROR_STATUS: Record<AdminEventErrorCode, 404 | 409> = {
  [ADMIN_EVENT_ERRORS.eventNotFound]: 404,
  [ADMIN_EVENT_ERRORS.slugTaken]: 409,
  [ADMIN_EVENT_ERRORS.slugImmutable]: 409,
  [ADMIN_EVENT_ERRORS.maxMembersBelowExisting]: 409,
  [ADMIN_EVENT_ERRORS.minMembersAboveExisting]: 409,
  [ADMIN_EVENT_ERRORS.dictionaryKeyInUse]: 409,
  [ADMIN_EVENT_ERRORS.invalidStatusTransition]: 409,
  [ADMIN_EVENT_ERRORS.cannotOpenIncomplete]: 409,
  [ADMIN_EVENT_ERRORS.eventNotEmpty]: 409,
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const UuidSchema = z.string().uuid()

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
  const authed = deps.authed
  const limits = deps.rateLimits ?? DEFAULT_RATE_LIMITS

  app.use(requestId())

  // Security headers (spec §8); HSTS per §7.1.
  app.use(
    secureHeaders({
      strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
    }),
  )

  // Request bodies are small JSON documents; anything larger is abuse.
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
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
  const teamCreateLimiter = new SlidingWindowLimiter(limits.teamCreatesPerDay, DAY_MS)
  const messageLimiter = new SlidingWindowLimiter(limits.messagesPerHour, HOUR_MS)
  const reportLimiter = new SlidingWindowLimiter(limits.reportsPerHour, HOUR_MS)
  const nameChangeLimiter = new SlidingWindowLimiter(limits.nameChangesPerHour, HOUR_MS)
  const participationLimiter = new SlidingWindowLimiter(limits.participationWritesPerHour, HOUR_MS)
  const inviteLimiter = new SlidingWindowLimiter(limits.invitationsPerDay, DAY_MS)
  const applyLimiter = new SlidingWindowLimiter(limits.appliesPerDay, DAY_MS)
  const exportLimiter = new SlidingWindowLimiter(limits.exportsPerDay, DAY_MS)

  const rateLimited = (c: Context<AppEnv>) =>
    c.json({ error: 'rate_limited', message: '操作太頻繁，請稍後再試' }, 429)
  const limited = (limiter: SlidingWindowLimiter) =>
    createMiddleware<AppEnv>(async (c, next) => {
      if (!limiter.allow(c.get('user').id)) return rateLimited(c)
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

  /**
   * Path ids must be UUIDs before they reach a query: a malformed id is
   * simply "no such resource" (404 with the resource's own code) instead
   * of a database type error surfacing as 500.
   */
  const uuidParam = (name: string, notFoundCode: string) =>
    createMiddleware<AppEnv>(async (c, next) => {
      if (!UuidSchema.safeParse(c.req.param(name)).success) {
        return c.json({ error: notFoundCode }, 404)
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
    if (err instanceof MessagingError || err instanceof AdminError) {
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
    const user = c.get('user')
    // Unchanged name: nothing to review, nothing to write.
    if (body.data.displayName === user.displayName) {
      return c.json({ displayName: user.displayName })
    }
    if (!nameChangeLimiter.allow(user.id)) return rateLimited(c)
    const screened = await authed!.moderation.screenName(
      body.data.displayName,
      'display_name',
      user.id,
      user.id,
    )
    if (screened !== 'ok') return nameScreenError(c, screened)
    await authed!.users.updateDisplayName(user.id, body.data.displayName)
    return c.json({ displayName: body.data.displayName })
  })

  /** One-click data export (spec §6.5). */
  app.get('/api/me/export', limited(exportLimiter), async (c) => {
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

  app.put('/api/events/:slug/participation', limited(participationLimiter), async (c) => {
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
    },
  )

  app.get('/api/events/:slug/my-team', authenticate, async (c) => {
    const team = await authed!.teams.myTeam(c.req.param('slug'), c.get('user').id)
    return c.json({ team })
  })

  const teamId = uuidParam('id', 'team_not_found')

  app.get('/api/teams/:id', requireData, maybeAuthenticate, teamId, async (c) => {
    try {
      const viewer = c.var.user as UserRecord | undefined
      return c.json(await authed!.teams.getTeamDetail(c.req.param('id'), viewer?.id ?? null))
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.patch('/api/teams/:id', authenticate, teamId, async (c) => {
    const body = await parseBody(c, UpdateTeamSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      // Authorization BEFORE any paid work: only the owner may trigger a
      // name review, and only for a name that actually changes.
      const team = await authed!.teams.requireOwner(c.req.param('id'), c.get('user').id)
      if (body.data.name !== undefined && body.data.name !== team.name) {
        if (!nameChangeLimiter.allow(c.get('user').id)) return rateLimited(c)
        const screened = await authed!.moderation.screenName(
          body.data.name,
          'team_name',
          team.id,
          c.get('user').id,
        )
        if (screened !== 'ok') return nameScreenError(c, screened)
      }
      return c.json(await authed!.teams.updateTeam(team.id, c.get('user').id, body.data))
    } catch (err) {
      return domainError(c, err)
    }
  })

  /** Owner deletes their own (sole-member) team. */
  app.delete('/api/teams/:id', authenticate, teamId, async (c) => {
    try {
      await authed!.teams.deleteTeam(c.req.param('id'), c.get('user').id)
      return c.json({ deleted: true })
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.put('/api/teams/:id/contacts', authenticate, teamId, async (c) => {
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

  app.post('/api/teams/:id/leave', authenticate, teamId, async (c) => {
    try {
      await authed!.teams.leaveTeam(c.req.param('id'), c.get('user').id)
      return c.json({ left: true })
    } catch (err) {
      return domainError(c, err)
    }
  })

  // ---- applications ----

  app.post(
    '/api/teams/:id/applications',
    authenticate,
    teamId,
    limited(applyLimiter),
    captchaGuard('apply_team'),
    async (c) => {
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
    },
  )

  app.post('/api/teams/:id/invitations', authenticate, teamId, limited(inviteLimiter), async (c) => {
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

  app.get('/api/teams/:id/applications', authenticate, teamId, async (c) => {
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

  const applicationId = uuidParam('id', 'application_not_found')

  app.post('/api/applications/:id/respond', authenticate, applicationId, async (c) => {
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

  app.post('/api/applications/:id/withdraw', authenticate, applicationId, async (c) => {
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

  const threadId = uuidParam('id', 'thread_not_found')

  app.get('/api/threads/:id', authenticate, threadId, async (c) => {
    try {
      return c.json(await authed!.messaging.getThread(c.req.param('id'), c.get('user').id))
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.get('/api/threads/:id/messages', authenticate, threadId, async (c) => {
    try {
      return c.json({
        messages: await authed!.messaging.listMessages(c.req.param('id'), c.get('user').id),
      })
    } catch (err) {
      return domainError(c, err)
    }
  })

  app.post('/api/threads/:id/messages', authenticate, threadId, limited(messageLimiter), async (c) => {
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
  app.post(
    '/api/messages/:id/report',
    authenticate,
    uuidParam('id', 'message_not_found'),
    limited(reportLimiter),
    async (c) => {
      const body = await parseBody(c, ReportMessageSchema)
      if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
      try {
        await authed!.messaging.report(c.req.param('id'), c.get('user').id, body.data.reason)
        return c.json({ reported: true }, 201)
      } catch (err) {
        return domainError(c, err)
      }
    },
  )

  /** Report a team's public content → escalation re-review. */
  app.post('/api/teams/:id/report', authenticate, teamId, limited(reportLimiter), async (c) => {
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
    uuidParam('userId', 'participant_not_found'),
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

  /**
   * Report log (ADR-034): message + team + participant reports merged
   * newest-first, metadata only — no reported text, no email. Nothing
   * is decrypted, so (like the risk overview) the read is not audited.
   */
  app.get('/api/admin/reports', async (c) => {
    const parsed = AdminReportsQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: 'validation_failed', issues: parsed.error.issues }, 400)
    }
    return c.json({ items: await authed!.admin.listReports(parsed.data) })
  })

  /**
   * Full decrypted thread for review — risk-relevant threads only, and
   * the read is audit-logged before any content is returned.
   */
  app.get('/api/admin/threads/:id', threadId, async (c) => {
    try {
      return c.json(await authed!.admin.getThreadForReview(c.req.param('id'), c.get('user').id))
    } catch (err) {
      return domainError(c, err)
    }
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
  app.delete('/api/admin/teams/:id', teamId, async (c) => {
    const done = await authed!.admin.deleteTeam(c.req.param('id'), c.get('user').id)
    if (!done) return c.json({ error: 'team_not_found' }, 404)
    return c.json({ deleted: true })
  })

  const adminUserId = uuidParam('id', 'user_not_found')

  /** Manual suspension; strike-exempt (admin) accounts are refused. */
  app.post('/api/admin/users/:id/suspend', adminUserId, async (c) => {
    const result = await authed!.moderation.suspend(c.req.param('id'), c.get('user').id)
    if (result === 'exempt') return c.json({ error: 'cannot_suspend_admin' }, 403)
    if (result === 'not_active') return c.json({ error: 'not_active' }, 409)
    return c.json({ suspended: true })
  })

  /** Lift a suspension (also resets the current strike window). */
  app.post('/api/admin/users/:id/reactivate', adminUserId, async (c) => {
    const done = await authed!.moderation.reactivate(c.req.param('id'), c.get('user').id)
    if (!done) return c.json({ error: 'not_suspended' }, 409)
    return c.json({ reactivated: true })
  })

  /** One user's moderation history (strike view, no content). */
  app.get('/api/admin/users/:id/moderation', adminUserId, async (c) => {
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

  // ---- admin event management (ADR-035, docs/design/admin-events.md §8) ----

  /** Wired only with a database; the seed-file mode has nothing to write to. */
  const requireEventAdmin = createMiddleware<AppEnv>(async (c, next) => {
    if (!authed?.eventAdmin) {
      return c.json({ error: 'unavailable', message: '此環境未連接資料庫，無法管理活動' }, 503)
    }
    await next()
  })
  const eventAdmin = () => authed!.eventAdmin!

  /** A malformed slug is simply "no such event", never a query. */
  const eventSlugParam = createMiddleware<AppEnv>(async (c, next) => {
    if (!EVENT_SLUG_PATTERN.test(c.req.param('slug') ?? '')) {
      return c.json({ error: ADMIN_EVENT_ERRORS.eventNotFound }, 404)
    }
    await next()
  })

  /** `{ error, ...extra }` — extra carries `current` / `key,count` / `from,to` / `details`. */
  const eventAdminError = (c: Context<AppEnv>, err: unknown) => {
    if (err instanceof EventAdminError) {
      return c.json({ error: err.code, ...err.extra }, EVENT_ADMIN_ERROR_STATUS[err.code])
    }
    throw err
  }

  app.use('/api/admin/events', requireEventAdmin)
  app.use('/api/admin/events/*', requireEventAdmin)

  app.get('/api/admin/events', async (c) => {
    return c.json({ items: await eventAdmin().list() })
  })

  // Registered before `:slug` so the literal path wins.
  app.get('/api/admin/events/templates', (c) => {
    return c.json({ templates: eventAdmin().templates() })
  })

  app.post('/api/admin/events', async (c) => {
    const body = await parseBody(c, CreateEventInputSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json({ seed: await eventAdmin().create(body.data, c.get('user').id) }, 201)
    } catch (err) {
      return eventAdminError(c, err)
    }
  })

  app.get('/api/admin/events/:slug', eventSlugParam, async (c) => {
    try {
      return c.json(await eventAdmin().get(c.req.param('slug')))
    } catch (err) {
      return eventAdminError(c, err)
    }
  })

  app.put('/api/admin/events/:slug', eventSlugParam, async (c) => {
    const body = await parseBody(c, UpdateEventInputSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(await eventAdmin().update(c.req.param('slug'), body.data, c.get('user').id))
    } catch (err) {
      return eventAdminError(c, err)
    }
  })

  app.post('/api/admin/events/:slug/status', eventSlugParam, async (c) => {
    const body = await parseBody(c, AdminEventStatusInputSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json({
        seed: await eventAdmin().setStatus(
          c.req.param('slug'),
          body.data.status,
          c.get('user').id,
        ),
      })
    } catch (err) {
      return eventAdminError(c, err)
    }
  })

  app.post('/api/admin/events/:slug/duplicate', eventSlugParam, async (c) => {
    const body = await parseBody(c, DuplicateEventInputSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    try {
      return c.json(
        { seed: await eventAdmin().duplicate(c.req.param('slug'), body.data, c.get('user').id) },
        201,
      )
    } catch (err) {
      return eventAdminError(c, err)
    }
  })

  /** Seed-file-compatible JSON download (`pnpm seed` accepts it as-is). */
  app.get('/api/admin/events/:slug/export', eventSlugParam, async (c) => {
    const slug = c.req.param('slug')
    try {
      const seed = await eventAdmin().exportSeed(slug)
      c.header('content-disposition', `attachment; filename="${slug}.json"`)
      return c.json(seed)
    } catch (err) {
      return eventAdminError(c, err)
    }
  })

  app.delete('/api/admin/events/:slug', eventSlugParam, async (c) => {
    try {
      await eventAdmin().delete(c.req.param('slug'), c.get('user').id)
      return c.body(null, 204)
    } catch (err) {
      return eventAdminError(c, err)
    }
  })

  // ---- internal callbacks (Cloud Tasks worker, Cloud Scheduler cleanup) ----

  /** Shared-secret gate; constant-time comparison, absent config → route does not exist. */
  const requireTaskSecret = createMiddleware<AppEnv>(async (c, next) => {
    if (!authed || !deps.taskSecret) return c.json({ error: 'not_found' }, 404)
    if (!secretEquals(c.req.header('x-task-secret'), deps.taskSecret)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })

  app.post('/internal/moderation/tasks', requireTaskSecret, async (c) => {
    const body = await parseBody(c, ModerationTaskSchema)
    if (!body.ok) return c.json({ error: 'validation_failed', issues: body.issues }, 400)
    const visibility = await authed!.moderation.processAsync(body.data.target)
    return c.json({ processed: true, visibility })
  })

  app.post('/internal/cleanup', requireTaskSecret, async (c) => {
    return c.json(await authed!.cleanup.run())
  })

  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((err, c) => {
    // Never leak internals to clients; logs get the error class and
    // message with the request coordinates — never the whole object
    // (a database error object can carry SQL parameters, i.e. user data).
    console.error(
      JSON.stringify({
        level: 'error',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        error: err.name,
        message: err.message,
      }),
    )
    return c.json({ error: 'internal_error' }, 500)
  })

  return app
}
