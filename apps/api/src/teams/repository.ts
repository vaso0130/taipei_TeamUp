import type { ContentVisibility, TeamStatus } from '@teamup/shared'

export interface TeamRecord {
  id: string
  eventSlug: string
  name: string
  pitch: string
  pitchVisibility: ContentVisibility
  neededRoles: string[]
  neededSkills: string[]
  status: TeamStatus
  ownerUserId: string
  memberCount: number
  createdAt: string
}

export interface MemberRecord {
  teamId: string
  userId: string
  joinedAt: string
}

export interface ContactRecord {
  userId: string
  rank: number
}

/** Join mechanics config — always derived from event config, never literals. */
export interface JoinOptions {
  maxMembers: number
  exclusive: boolean
}

export type JoinFailure =
  | 'team_not_found'
  | 'team_full'
  | 'already_in_this_team'
  | 'already_in_another_team'

export type JoinResult =
  | { ok: true; memberCount: number; becameFull: boolean }
  | { ok: false; reason: JoinFailure }

export interface TeamListFilter {
  status?: TeamStatus
  role?: string
  skill?: string
}

/**
 * Team storage. The concurrency-critical invariants — member cap and
 * one-team-per-person — are enforced INSIDE these atomic operations
 * (DB implementation: row lock + partial unique index; covered by
 * integration tests running against real PostgreSQL in CI).
 */
export interface TeamRepository {
  /** Create the team and add the owner as first member, atomically. */
  create(record: TeamRecord, opts: JoinOptions): Promise<JoinResult>
  getById(teamId: string): Promise<TeamRecord | null>
  listByEvent(eventSlug: string, filter?: TeamListFilter): Promise<TeamRecord[]>
  update(
    teamId: string,
    patch: Partial<
      Pick<
        TeamRecord,
        'name' | 'pitch' | 'pitchVisibility' | 'neededRoles' | 'neededSkills' | 'status'
      >
    >,
  ): Promise<void>
  /** Atomic: capacity check + exclusivity + counter + full-status flip. */
  addMember(teamId: string, userId: string, opts: JoinOptions): Promise<JoinResult>
  /** Marks left_at, decrements the counter, drops full status, removes contact rank. */
  removeMember(teamId: string, userId: string): Promise<boolean>
  isActiveMember(teamId: string, userId: string): Promise<boolean>
  listMembers(teamId: string): Promise<MemberRecord[]>
  /** The team a user currently belongs to within an event (first hit). */
  activeTeamOf(eventSlug: string, userId: string): Promise<TeamRecord | null>
  /** All teams the user is an active member of within an event. */
  activeTeamIdsOf(eventSlug: string, userId: string): Promise<string[]>
  /** Replace the full contact list. */
  setContacts(teamId: string, contacts: ContactRecord[]): Promise<void>
  getContacts(teamId: string): Promise<ContactRecord[]>
  /** Non-empty pitches still awaiting moderation (the review queue). */
  listPendingPitches(): Promise<TeamRecord[]>
  /** Ownership handover during account deletion. */
  transferOwnership(teamId: string, newOwnerUserId: string): Promise<void>
  /** Retention cleanup: purge all teams of an event (memberships cascade). */
  deleteByEvent(eventSlug: string): Promise<void>
  /** Hard-delete one team (memberships, contacts, applications cascade). */
  delete(teamId: string): Promise<void>
}
