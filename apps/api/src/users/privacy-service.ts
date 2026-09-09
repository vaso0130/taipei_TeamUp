import type { ParticipationView } from '@teamup/shared'
import type { ApplicationRepository } from '../applications/repository.js'
import type { AuditLogger, AuditLogRepository } from '../audit/log.js'
import type { FieldCipher } from '../crypto/envelope.js'
import type { EventRepository } from '../events/repository.js'
import type { MessageRepository, ThreadRepository } from '../messaging/repository.js'
import type { ModerationRecordRepository } from '../moderation/records.js'
import {
  safeEnqueue,
  targetFamily,
  targetId as moderationTargetId,
  type ModerationQueue,
  type ModerationTarget,
} from '../moderation/service.js'
import type { ParticipantRepository } from '../participants/repository.js'
import type { ContentReportRepository } from '../reports/content-repository.js'
import type { ReportRepository } from '../reports/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { UserRecord, UserRepository } from './repository.js'

export interface UserDataExport {
  exportedAt: string
  account: {
    displayName: string
    email: string
    status: UserRecord['status']
    createdVia: string
  }
  participations: ParticipationView[]
  teams: { eventSlug: string; teamId: string; teamName: string; isOwner: boolean }[]
  applications: {
    eventSlug: string
    teamId: string
    direction: string
    status: string
    /** Own notes in full; the counterpart's note only once moderation published it. */
    message: string | null
    messageVisibility: string
    createdAt: string
  }[]
  messages: { threadId: string; body: string | null; visibility: string; createdAt: string }[]
  /** Verdicts about the user's own content — no admin identity, no content. */
  moderation: {
    targetType: string
    riskLevel: string
    categories: string[]
    decidedBy: 'auto' | 'human'
    flagged: boolean
    decidedAt: string
  }[]
  /** Reports the user filed. */
  reportsFiled: {
    targetType: string
    targetId: string
    reason: string
    status: string
    createdAt: string
  }[]
}

/**
 * Data-subject rights (spec §6.5, 個資法第 3 條): one-click export and
 * one-click deletion.
 */
export class PrivacyService {
  constructor(
    private readonly deps: {
      events: EventRepository
      users: UserRepository
      participants: ParticipantRepository
      teams: TeamRepository
      applications: ApplicationRepository
      messages: MessageRepository
      cipher: FieldCipher
      audit: AuditLogger
      records?: ModerationRecordRepository
      reports?: ReportRepository
      contentReports?: ContentReportRepository
    },
  ) {}

  async exportData(user: UserRecord): Promise<UserDataExport> {
    await this.deps.audit.log('data_export', {
      actorUserId: user.id,
      targetType: 'user',
      targetId: user.id,
    })
    const events = await this.deps.events.listEvents()
    const participations: UserDataExport['participations'] = []
    const teams: UserDataExport['teams'] = []
    const applications: UserDataExport['applications'] = []

    for (const event of events) {
      const participation = await this.deps.participants.get(event.slug, user.id)
      if (participation) {
        participations.push({
          eventSlug: participation.eventSlug,
          intent: participation.intent,
          preferredRoles: participation.preferredRoles,
          skills: participation.skills,
          blurb: participation.blurb,
          customTags: participation.customTags,
          blurbVisibility: participation.blurbVisibility,
          isAdult: participation.isAdult,
          guardianConsentConfirmed: participation.guardianConsentConfirmed,
        })
      }
      for (const teamId of await this.deps.teams.activeTeamIdsOf(event.slug, user.id)) {
        const team = await this.deps.teams.getById(teamId)
        if (team) {
          teams.push({
            eventSlug: event.slug,
            teamId: team.id,
            teamName: team.name,
            isOwner: team.ownerUserId === user.id,
          })
        }
      }
      for (const a of await this.deps.applications.listForUser(event.slug, user.id)) {
        // Same visibility rule as the API view: the note's author always
        // gets their own words; the counterpart's note only once
        // moderation published it, and blocked text goes to no one.
        const team = await this.deps.teams.getById(a.teamId)
        const senderId = a.direction === 'apply' ? a.applicantId : (team?.ownerUserId ?? null)
        const readable =
          a.messageVisibility !== 'blocked' &&
          (senderId === user.id || a.messageVisibility === 'published')
        applications.push({
          eventSlug: event.slug,
          teamId: a.teamId,
          direction: a.direction,
          status: a.status,
          message:
            readable && a.messageCiphertext
              ? await this.deps.cipher.decrypt(a.messageCiphertext)
              : null,
          messageVisibility: a.messageVisibility,
          createdAt: a.createdAt,
        })
      }
    }

    const messages: UserDataExport['messages'] = []
    for (const m of await this.deps.messages.listBySender(user.id)) {
      messages.push({
        threadId: m.threadId,
        body: m.visibility === 'blocked' ? null : await this.deps.cipher.decrypt(m.bodyCiphertext),
        visibility: m.visibility,
        createdAt: m.createdAt,
      })
    }

    // Verdicts about the person: decision metadata only — the reviewing
    // admin's identity is internal, and content is never stored anyway.
    const moderation: UserDataExport['moderation'] = (
      (await this.deps.records?.listBySubject(user.id, 1000)) ?? []
    ).map((r) => ({
      targetType: r.targetType,
      riskLevel: r.riskLevel,
      categories: [...r.categories],
      decidedBy: r.decidedBy.startsWith('human:') ? 'human' : 'auto',
      flagged: r.flagged,
      decidedAt: r.createdAt,
    }))

    const reportsFiled: UserDataExport['reportsFiled'] = [
      ...((await this.deps.reports?.listByReporter(user.id)) ?? []).map((r) => ({
        targetType: 'message',
        targetId: r.messageId,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      })),
      ...((await this.deps.contentReports?.listByReporter(user.id)) ?? []).map((r) => ({
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt,
      })),
    ]

    return {
      exportedAt: new Date().toISOString(),
      account: {
        displayName: user.displayName,
        email: await this.deps.cipher.decrypt(user.emailCiphertext),
        status: user.status,
        createdVia: 'email-login',
      },
      participations,
      teams,
      applications,
      messages,
      moderation,
      reportsFiled,
    }
  }

  /**
   * Account deletion (spec §6.4): leave every team (transferring
   * ownership to the earliest-joined remaining member, or deleting a
   * team the person was the only member of — a closed team would keep
   * pointing at the deleted account and block its hard deletion),
   * withdraw pending applications, purge per-event profiles, then
   * soft-delete; hard deletion follows 30 days later via the cleanup job.
   */
  async deleteAccount(user: UserRecord): Promise<void> {
    const events = await this.deps.events.listEvents()
    for (const event of events) {
      for (const teamId of await this.deps.teams.activeTeamIdsOf(event.slug, user.id)) {
        const team = await this.deps.teams.getById(teamId)
        if (!team) continue
        if (team.ownerUserId === user.id) {
          const successor = (await this.deps.teams.listMembers(teamId)).find(
            (m) => m.userId !== user.id,
          )
          if (!successor) {
            // Sole member: the team goes with the account (memberships,
            // contacts and applications cascade).
            await this.deps.teams.delete(teamId)
            continue
          }
          await this.deps.teams.transferOwnership(teamId, successor.userId)
        }
        await this.deps.teams.removeMember(teamId, user.id)
      }
      for (const a of await this.deps.applications.listForUser(event.slug, user.id)) {
        if (a.status === 'pending') {
          await this.deps.applications.updateStatus(a.id, 'withdrawn')
        }
      }
    }
    await this.deps.participants.deleteForUser(user.id)
    await this.deps.users.updateDisplayName(user.id, '（已刪除的帳號）')
    await this.deps.users.updateStatus(user.id, 'deleted')
    await this.deps.audit.log('account_delete', {
      actorUserId: user.id,
      targetType: 'user',
      targetId: user.id,
    })
  }
}

export interface CleanupSummary {
  purgedEvents: string[]
  hardDeletedUsers: number
  /** Soft-deleted accounts past the grace period that still could not be removed. */
  hardDeleteFailures: number
  purgedAuditLogs: number
  purgedModerationRecords: number
  /** Stale pending content pushed back into the moderation queue. */
  requeuedForReview: number
}

export interface CleanupOptions {
  /** Days between soft and hard deletion of an account (spec §6.4). */
  softDeleteGraceDays?: number
  /** Retention of audit_logs (spec §4). */
  auditRetentionDays?: number
  /** Retention of moderation_records (privacy policy: de-identified, 180 days). */
  moderationRetentionDays?: number
  /**
   * Content still pending_review after this long with no verdict on file
   * is assumed to have lost its queue task and is re-queued
   * (MODERATION_REQUEUE_AFTER_MINUTES).
   */
  requeueAfterMinutes?: number
}

/**
 * Scheduled cleanup (spec §6.4, Cloud Scheduler): purge event data
 * after events.retention_days, hard-delete accounts after the grace
 * period, expire audit and moderation records, and repair the review
 * pipeline by re-queueing content whose task never arrived.
 */
export class CleanupService {
  private readonly opts: Required<CleanupOptions>

  constructor(
    private readonly deps: {
      events: EventRepository
      users: UserRepository
      participants: ParticipantRepository
      teams: TeamRepository
      threads: ThreadRepository
      auditRepo: AuditLogRepository
      records?: ModerationRecordRepository
      applications?: ApplicationRepository
      messages?: MessageRepository
      moderationQueue?: ModerationQueue
    },
    options: CleanupOptions = {},
  ) {
    this.opts = {
      softDeleteGraceDays: options.softDeleteGraceDays ?? 30,
      auditRetentionDays: options.auditRetentionDays ?? 180,
      moderationRetentionDays: options.moderationRetentionDays ?? 180,
      requeueAfterMinutes: options.requeueAfterMinutes ?? 15,
    }
  }

  async run(now = new Date()): Promise<CleanupSummary> {
    const purgedEvents: string[] = []
    for (const event of await this.deps.events.listEvents()) {
      const detail = await this.deps.events.getEventBySlug(event.slug)
      if (!detail) continue
      const purgeAfter =
        new Date(detail.event.endsAt).getTime() +
        detail.event.retentionDays * 24 * 60 * 60 * 1000
      if (now.getTime() >= purgeAfter) {
        await this.deps.teams.deleteByEvent(event.slug)
        await this.deps.threads.deleteByEvent(event.slug)
        await this.deps.participants.deleteByEvent(event.slug)
        purgedEvents.push(event.slug)
      }
    }

    const cutoff = new Date(now.getTime() - this.opts.softDeleteGraceDays * 24 * 60 * 60 * 1000)
    const hardDeleted = await this.deps.users.hardDeleteBefore(cutoff)
    if (hardDeleted.failed > 0) {
      console.error(`cleanup: ${hardDeleted.failed} account(s) past the grace period could not be hard-deleted`)
    }

    // Audit logs are themselves retained only 180 days (spec §4).
    const auditCutoff = new Date(now.getTime() - this.opts.auditRetentionDays * 24 * 60 * 60 * 1000)
    const purgedAuditLogs = await this.deps.auditRepo.purgeBefore(auditCutoff)

    // Moderation verdicts: the strike window is days, the policy promise
    // is 180 days — after that only the content hash and the decision
    // would remain, and neither is needed.
    const moderationCutoff = new Date(
      now.getTime() - this.opts.moderationRetentionDays * 24 * 60 * 60 * 1000,
    )
    const purgedModerationRecords = (await this.deps.records?.purgeBefore(moderationCutoff)) ?? 0

    const requeuedForReview = await this.requeueStalePending(now)

    return {
      purgedEvents,
      hardDeletedUsers: hardDeleted.deleted,
      hardDeleteFailures: hardDeleted.failed,
      purgedAuditLogs,
      purgedModerationRecords,
      requeuedForReview,
    }
  }

  /**
   * Pipeline repair: content stored as pending_review whose enqueue
   * failed (Cloud Tasks outage) has no moderation_record at all. Anything
   * in that state for longer than the in-flight allowance is re-queued.
   * Content WITH a record (medium → human queue, fail-closed) is left to
   * the human reviewers.
   */
  private async requeueStalePending(now: Date): Promise<number> {
    const { records, moderationQueue } = this.deps
    if (!records || !moderationQueue) return 0
    const staleBefore = now.getTime() - this.opts.requeueAfterMinutes * 60 * 1000
    const isStale = (at: string | undefined) => at === undefined || new Date(at).getTime() <= staleBefore

    const candidates: { target: ModerationTarget; at: string | undefined }[] = []
    for (const p of await this.deps.participants.listPendingBlurbs()) {
      candidates.push({
        target: { type: 'participant_blurb', eventSlug: p.eventSlug, userId: p.userId },
        at: p.updatedAt,
      })
    }
    for (const t of await this.deps.teams.listPendingPitches()) {
      candidates.push({ target: { type: 'team_pitch', teamId: t.id }, at: t.updatedAt ?? t.createdAt })
    }
    for (const a of (await this.deps.applications?.listPendingMessages()) ?? []) {
      candidates.push({ target: { type: 'application_message', applicationId: a.id }, at: a.createdAt })
    }
    for (const m of (await this.deps.messages?.listPending()) ?? []) {
      candidates.push({ target: { type: 'message', messageId: m.id }, at: m.createdAt })
    }

    let requeued = 0
    for (const { target, at } of candidates) {
      if (!isStale(at)) continue
      const latest = await records.latestFor(targetFamily(target), moderationTargetId(target))
      if (latest) continue
      if (await safeEnqueue(moderationQueue, target)) requeued++
    }
    return requeued
  }
}
