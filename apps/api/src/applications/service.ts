import { uuidv7 } from 'uuidv7'
import type { ApplicationView, EventConfig } from '@teamup/shared'
import type { FieldCipher } from '../crypto/envelope.js'
import type { EventRepository } from '../events/repository.js'
import { safeEnqueue, type ModerationQueue } from '../moderation/service.js'
import type { ParticipantRepository } from '../participants/repository.js'
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
  | 'participation_required'

export class ApplicationError extends Error {
  constructor(public readonly code: ApplicationErrorCode) {
    super(code)
    this.name = 'ApplicationError'
  }
}

/**
 * Event eligibility gate (H-4): joining a team in an event requires a
 * participation record in THAT event, and — when the event asks — an
 * answered adult check. Everything else about the person (roles, blurb)
 * is optional; this is the minimum that makes the event's own rules
 * enforceable. Also closes cross-event invitations: an invitee who never
 * joined the event cannot be pulled into it.
 */
export async function assertEventParticipant(
  participants: ParticipantRepository,
  event: EventConfig,
  userId: string,
): Promise<void> {
  const participation = await participants.get(event.slug, userId)
  if (!participation) throw new ApplicationError('participation_required')
  if (event.requiresAdultCheck && participation.isAdult === null) {
    throw new ApplicationError('participation_required')
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
    private readonly participants: ParticipantRepository,
  ) {}

  private async moderateIfNeeded(record: ApplicationRecord): Promise<ApplicationRecord> {
    if (record.messageCiphertext && record.messageVisibility === 'pending_review') {
      // An enqueue failure leaves the message pending (never published);
      // the cleanup job re-queues stale pending content.
      await safeEnqueue(this.moderationQueue, {
        type: 'application_message',
        applicationId: record.id,
      })
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
    await assertEventParticipant(this.participants, event, joinerUserId)
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
   * stale accept can never overfill a team. Every status write is a
   * guarded pending→X transition, so concurrent deciders cannot overwrite
   * each other (the loser sees not_pending).
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
      if (!(await this.apps.updateStatus(record.id, 'rejected'))) {
        throw new ApplicationError('not_pending')
      }
      return this.toView({ ...record, status: 'rejected' }, byUserId)
    }

    if (!recruitWindowOpen(event)) throw new ApplicationError('recruiting_closed')
    // A team that stopped recruiting cannot take on old applications;
    // `full` maps to the more specific code.
    if (team.status === 'full') throw new ApplicationError('team_full')
    if (team.status !== 'recruiting') throw new ApplicationError('not_recruiting')
    await assertEventParticipant(this.participants, event, record.applicantId)

    const joined = await this.teams.addMember(record.teamId, record.applicantId, joinOptions(event))
    if (!joined.ok) {
      switch (joined.reason) {
        case 'team_full':
          throw new ApplicationError('team_full')
        case 'already_in_this_team':
          // Only one pending row exists per (team, user), so this is a
          // concurrent accept of the same application: the other call
          // owns the status transition — never overwrite it.
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
    if (!(await this.apps.updateStatus(record.id, 'withdrawn'))) {
      throw new ApplicationError('not_pending')
    }
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
    // Blocked text is shown to no one — not even its author (same rule
    // as messages); otherwise the author always sees their own words.
    const canSeeMessage =
      record.messageVisibility !== 'blocked' &&
      (viewerUserId === senderId || record.messageVisibility === 'published')
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
