import type { ParticipationView } from '@teamup/shared'
import type { ApplicationRepository } from '../applications/repository.js'
import type { AuditLogger } from '../audit/log.js'
import type { FieldCipher } from '../crypto/envelope.js'
import type { EventRepository } from '../events/repository.js'
import type { MessageRepository } from '../messaging/repository.js'
import type { ParticipantRepository } from '../participants/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { UserRecord, UserRepository } from './repository.js'

export interface UserDataExport {
  exportedAt: string
  account: {
    displayName: string
    email: string
    createdVia: string
  }
  participations: ParticipationView[]
  teams: { eventSlug: string; teamId: string; teamName: string; isOwner: boolean }[]
  applications: {
    eventSlug: string
    teamId: string
    direction: string
    status: string
    message: string | null
    createdAt: string
  }[]
  messages: { threadId: string; body: string; visibility: string; createdAt: string }[]
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
        applications.push({
          eventSlug: event.slug,
          teamId: a.teamId,
          direction: a.direction,
          status: a.status,
          message: a.messageCiphertext ? await this.deps.cipher.decrypt(a.messageCiphertext) : null,
          createdAt: a.createdAt,
        })
      }
    }

    const messages: UserDataExport['messages'] = []
    for (const m of await this.deps.messages.listBySender(user.id)) {
      messages.push({
        threadId: m.threadId,
        body: await this.deps.cipher.decrypt(m.bodyCiphertext),
        visibility: m.visibility,
        createdAt: m.createdAt,
      })
    }

    return {
      exportedAt: new Date().toISOString(),
      account: {
        displayName: user.displayName,
        email: await this.deps.cipher.decrypt(user.emailCiphertext),
        createdVia: 'email-login',
      },
      participations,
      teams,
      applications,
      messages,
    }
  }

  /**
   * Account deletion (spec §6.4): leave every team (transferring
   * ownership to the earliest-joined remaining member, or closing an
   * emptied team), withdraw pending applications, purge per-event
   * profiles, then soft-delete; hard deletion follows 30 days later
   * via the cleanup job.
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
          if (successor) {
            await this.deps.teams.transferOwnership(teamId, successor.userId)
          } else {
            await this.deps.teams.update(teamId, { status: 'closed' })
          }
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
}

/**
 * Scheduled cleanup (spec §6.4, Cloud Scheduler): purge event data
 * after events.retention_days, hard-delete accounts 30 days after
 * soft deletion.
 */
export class CleanupService {
  constructor(
    private readonly deps: {
      events: EventRepository
      users: UserRepository
      participants: ParticipantRepository
      teams: TeamRepository
      threads: import('../messaging/repository.js').ThreadRepository
      auditRepo: import('../audit/log.js').AuditLogRepository
    },
    private readonly softDeleteGraceDays = 30,
    private readonly auditRetentionDays = 180,
  ) {}

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

    const cutoff = new Date(now.getTime() - this.softDeleteGraceDays * 24 * 60 * 60 * 1000)
    const hardDeletedUsers = await this.deps.users.hardDeleteBefore(cutoff)

    // Audit logs are themselves retained only 180 days (spec §4).
    const auditCutoff = new Date(now.getTime() - this.auditRetentionDays * 24 * 60 * 60 * 1000)
    await this.deps.auditRepo.purgeBefore(auditCutoff)
    return { purgedEvents, hardDeletedUsers }
  }
}
