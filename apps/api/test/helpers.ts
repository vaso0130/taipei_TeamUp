import { randomBytes } from 'node:crypto'
import type { EventSeed } from '@teamup/shared'
import { AdminService } from '../src/admin/service.js'
import { createApp } from '../src/app.js'
import { MemoryApplicationRepository } from '../src/applications/memory-repository.js'
import { ApplicationService } from '../src/applications/service.js'
import { AuditLogger, MemoryAuditLogRepository } from '../src/audit/log.js'
import { DevTokenVerifier } from '../src/auth/verifier.js'
import { emailLookupHmac, normalizeEmail } from '../src/crypto/email.js'
import { FieldCipher } from '../src/crypto/envelope.js'
import { LocalKek } from '../src/crypto/kek.js'
import { SeedEventRepository } from '../src/events/seed-repository.js'
import {
  MemoryMessageRepository,
  MemoryThreadRepository,
} from '../src/messaging/memory-repository.js'
import { MessagingService } from '../src/messaging/service.js'
import { MockModerator, type Moderator } from '../src/moderation/moderator.js'
import { MemoryModerationRecordRepository } from '../src/moderation/records.js'
import { InProcessModerationQueue, ModerationService } from '../src/moderation/service.js'
import { MemoryParticipantRepository } from '../src/participants/memory-repository.js'
import { MemoryReportRepository } from '../src/reports/repository.js'
import { MemoryContentReportRepository } from '../src/reports/content-repository.js'
import { ContentReportService } from '../src/reports/content-service.js'
import { ParticipationService } from '../src/participants/service.js'
import { MemoryTeamRepository } from '../src/teams/memory-repository.js'
import { TeamService } from '../src/teams/service.js'
import { MemoryUserRepository } from '../src/users/memory-repository.js'
import { CleanupService, PrivacyService } from '../src/users/privacy-service.js'
import { UserService } from '../src/users/service.js'

export const TEST_PEPPER = 'test-pepper-that-is-long-enough-0123456789'

/** Full app wired to in-memory repositories and the dev token verifier. */
export function buildTestApp(
  seeds: EventSeed[],
  opts: {
    moderator?: Moderator
    syncModerator?: Moderator
    escalationModerator?: Moderator
    /** Name screening moderator; defaults to Mock (low) so content-moderation tests keep their team fixtures. */
    nameModerator?: Moderator
    adminEmails?: string[]
    taskSecret?: string
    hopFetcher?: import('../src/tools/url-expander.js').HopFetcher
    captcha?: import('../src/security/captcha.js').CaptchaVerifier
  } = {},
) {
  const eventsRepo = new SeedEventRepository(seeds)
  const userRepo = new MemoryUserRepository()
  const teamRepo = new MemoryTeamRepository()
  const applicationRepo = new MemoryApplicationRepository(teamRepo)
  const participantRepo = new MemoryParticipantRepository()
  const threadRepo = new MemoryThreadRepository()
  const messageRepo = new MemoryMessageRepository()
  const moderationRecords = new MemoryModerationRecordRepository()
  const reportRepo = new MemoryReportRepository()
  const contentReportRepo = new MemoryContentReportRepository()
  const auditRepo = new MemoryAuditLogRepository()
  const audit = new AuditLogger(auditRepo)
  const cipher = new FieldCipher(new LocalKek(randomBytes(32).toString('base64')))

  const moderation = new ModerationService(
    {
      moderator: opts.moderator ?? new MockModerator(),
      ...(opts.syncModerator ? { syncModerator: opts.syncModerator } : {}),
      ...(opts.escalationModerator ? { escalationModerator: opts.escalationModerator } : {}),
      nameModerator: opts.nameModerator ?? new MockModerator(),
      reports: reportRepo,
      contentReports: contentReportRepo,
      // Mirror production wiring: admin accounts are strike-exempt.
      isStrikeExempt: async (userId: string) => {
        const user = await userRepo.findById(userId)
        return (
          !!user &&
          (opts.adminEmails ?? []).some((e) =>
            emailLookupHmac(e, TEST_PEPPER).equals(user.emailLookup),
          )
        )
      },
      records: moderationRecords,
      users: userRepo,
      participants: participantRepo,
      teams: teamRepo,
      applications: applicationRepo,
      threads: threadRepo,
      messages: messageRepo,
      cipher,
      audit,
    },
    { backoffMs: 0, modelId: 'test' },
  )
  const queue = new InProcessModerationQueue(() => moderation)

  const app = createApp({
    events: eventsRepo,
    authed: {
      verifier: new DevTokenVerifier('test'),
      users: new UserService(userRepo, cipher, TEST_PEPPER),
      participation: new ParticipationService(eventsRepo, participantRepo, userRepo, queue),
      teams: new TeamService(eventsRepo, teamRepo, userRepo, queue),
      applications: new ApplicationService(
        eventsRepo,
        teamRepo,
        userRepo,
        applicationRepo,
        cipher,
        queue,
      ),
      messaging: new MessagingService(
        eventsRepo,
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
      ),
      moderation,
      contentReports: new ContentReportService({
        teams: teamRepo,
        participants: participantRepo,
        contentReports: contentReportRepo,
        moderationQueue: queue,
        audit,
      }),
      admin: new AdminService({
        participants: participantRepo,
        teams: teamRepo,
        applications: applicationRepo,
        messages: messageRepo,
        users: userRepo,
        cipher,
        audit,
        threads: threadRepo,
        records: moderationRecords,
        reports: reportRepo,
      }),
      privacy: new PrivacyService({
        events: eventsRepo,
        users: userRepo,
        participants: participantRepo,
        teams: teamRepo,
        applications: applicationRepo,
        messages: messageRepo,
        cipher,
        audit,
      }),
      cleanup: new CleanupService({
        events: eventsRepo,
        users: userRepo,
        participants: participantRepo,
        teams: teamRepo,
        threads: threadRepo,
        auditRepo,
      }),
    },
    ...(opts.adminEmails
      ? { adminEmails: new Set(opts.adminEmails.map((e) => normalizeEmail(e))) }
      : {}),
    ...(opts.taskSecret ? { taskSecret: opts.taskSecret } : {}),
    ...(opts.captcha ? { captcha: opts.captcha } : {}),
    ...(opts.hopFetcher ? { hopFetcher: opts.hopFetcher } : {}),
  })
  return {
    app,
    eventsRepo,
    userRepo,
    teamRepo,
    applicationRepo,
    participantRepo,
    threadRepo,
    messageRepo,
    moderationRecords,
    reportRepo,
    contentReportRepo,
    moderation,
    auditRepo,
  }
}

export const authHeader = (email: string) => ({ authorization: `Bearer dev:${email}` })
export const jsonHeaders = (email: string) => ({
  ...authHeader(email),
  'content-type': 'application/json',
})

/** Clone a seed with overrides, keeping tests free of hardcoded rules. */
export function seedVariant(
  base: EventSeed,
  overrides: Partial<EventSeed['event']>,
): EventSeed {
  return { ...base, event: { ...base.event, ...overrides } }
}

/** Push recruit deadline far into the future so tests stay time-stable. */
export const openRecruitWindow = (seed: EventSeed): EventSeed =>
  seedVariant(seed, {
    status: 'open',
    recruitClosesAt: '2099-12-31T23:59:59+08:00',
    startsAt: '2100-01-01T09:00:00+08:00',
    endsAt: '2100-01-02T18:00:00+08:00',
  })
