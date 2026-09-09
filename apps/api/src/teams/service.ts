import { uuidv7 } from 'uuidv7'
import type {
  ContactsInput,
  CreateTeamInput,
  EventConfig,
  TeamDetail,
  TeamMemberView,
  TeamSummary,
  UpdateTeamInput,
} from '@teamup/shared'
import type { EventRepository } from '../events/repository.js'
import { safeEnqueue, type ModerationQueue } from '../moderation/service.js'
import type { ParticipantRepository } from '../participants/repository.js'
import type { UserRepository } from '../users/repository.js'
import type { JoinOptions, TeamListFilter, TeamRecord, TeamRepository } from './repository.js'

export type TeamErrorCode =
  | 'event_not_found'
  | 'team_not_found'
  | 'recruiting_closed'
  | 'invalid_role_keys'
  | 'invalid_skill_keys'
  | 'already_in_team'
  | 'team_full'
  | 'forbidden'
  | 'not_a_member'
  | 'owner_cannot_leave'
  | 'team_not_empty'
  | 'contacts_not_allowed_yet'
  | 'invalid_contacts'
  | 'participation_required'

export class TeamError extends Error {
  constructor(
    public readonly code: TeamErrorCode,
    public readonly detail?: unknown,
  ) {
    super(code)
    this.name = 'TeamError'
  }
}

export const joinOptions = (event: EventConfig): JoinOptions => ({
  maxMembers: event.maxMembers,
  exclusive: event.exclusiveMembership,
})

export const recruitWindowOpen = (event: EventConfig, now = new Date()): boolean =>
  event.status === 'open' && now < new Date(event.recruitClosesAt)

export class TeamService {
  constructor(
    private readonly events: EventRepository,
    private readonly teams: TeamRepository,
    private readonly users: UserRepository,
    private readonly moderationQueue: ModerationQueue,
    private readonly participants: ParticipantRepository,
  ) {}

  private async requireEvent(eventSlug: string): Promise<EventConfig> {
    const detail = await this.events.getEventBySlug(eventSlug)
    if (!detail) throw new TeamError('event_not_found')
    return detail.event
  }

  /**
   * Event eligibility (H-4): opening a team requires a participation
   * record in the event and, when the event asks, an answered adult
   * check — the only place the event's age rule can bite.
   */
  private async requireParticipant(event: EventConfig, userId: string): Promise<void> {
    const participation = await this.participants.get(event.slug, userId)
    if (!participation) throw new TeamError('participation_required')
    if (event.requiresAdultCheck && participation.isAdult === null) {
      throw new TeamError('participation_required')
    }
  }

  /** Authorization check for owner-only writes, usable before any side effect. */
  async requireOwner(teamId: string, byUserId: string): Promise<TeamRecord> {
    const team = await this.teams.getById(teamId)
    if (!team) throw new TeamError('team_not_found')
    if (team.ownerUserId !== byUserId) throw new TeamError('forbidden')
    return team
  }

  private async validateDictionaryKeys(
    eventSlug: string,
    roles: string[] | undefined,
    skills: string[] | undefined,
  ) {
    const detail = await this.events.getEventBySlug(eventSlug)
    if (!detail) throw new TeamError('event_not_found')
    if (roles) {
      const known = new Set(detail.roles.map((r) => r.key))
      const bad = roles.filter((k) => !known.has(k))
      if (bad.length > 0) throw new TeamError('invalid_role_keys', bad)
    }
    if (skills) {
      const known = new Set(detail.skills.map((s) => s.key))
      const bad = skills.filter((k) => !known.has(k))
      if (bad.length > 0) throw new TeamError('invalid_skill_keys', bad)
    }
  }

  async createTeam(eventSlug: string, ownerUserId: string, input: CreateTeamInput) {
    const event = await this.requireEvent(eventSlug)
    if (!recruitWindowOpen(event)) throw new TeamError('recruiting_closed')
    await this.requireParticipant(event, ownerUserId)
    await this.validateDictionaryKeys(eventSlug, input.neededRoles, input.neededSkills)

    const pitch = input.pitch.trim()
    const record: TeamRecord = {
      id: uuidv7(),
      eventSlug,
      name: input.name,
      pitch,
      pitchVisibility: pitch === '' ? 'published' : 'pending_review',
      neededRoles: [...new Set(input.neededRoles)],
      neededSkills: [...new Set(input.neededSkills)],
      status: 'recruiting',
      ownerUserId,
      memberCount: 0,
      createdAt: new Date().toISOString(),
    }
    const result = await this.teams.create(record, joinOptions(event))
    if (!result.ok) {
      if (result.reason === 'already_in_another_team') throw new TeamError('already_in_team')
      throw new TeamError('team_not_found')
    }
    if (record.pitchVisibility === 'pending_review') {
      await safeEnqueue(this.moderationQueue, { type: 'team_pitch', teamId: record.id })
    }
    return this.getTeamDetail(record.id, ownerUserId)
  }

  async listTeams(eventSlug: string, filter?: TeamListFilter): Promise<TeamSummary[]> {
    await this.requireEvent(eventSlug)
    const records = await this.teams.listByEvent(eventSlug, filter)
    return records.map((r) => this.toSummary(r, null))
  }

  async getTeamDetail(teamId: string, viewerUserId: string | null): Promise<TeamDetail> {
    const team = await this.teams.getById(teamId)
    if (!team) throw new TeamError('team_not_found')
    const members = await this.teams.listMembers(teamId)
    const contacts = await this.teams.getContacts(teamId)
    const memberViews: TeamMemberView[] = await Promise.all(
      members.map(async (m) => ({
        userId: m.userId,
        displayName: (await this.users.findById(m.userId))?.displayName ?? '（已離開）',
        joinedAt: m.joinedAt,
      })),
    )
    const viewerIsMember = viewerUserId !== null && members.some((m) => m.userId === viewerUserId)
    return {
      ...this.toSummary(team, viewerUserId),
      eventSlug: team.eventSlug,
      ownerUserId: team.ownerUserId,
      members: memberViews,
      contacts,
      viewerIsOwner: viewerUserId === team.ownerUserId,
      viewerIsMember,
    }
  }

  async updateTeam(teamId: string, byUserId: string, input: UpdateTeamInput) {
    const team = await this.requireOwner(teamId, byUserId)
    const event = await this.requireEvent(team.eventSlug)
    await this.validateDictionaryKeys(team.eventSlug, input.neededRoles, input.neededSkills)

    const patch: Partial<TeamRecord> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.neededRoles !== undefined) patch.neededRoles = [...new Set(input.neededRoles)]
    if (input.neededSkills !== undefined) patch.neededSkills = [...new Set(input.neededSkills)]
    if (input.pitch !== undefined) {
      const pitch = input.pitch.trim()
      if (pitch !== team.pitch) {
        patch.pitch = pitch
        patch.pitchVisibility = pitch === '' ? 'published' : 'pending_review'
      }
    }
    if (input.status !== undefined && input.status !== team.status) {
      if (input.status === 'recruiting') {
        if (team.memberCount >= event.maxMembers) throw new TeamError('team_full')
        if (!recruitWindowOpen(event)) throw new TeamError('recruiting_closed')
      }
      patch.status = input.status
    }
    await this.teams.update(teamId, patch)
    if (patch.pitchVisibility === 'pending_review') {
      await safeEnqueue(this.moderationQueue, { type: 'team_pitch', teamId })
    }
    return this.getTeamDetail(teamId, byUserId)
  }

  /**
   * Contacts: only the owner, only once the team has reached the
   * event's minimum size, exactly required_contacts distinct members
   * with ranks 1..n. All numbers come from event config.
   */
  async designateContacts(teamId: string, byUserId: string, input: ContactsInput) {
    const team = await this.teams.getById(teamId)
    if (!team) throw new TeamError('team_not_found')
    if (team.ownerUserId !== byUserId) throw new TeamError('forbidden')
    const event = await this.requireEvent(team.eventSlug)

    if (event.requiredContacts === 0) {
      throw new TeamError('invalid_contacts', 'this event does not use contact persons')
    }
    if (team.memberCount < event.minMembers) {
      throw new TeamError('contacts_not_allowed_yet', { minMembers: event.minMembers })
    }
    const { contacts } = input
    if (contacts.length !== event.requiredContacts) {
      throw new TeamError('invalid_contacts', { expected: event.requiredContacts })
    }
    const ranks = new Set(contacts.map((c) => c.rank))
    const expectedRanks = Array.from({ length: event.requiredContacts }, (_, i) => i + 1)
    if (!expectedRanks.every((r) => ranks.has(r))) {
      throw new TeamError('invalid_contacts', { expectedRanks })
    }
    const userIds = new Set(contacts.map((c) => c.userId))
    if (userIds.size !== contacts.length) {
      throw new TeamError('invalid_contacts', 'contacts must be distinct members')
    }
    for (const c of contacts) {
      if (!(await this.teams.isActiveMember(teamId, c.userId))) {
        throw new TeamError('invalid_contacts', 'contacts must be current members')
      }
    }
    await this.teams.setContacts(teamId, contacts)
    return this.getTeamDetail(teamId, byUserId)
  }

  /**
   * Owner deletes their own team. Only allowed while the owner is the
   * sole active member — with teammates aboard, deletion would silently
   * evict them; disband first (members leave), then delete.
   */
  async deleteTeam(teamId: string, byUserId: string): Promise<void> {
    const team = await this.teams.getById(teamId)
    if (!team) throw new TeamError('team_not_found')
    if (team.ownerUserId !== byUserId) throw new TeamError('forbidden')
    const members = await this.teams.listMembers(teamId)
    if (members.some((m) => m.userId !== byUserId)) throw new TeamError('team_not_empty')
    await this.teams.delete(teamId)
  }

  async leaveTeam(teamId: string, userId: string): Promise<void> {
    const team = await this.teams.getById(teamId)
    if (!team) throw new TeamError('team_not_found')
    if (team.ownerUserId === userId) throw new TeamError('owner_cannot_leave')
    const removed = await this.teams.removeMember(teamId, userId)
    if (!removed) throw new TeamError('not_a_member')
  }

  async myTeam(eventSlug: string, userId: string): Promise<TeamDetail | null> {
    const team = await this.teams.activeTeamOf(eventSlug, userId)
    return team ? this.getTeamDetail(team.id, userId) : null
  }

  /** Unpublished pitches are visible to the team owner only (spec §5.1). */
  private toSummary(record: TeamRecord, viewerUserId: string | null): TeamSummary {
    const pitchVisible =
      record.pitchVisibility === 'published' || viewerUserId === record.ownerUserId
    return {
      id: record.id,
      name: record.name,
      pitch: pitchVisible ? record.pitch : '',
      pitchVisibility: record.pitchVisibility,
      neededRoles: record.neededRoles,
      neededSkills: record.neededSkills,
      status: record.status,
      memberCount: record.memberCount,
      createdAt: record.createdAt,
    }
  }
}
