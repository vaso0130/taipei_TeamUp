import type {
  ContactRecord,
  JoinOptions,
  JoinResult,
  MemberRecord,
  TeamListFilter,
  TeamRecord,
  TeamRepository,
} from './repository.js'

interface MemberState {
  joinedAt: string
  leftAt: string | null
}

/**
 * In-memory implementation for unit tests. Single-threaded, so the
 * check-then-act sequences here are effectively atomic; the real
 * concurrency guarantees are exercised against PostgreSQL in the
 * integration test suite.
 */
export class MemoryTeamRepository implements TeamRepository {
  private readonly teams = new Map<string, TeamRecord>()
  private readonly members = new Map<string, Map<string, MemberState>>()
  private readonly contacts = new Map<string, ContactRecord[]>()

  async create(record: TeamRecord, opts: JoinOptions): Promise<JoinResult> {
    this.teams.set(record.id, { ...record, memberCount: 0 })
    this.members.set(record.id, new Map())
    const joined = await this.addMember(record.id, record.ownerUserId, opts)
    if (!joined.ok) {
      this.teams.delete(record.id)
      this.members.delete(record.id)
    }
    return joined
  }

  getById(teamId: string): Promise<TeamRecord | null> {
    const team = this.teams.get(teamId)
    return Promise.resolve(team ? { ...team } : null)
  }

  listByEvent(eventSlug: string, filter?: TeamListFilter): Promise<TeamRecord[]> {
    const result = [...this.teams.values()]
      .filter((t) => t.eventSlug === eventSlug)
      .filter((t) => !filter?.status || t.status === filter.status)
      .filter((t) => !filter?.role || t.neededRoles.includes(filter.role))
      .filter((t) => !filter?.skill || t.neededSkills.includes(filter.skill))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => ({ ...t }))
    return Promise.resolve(result)
  }

  update(teamId: string, patch: Partial<TeamRecord>): Promise<void> {
    const team = this.teams.get(teamId)
    if (team) Object.assign(team, patch)
    return Promise.resolve()
  }

  addMember(teamId: string, userId: string, opts: JoinOptions): Promise<JoinResult> {
    const team = this.teams.get(teamId)
    if (!team) return Promise.resolve({ ok: false, reason: 'team_not_found' })
    const teamMembers = this.members.get(teamId)!

    const existing = teamMembers.get(userId)
    if (existing && existing.leftAt === null) {
      return Promise.resolve({ ok: false, reason: 'already_in_this_team' })
    }
    if (opts.exclusive) {
      for (const [otherId, other] of this.members) {
        if (otherId === teamId) continue
        if (this.teams.get(otherId)?.eventSlug !== team.eventSlug) continue
        const state = other.get(userId)
        if (state && state.leftAt === null) {
          return Promise.resolve({ ok: false, reason: 'already_in_another_team' })
        }
      }
    }
    if (team.memberCount >= opts.maxMembers) {
      return Promise.resolve({ ok: false, reason: 'team_full' })
    }

    teamMembers.set(userId, { joinedAt: new Date().toISOString(), leftAt: null })
    team.memberCount += 1
    const becameFull = team.memberCount >= opts.maxMembers
    if (becameFull && team.status === 'recruiting') team.status = 'full'
    return Promise.resolve({ ok: true, memberCount: team.memberCount, becameFull })
  }

  removeMember(teamId: string, userId: string): Promise<boolean> {
    const team = this.teams.get(teamId)
    const state = this.members.get(teamId)?.get(userId)
    if (!team || !state || state.leftAt !== null) return Promise.resolve(false)
    state.leftAt = new Date().toISOString()
    team.memberCount -= 1
    if (team.status === 'full') team.status = 'recruiting'
    this.contacts.set(
      teamId,
      (this.contacts.get(teamId) ?? []).filter((c) => c.userId !== userId),
    )
    return Promise.resolve(true)
  }

  isActiveMember(teamId: string, userId: string): Promise<boolean> {
    const state = this.members.get(teamId)?.get(userId)
    return Promise.resolve(!!state && state.leftAt === null)
  }

  listMembers(teamId: string): Promise<MemberRecord[]> {
    const result: MemberRecord[] = []
    for (const [userId, state] of this.members.get(teamId) ?? []) {
      if (state.leftAt === null) result.push({ teamId, userId, joinedAt: state.joinedAt })
    }
    result.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
    return Promise.resolve(result)
  }

  activeTeamIdsOf(eventSlug: string, userId: string): Promise<string[]> {
    const result: string[] = []
    for (const [teamId, members] of this.members) {
      const team = this.teams.get(teamId)
      if (!team || team.eventSlug !== eventSlug) continue
      const state = members.get(userId)
      if (state && state.leftAt === null) result.push(teamId)
    }
    return Promise.resolve(result)
  }

  activeTeamOf(eventSlug: string, userId: string): Promise<TeamRecord | null> {
    for (const [teamId, members] of this.members) {
      const team = this.teams.get(teamId)
      if (!team || team.eventSlug !== eventSlug) continue
      const state = members.get(userId)
      if (state && state.leftAt === null) return Promise.resolve({ ...team })
    }
    return Promise.resolve(null)
  }

  setContacts(teamId: string, contacts: ContactRecord[]): Promise<void> {
    this.contacts.set(teamId, contacts.map((c) => ({ ...c })))
    return Promise.resolve()
  }

  getContacts(teamId: string): Promise<ContactRecord[]> {
    return Promise.resolve((this.contacts.get(teamId) ?? []).map((c) => ({ ...c })))
  }

  listPendingPitches(): Promise<TeamRecord[]> {
    const result = [...this.teams.values()]
      .filter((t) => t.pitchVisibility === 'pending_review' && t.pitch !== '')
      .map((t) => ({ ...t }))
    return Promise.resolve(result)
  }

  transferOwnership(teamId: string, newOwnerUserId: string): Promise<void> {
    const team = this.teams.get(teamId)
    if (team) team.ownerUserId = newOwnerUserId
    return Promise.resolve()
  }

  deleteByEvent(eventSlug: string): Promise<void> {
    for (const [teamId, team] of this.teams) {
      if (team.eventSlug === eventSlug) {
        this.teams.delete(teamId)
        this.members.delete(teamId)
        this.contacts.delete(teamId)
      }
    }
    return Promise.resolve()
  }

  delete(teamId: string): Promise<void> {
    this.teams.delete(teamId)
    this.members.delete(teamId)
    this.contacts.delete(teamId)
    return Promise.resolve()
  }
}
