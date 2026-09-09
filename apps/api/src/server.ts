import { serve } from '@hono/node-server'
import { loadLocalEnv } from './env.js'

loadLocalEnv()
import { AdminService } from './admin/service.js'
import { createApp, rateLimitsFromEnv, type AppDeps } from './app.js'
import { DbApplicationRepository } from './applications/db-repository.js'
import { ApplicationService } from './applications/service.js'
import { AuditLogger, DbAuditLogRepository } from './audit/log.js'
import { DevTokenVerifier, FirebaseTokenVerifier, type TokenVerifier } from './auth/verifier.js'
import { emailLookupHmac, normalizeEmail } from './crypto/email.js'
import { FieldCipher } from './crypto/envelope.js'
import { buildKekFromEnv, googleTokenProvider, requireEnv } from './crypto/kek-from-env.js'
import { RecaptchaEnterpriseVerifier, type CaptchaVerifier } from './security/captcha.js'
import { createDb, DEFAULT_POOL_MAX, type Db } from './db/client.js'
import { DbEventAdminRepository } from './events/admin-db-repository.js'
import { EventAdminService } from './events/admin-service.js'
import { DbEventRepository } from './events/db-repository.js'
import { loadEventSeedFiles } from './events/seed-loader.js'
import { SeedEventRepository } from './events/seed-repository.js'
import { DbMessageRepository, DbThreadRepository } from './messaging/db-repository.js'
import { MessagingService } from './messaging/service.js'
import { ClaudeModerator, ESCALATION_PROMPT_VERSION } from './moderation/claude.js'
import { CloudTasksModerationQueue } from './moderation/cloud-tasks.js'
import { GeminiModerator, PROMPT_VERSION } from './moderation/gemini.js'
import { MockModerator, type Moderator } from './moderation/moderator.js'
import { DbModerationRecordRepository } from './moderation/records.js'
import {
  InProcessModerationQueue,
  ModerationService,
  type ModerationQueue,
} from './moderation/service.js'
import { DbParticipantRepository } from './participants/db-repository.js'
import { DbReportRepository } from './reports/db-repository.js'
import { DbContentReportRepository } from './reports/content-repository.js'
import { ContentReportService } from './reports/content-service.js'
import { ParticipationService } from './participants/service.js'
import { DbTeamRepository } from './teams/db-repository.js'
import { TeamService } from './teams/service.js'
import { DbUserRepository } from './users/db-repository.js'
import { CleanupService, PrivacyService } from './users/privacy-service.js'
import { UserService } from './users/service.js'

const isProduction = process.env.NODE_ENV === 'production'

/** Positive-integer environment value with a default. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function buildCaptcha(): CaptchaVerifier | undefined {
  const siteKey = process.env.RECAPTCHA_SITE_KEY
  if (!siteKey) return undefined
  return new RecaptchaEnterpriseVerifier({
    projectId: requireEnv('GCP_PROJECT_ID'),
    siteKey,
    tokenProvider: googleTokenProvider(),
  })
}

function buildModerator(): {
  moderator: Moderator
  syncModerator?: Moderator
  escalationModerator?: Moderator
  nameModerator?: Moderator
  modelId: string
  escalationModelId?: string
} {
  const provider = process.env.MODERATION_PROVIDER ?? 'mock'
  if (provider === 'mock') {
    if (isProduction) {
      // Publishing user content without review is never acceptable in
      // production (spec §5) — refuse to start rather than run open.
      throw new Error('MODERATION_PROVIDER=mock must never run in production')
    }
    return { moderator: new MockModerator(), modelId: 'mock' }
  }
  if (provider === 'vertex') {
    // Model id is configuration, never code (ADR-005). Gemini 3.x is
    // served from the global endpoint, hence the default. Two timeout
    // profiles: the async worker gets generous headroom (model latency
    // routinely exceeds several seconds); the sync message path stays
    // snappy and falls back to the queue (spec §5.2).
    const model = requireEnv('MODERATION_MODEL')
    const projectId = requireEnv('GCP_PROJECT_ID')
    const location = process.env.MODERATION_LOCATION ?? 'global'
    // Bare template id or full resource name; the template must live in
    // the same location as the Gemini endpoint (ADR-016).
    const armor = process.env.MODEL_ARMOR_TEMPLATE
    const modelArmorTemplate = armor
      ? armor.includes('/')
        ? armor
        : `projects/${projectId}/locations/${location}/templates/${armor}`
      : undefined
    const base = {
      projectId,
      location,
      model,
      tokenProvider: googleTokenProvider(),
      ...(modelArmorTemplate ? { modelArmorTemplate } : {}),
    }
    // Escalation reviewer for user-reported content: an Anthropic
    // Claude model on Vertex Model Garden (async only, generous
    // timeout). Model id is configuration (ADR-005); unset → reports
    // fall back to the default moderator.
    const escalationModel = process.env.REPORT_MODERATION_MODEL
    return {
      moderator: new GeminiModerator({
        ...base,
        timeoutMs: Number(process.env.MODERATION_TIMEOUT_MS ?? 25000),
      }),
      syncModerator: new GeminiModerator({
        ...base,
        timeoutMs: Number(process.env.MODERATION_SYNC_TIMEOUT_MS ?? 3000),
      }),
      // Name screening is inline but not latency-critical — measured
      // p50 ~3s / max ~10s on short names, so the allowance is lenient.
      nameModerator: new GeminiModerator({
        ...base,
        timeoutMs: Number(process.env.NAME_MODERATION_TIMEOUT_MS ?? 12000),
      }),
      ...(escalationModel
        ? {
            escalationModerator: new ClaudeModerator({
              projectId,
              location,
              model: escalationModel,
              tokenProvider: googleTokenProvider(),
              timeoutMs: Number(process.env.REPORT_MODERATION_TIMEOUT_MS ?? 60000),
            }),
            escalationModelId: escalationModel,
          }
        : {}),
      modelId: model,
    }
  }
  throw new Error(`unsupported MODERATION_PROVIDER "${provider}" (supported: mock, vertex)`)
}

function buildVerifier(): TokenVerifier {
  const provider = process.env.AUTH_PROVIDER ?? 'firebase'
  if (provider === 'firebase') {
    return new FirebaseTokenVerifier(requireEnv('FIREBASE_PROJECT_ID'))
  }
  if (provider === 'dev') {
    // Constructor throws when NODE_ENV=production.
    return new DevTokenVerifier()
  }
  throw new Error(`unsupported AUTH_PROVIDER "${provider}" (supported: firebase, dev)`)
}

function buildQueue(getService: () => ModerationService): ModerationQueue {
  const mode = process.env.MODERATION_QUEUE ?? 'in-process'
  if (mode === 'in-process') {
    if (isProduction) {
      // In-process review dies with the request/instance and has no
      // retry — production must use the durable queue (same gate as the
      // mock moderator and the local KEK).
      throw new Error('MODERATION_QUEUE=in-process must never run in production — use cloud-tasks')
    }
    return new InProcessModerationQueue(getService)
  }
  if (mode === 'cloud-tasks') {
    return new CloudTasksModerationQueue({
      queuePath: requireEnv('CLOUD_TASKS_QUEUE_PATH'),
      targetUrl: requireEnv('MODERATION_TASK_TARGET_URL'),
      taskSecret: requireEnv('INTERNAL_TASK_SECRET'),
      tokenProvider: googleTokenProvider(),
    })
  }
  throw new Error(`unsupported MODERATION_QUEUE "${mode}" (supported: in-process, cloud-tasks)`)
}

function buildDeps(): { appDeps: AppDeps; db?: Db } {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.log('event repository: seed files (read-only mode, no DATABASE_URL set)')
    return { appDeps: { events: SeedEventRepository.fromDirectory() } }
  }

  console.log('event repository: PostgreSQL')
  const db = createDb(databaseUrl, { poolMax: intEnv('DB_POOL_MAX', DEFAULT_POOL_MAX) })
  const events = new DbEventRepository(db)
  const cipher = new FieldCipher(buildKekFromEnv())
  const userRepo = new DbUserRepository(db)
  const teamRepo = new DbTeamRepository(db)
  const applicationRepo = new DbApplicationRepository(db)
  const participantRepo = new DbParticipantRepository(db)
  const threadRepo = new DbThreadRepository(db)
  const messageRepo = new DbMessageRepository(db)
  const auditRepo = new DbAuditLogRepository(db)
  const audit = new AuditLogger(auditRepo)

  const reportRepo = new DbReportRepository(db)
  const contentReportRepo = new DbContentReportRepository(db)
  const recordsRepo = new DbModerationRecordRepository(db)
  const { moderator, syncModerator, escalationModerator, nameModerator, modelId, escalationModelId } =
    buildModerator()

  const pepper = requireEnv('EMAIL_HMAC_PEPPER')
  // Pepper rotation (M-9): the previous pepper keeps old lookups
  // resolvable; matches are re-hashed to the current pepper on login.
  const previousPepper = process.env.EMAIL_HMAC_PEPPER_PREVIOUS
  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => normalizeEmail(e))
      .filter((e) => e.length > 0),
  )
  // The automatic strike rule must never lock out the platform's own
  // moderators — compare via the same HMAC lookup used for login.
  const adminLookups = new Set(
    [...adminEmails].map((e) => emailLookupHmac(e, pepper).toString('hex')),
  )
  const isStrikeExempt = async (userId: string) => {
    const user = await userRepo.findById(userId)
    return !!user && adminLookups.has(user.emailLookup.toString('hex'))
  }

  const moderation = new ModerationService(
    {
      moderator,
      ...(syncModerator ? { syncModerator } : {}),
      ...(escalationModerator ? { escalationModerator } : {}),
      ...(nameModerator ? { nameModerator } : {}),
      reports: reportRepo,
      contentReports: contentReportRepo,
      isStrikeExempt,
      records: recordsRepo,
      users: userRepo,
      participants: participantRepo,
      teams: teamRepo,
      applications: applicationRepo,
      threads: threadRepo,
      messages: messageRepo,
      cipher,
      audit,
    },
    {
      modelId,
      promptVersion: PROMPT_VERSION,
      ...(escalationModelId
        ? { escalationModelId, escalationPromptVersion: ESCALATION_PROMPT_VERSION }
        : {}),
    },
  )
  const queue = buildQueue(() => moderation)

  const users = new UserService(
    userRepo,
    cipher,
    pepper,
    previousPepper ? { previousPepper } : {},
  )
  const participation = new ParticipationService(events, participantRepo, userRepo, queue)
  const teams = new TeamService(events, teamRepo, userRepo, queue, participantRepo)
  const applications = new ApplicationService(
    events,
    teamRepo,
    userRepo,
    applicationRepo,
    cipher,
    queue,
    participantRepo,
  )
  const messaging = new MessagingService(
    events,
    teamRepo,
    applicationRepo,
    userRepo,
    threadRepo,
    messageRepo,
    cipher,
    moderation,
    queue,
    reportRepo,
    audit,
  )
  const contentReports = new ContentReportService({
    teams: teamRepo,
    participants: participantRepo,
    contentReports: contentReportRepo,
    moderationQueue: queue,
    audit,
  })
  const admin = new AdminService({
    participants: participantRepo,
    teams: teamRepo,
    applications: applicationRepo,
    messages: messageRepo,
    users: userRepo,
    cipher,
    audit,
    threads: threadRepo,
    records: recordsRepo,
    reports: reportRepo,
    contentReports: contentReportRepo,
  })
  const privacy = new PrivacyService({
    events,
    users: userRepo,
    participants: participantRepo,
    teams: teamRepo,
    applications: applicationRepo,
    messages: messageRepo,
    cipher,
    audit,
    records: recordsRepo,
    reports: reportRepo,
    contentReports: contentReportRepo,
  })
  const cleanup = new CleanupService(
    {
      events,
      users: userRepo,
      participants: participantRepo,
      teams: teamRepo,
      threads: threadRepo,
      auditRepo,
      records: recordsRepo,
      applications: applicationRepo,
      messages: messageRepo,
      moderationQueue: queue,
    },
    { requeueAfterMinutes: intEnv('MODERATION_REQUEUE_AFTER_MINUTES', 15) },
  )
  // Repo seed files double as editor templates (ADR-035).
  const eventAdmin = new EventAdminService({
    events: new DbEventAdminRepository(db),
    teams: teamRepo,
    participants: participantRepo,
    audit,
    loadTemplates: () => loadEventSeedFiles(),
  })

  const appDeps: AppDeps = {
    events,
    authed: {
      verifier: buildVerifier(),
      users,
      participation,
      teams,
      applications,
      messaging,
      moderation,
      contentReports,
      admin,
      privacy,
      cleanup,
      eventAdmin,
    },
    adminEmails,
    rateLimits: rateLimitsFromEnv(),
  }
  if (process.env.INTERNAL_TASK_SECRET) appDeps.taskSecret = process.env.INTERNAL_TASK_SECRET
  const captcha = buildCaptcha()
  if (captcha) appDeps.captcha = captcha
  // Comma or semicolon separated (gcloud --set-env-vars reserves commas).
  const origins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(/[,;]/)
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
  if (origins.length > 0) appDeps.allowedOrigins = origins
  return { appDeps, db }
}

function main() {
  const { appDeps, db } = buildDeps()
  const app = createApp(appDeps)
  const port = Number(process.env.PORT ?? 8080)
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`api listening on :${info.port}`)
  })

  // Graceful shutdown (Cloud Run sends SIGTERM, then kills after 10s):
  // stop accepting, let in-flight requests finish, drain the pool.
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`${signal} received, shutting down`)
    const forceExit = setTimeout(() => {
      console.error('shutdown timed out, exiting')
      process.exit(1)
    }, 8000)
    forceExit.unref()
    server.close(() => {
      const drained = db ? db.$client.end() : Promise.resolve()
      drained
        .catch((err: unknown) => {
          console.error('pool drain failed', err instanceof Error ? err.message : err)
        })
        .finally(() => process.exit(0))
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main()
