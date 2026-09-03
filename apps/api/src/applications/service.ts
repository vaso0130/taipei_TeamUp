import { uuidv7 } from 'uuidv7'
import type { ApplicationView } from '@teamup/shared'
import type { FieldCipher } from '../crypto/envelope.js'
import type { EventRepository } from '../events/repository.js'
import type { ModerationQueue } from '../moderation/service.js'
import { joinOptions, recruitWindowOpen } from '../teams/service.js'
import type { TeamRepository } from '../teams/repository.js'
import type { UserRepository } from '../users/repository.js'
import {
  DuplicatePendingError,
  type ApplicationRecord,
  type ApplicationRepository,
} from './repository.js'

export type ApplicationErrorCode =
  | 'team_not_found'
  | 'event_not_found'
  | 'not_recruiting'
  | 'recruiting_closed'
  | 'already_in_team'
  | 'already_in_this_team'
  | 'duplicate_application'
  | 'application_not_found'
  | 'not_pending'
  | 'forbidden'
  | 'team_full'
  | 'user_not_found'

export class ApplicationError extends Error {
  constructor(public readonly code: ApplicationErrorCode) {
    super(code)
    this.name = 'ApplicationError'
  }
}

export class ApplicationService {
  constructor(
    private readonly events: EventRepository,
    private readonly teams: TeamRepository,
    private readonly users: UserRepository,
    private readonly apps: ApplicationRepository,
    private readonly cipher: FieldCipher,
    private readonly moderationQueue: ModerationQueue,
  ) {}

  private async moderateIfNeeded(record: ApplicationRecord): Promise<ApplicationRecord> {
    if (record.messageCiphertext && record.messageVisibility === 'pending_review') {
      await this.moderationQueue.enqueue({ type: 'application_message', applicationId: record.id })
      return (await this.apps.getById(record.id)) ?? record
    }
    return record
  }

  private async requireTeamAndEvent(teamId: string) {
    const team = await this.teams.getById(teamId)
    if (!team) throw new ApplicationError('team_not_found')
    const detail = await this.events.getEventBySlug(team.eventSlug)
    if (!detail) throw new ApplicationError('event_not_found')
    return { team, event: detail.event }
  }

  private async guardJoinable(teamId: string, joinerUserId: string) {
    const { team, event } = await this.requireTeamAndEvent(teamId)
    if (team.status !== 'recruiting') throw new ApplicationError('not_recruiting')
    if (!recruitWindowOpen(event)) throw new ApplicationError('recruiting_closed')
    if (await this.teams.isActiveMember(teamId, joinerUserId)) {
      throw new ApplicationError('already_in_this_team')
    }
    if (event.exclusiveMembership) {
      const current = await this.teams.activeTeamOf(team.eventSlug, joinerUserId)
      if (current) throw new ApplicationError('already_in_team')
    }
    return { team, event }
  }

  private async buildRecord(
    teamId: string,
    applicantId: string,
    direction: 'apply' | 'invite',
    message: string,
  ): Promise<ApplicationRecord> {
    const trimmed = message.trim()
    return {
      id: uuidv7(),
      teamId,
      applicantId,
      direction,
      messageCiphertext: trimmed === '' ? null : await this.cipher.encrypt(trimmed),
      // Empty message: nothing to moderate. Text goes through review (M5).
      messageVisibility: trimmed === '' ? 'published' : 'pending_review',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
  }

  /** A participant applies to join a team. */
  async apply(teamId: string, applicantId: string, message: string): Promise<ApplicationView> {
    await this.guardJoinable(teamId, applicantId)
    let record = await this.buildRecord(teamId, applicantId, 'apply', message)
    try {
      await this.apps.create(record)
    } catch (err) {
      if (err instanceof DuplicatePendingError) throw new ApplicationError('duplicate_application')
      throw err
    }
    record = await this.moderateIfNeeded(record)
    return this.toView(record, applicantId)
  }

  /** The team owner invites a user (found via the participants list). */
  async invite(
    teamId: string,
    byUserId: string,
    inviteeId: string,
    message: string,
  ): Promise<ApplicationView> {
    const { team } = await this.requireTeamAndEvent(teamId)
    if (team.ownerUserId !== byUserId) throw new ApplicationError('forbidden')
    const invitee = await this.users.findById(inviteeId)
    if (!invitee || invitee.status !== 'active') throw new ApplicationError('user_not_found')
    await this.guardJoinable(teamId, inviteeId)
    let record = await this.buildRecord(teamId, inviteeId, 'invite', message)
    try {
      await this.apps.create(record)
    } catch (err) {
      if (err instanceof DuplicatePendingError) throw new ApplicationError('duplicate_application')
      throw err
    }
    record = await this.moderateIfNeeded(record)
    return this.toView(record, byUserId)
  }

  /**
   * Accept/reject. Applies: the team owner decides. Invites: the
   * invitee decides. Acceptance performs the atomic join — capacity and
   * exclusivity are re-checked inside the repository transaction, so a
   * stale accept can never overfill a team.
   */
  async respond(
    applicationId: string,
    byUserId: string,
    action: 'accept' | 'reject',
  ): Promise<ApplicationView> {
    const record = await this.apps.getById(applicationId)
    if (!record) throw new ApplicationError('application_not_found')
    if (record.status !== 'pending') throw new ApplicationError('not_pending')
    const { team, event } = await this.requireTeamAndEvent(record.teamId)

    const decider = record.direction === 'apply' ? team.ownerUserId : record.applicantId
    if (byUserId !== decider) throw new ApplicationError('forbidden')

    if (action === 'reject') {
      await this.apps.updateStatus(record.id, 'rejected')
      return this.toView({ ...record, status: 'rejected' }, byUserId)
    }

    if (!recruitWindowOpen(event)) throw new ApplicationError('recruiting_closed')
    const joined = await this.teams.addMember(record.teamId, record.applicantId, joinOptions(event))
    if (!joined.ok) {
      switch (joined.reason) {
        case 'team_full':
          throw new ApplicationError('team_full')
        case 'already_in_this_team':
          // Already a member somehow — the application is moot.
          await this.apps.updateStatus(record.id, 'withdrawn')
          throw new ApplicationError('not_pending')
        case 'already_in_another_team':
          throw new ApplicationError('already_in_team')
        default:
          throw new ApplicationError('team_not_found')
      }
    }
    await this.apps.updateStatus(record.id, 'accepted')
    if (event.exclusiveMembership) {
      await this.apps.withdrawPendingForUser(team.eventSlug, record.applicantId, record.teamId)
    }
    return this.toView({ ...record, status: 'accepted' }, byUserId)
  }

  /** Applies: applicant withdraws. Invites: the inviting owner cancels. */
  async withdraw(applicationId: string, byUserId: string): Promise<void> {
    const record = await this.apps.getById(applicationId)
    if (!record) throw new ApplicationError('application_not_found')
    if (record.status !== 'pending') throw new ApplicationError('not_pending')
    const { team } = await this.requireTeamAndEvent(record.teamId)
    const canceler = record.direction === 'apply' ? record.applicantId : team.ownerUserId
    if (byUserId !== canceler) throw new ApplicationError('forbidden')
    await this.apps.updateStatus(record.id, 'withdrawn')
  }

  /** Everything where the user is the (would-be) joiner: sent applies + received invites. */
  async listMine(eventSlug: string, userId: string): Promise<ApplicationView[]> {
    const records = await this.apps.listForUser(eventSlug, userId)
    return Promise.all(records.map((r) => this.toView(r, userId)))
  }

  /** Pending queue for the team owner. */
  async listForTeam(teamId: string, byUserId: string): Promise<ApplicationView[]> {
    const { team } = await this.requireTeamAndEvent(teamId)
    if (team.ownerUserId !== byUserId) throw new ApplicationError('forbidden')
    const records = await this.apps.listForTeam(teamId, 'pending')
    return Promise.all(records.map((r) => this.toView(r, byUserId)))
  }

  /**
   * The message sender (applicant for applies, owner for invites) always
   * sees their own text; the counterpart only after moderation publishes
   * it (spec §5.1).
   */
  private async toView(record: ApplicationRecord, viewerUserId: string): Promise<ApplicationView> {
    const team = await this.teams.getById(record.teamId)
    const applicant = await this.users.findById(record.applicantId)
    const senderId =
      record.direction === 'apply' ? record.applicantId : (team?.ownerUserId ?? null)
    const canSeeMessage =
      viewerUserId === senderId || record.messageVisibility === 'published'
    let message: string | null = null
    if (canSeeMessage && record.messageCiphertext) {
      message = await this.cipher.decrypt(record.messageCiphertext)
    }
    return {
      id: record.id,
      teamId: record.teamId,
      teamName: team?.name ?? '',
      direction: record.direction,
      status: record.status,
      message,
      messageVisibility: record.messageVisibility,
      applicantId: record.applicantId,
      applicantDisplayName: applicant?.displayName ?? '',
      createdAt: record.createdAt,
    }
  }
}
