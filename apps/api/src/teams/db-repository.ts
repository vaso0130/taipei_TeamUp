import { and, arrayContains, asc, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { events, teamContacts, teamMembers, teams } from '../db/schema.js'
import type {
  ContactRecord,
  JoinFailure,
  JoinOptions,
  JoinResult,
  MemberRecord,
  TeamListFilter,
  TeamRecord,
  TeamRepository,
} from './repository.js'
import { isUniqueViolation } from '../db/pg-errors.js'

type TeamRow = typeof teams.$inferSelect
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Thrown inside transactions to roll back and surface a join failure. */
class JoinFailError extends Error {
  constructor(public readonly reason: JoinFailure) {
    super(reason)
  }
}

const toRecord = (eventSlug: string, row: TeamRow): TeamRecord => ({
  id: row.id,
  eventSlug,
  name: row.name,
  pitch: row.pitch,
  pitchVisibility: row.pitchVisibility,
  neededRoles: row.neededRoles,
  neededSkills: row.neededSkills,
  status: row.status,
  ownerUserId: row.ownerUserId,
  memberCount: row.memberCount,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export class DbTeamRepository implements TeamRepository {
  private readonly slugById = new Map<string, string>()
  private readonly idBySlug = new Map<string, string>()

  constructor(private readonly db: Db) {}

  private async eventIdBySlug(slug: string): Promise<string | null> {
    const cached = this.idBySlug.get(slug)
    if (cached) return cached
    const rows = await this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, slug))
      .limit(1)
    const id = rows[0]?.id ?? null
    if (id) {
      this.idBySlug.set(slug, id)
      this.slugById.set(id, slug)
    }
    return id
  }

  private async eventSlugById(id: string): Promise<string> {
    const cached = this.slugById.get(id)
    if (cached) return cached
    const rows = await this.db
      .select({ slug: events.slug })
      .from(events)
      .where(eq(events.id, id))
      .limit(1)
    const slug = rows[0]?.slug
    if (!slug) throw new Error(`event ${id} not found`)
    this.slugById.set(id, slug)
    this.idBySlug.set(slug, id)
    return slug
  }

  /**
   * Core join logic, always run inside a transaction with the team row
   * locked (SELECT ... FOR UPDATE): capacity check, rejoin handling,
   * counter increment and full-status flip are serialized per team.
   * Cross-team exclusivity is enforced by the partial unique index
   * team_members_exclusivity_idx — a concurrent second join violates it
   * and rolls back.
   */
  private async joinLocked(tx: Tx, teamId: string, userId: string, opts: JoinOptions) {
    const locked = await tx.select().from(teams).where(eq(teams.id, teamId)).for('update')
    const team = locked[0]
    if (!team) throw new JoinFailError('team_not_found')
    if (team.memberCount >= opts.maxMembers) throw new JoinFailError('team_full')

    const exclusivityKey = opts.exclusive ? team.eventId : team.id
    const existing = await tx
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      .limit(1)

    try {
      if (existing[0]) {
        if (existing[0].leftAt === null) throw new JoinFailError('already_in_this_team')
        await tx
          .update(teamMembers)
          .set({ leftAt: null, joinedAt: new Date(), exclusivityKey })
          .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
      } else {
        await tx
          .insert(teamMembers)
          .values({ teamId, eventId: team.eventId, userId, exclusivityKey })
      }
    } catch (err) {
      if (isUniqueViolation(err)) throw new JoinFailError('already_in_another_team')
      throw err
    }

    const memberCount = team.memberCount + 1
    const becameFull = memberCount >= opts.maxMembers
    await tx
      .update(teams)
      .set({
        memberCount,
        status: becameFull && team.status === 'recruiting' ? 'full' : team.status,
        updatedAt: new Date(),
      })
      .where(eq(teams.id, teamId))
    return { memberCount, becameFull }
  }

  private async runJoin(fn: (tx: Tx) => Promise<{ memberCount: number; becameFull: boolean }>) {
    try {
      const result = await this.db.transaction(fn)
      return { ok: true as const, ...result }
    } catch (err) {
      if (err instanceof JoinFailError) return { ok: false as const, reason: err.reason }
      throw err
    }
  }

  async create(record: TeamRecord, opts: JoinOptions): Promise<JoinResult> {
    const eventId = await this.eventIdBySlug(record.eventSlug)
    if (!eventId) return { ok: false, reason: 'team_not_found' }
    return this.runJoin(async (tx) => {
      await tx.insert(teams).values({
        id: record.id,
        eventId,
        name: record.name,
        pitch: record.pitch,
        pitchVisibility: record.pitchVisibility,
        neededRoles: record.neededRoles,
        neededSkills: record.neededSkills,
        status: record.status,
        ownerUserId: record.ownerUserId,
        memberCount: 0,
      })
      return this.joinLocked(tx, record.id, record.ownerUserId, opts)
    })
  }

  async addMember(teamId: string, userId: string, opts: JoinOptions): Promise<JoinResult> {
    return this.runJoin((tx) => this.joinLocked(tx, teamId, userId, opts))
  }

  async getById(teamId: string): Promise<TeamRecord | null> {
    const rows = await this.db.select().from(teams).where(eq(teams.id, teamId)).limit(1)
    const row = rows[0]
    if (!row) return null
    return toRecord(await this.eventSlugById(row.eventId), row)
  }

  async listByEvent(eventSlug: string, filter?: TeamListFilter): Promise<TeamRecord[]> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return []
    const conditions = [eq(teams.eventId, eventId)]
    if (filter?.status) conditions.push(eq(teams.status, filter.status))
    if (filter?.role) conditions.push(arrayContains(teams.neededRoles, [filter.role]))
    if (filter?.skill) conditions.push(arrayContains(teams.neededSkills, [filter.skill]))
    const rows = await this.db
      .select()
      .from(teams)
      .where(and(...conditions))
      .orderBy(asc(teams.createdAt))
    return rows.map((row) => toRecord(eventSlug, row))
  }

  async update(teamId: string, patch: Partial<TeamRecord>): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    for (const key of [
      'name',
      'pitch',
      'pitchVisibility',
      'neededRoles',
      'neededSkills',
      'status',
    ] as const) {
      if (patch[key] !== undefined) set[key] = patch[key]
    }
    await this.db.update(teams).set(set).where(eq(teams.id, teamId))
  }

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.select().from(teams).where(eq(teams.id, teamId)).for('update')
      const team = locked[0]
      if (!team) return false
      const updated = await tx
        .update(teamMembers)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.userId, userId),
            isNull(teamMembers.leftAt),
          ),
        )
        .returning({ userId: teamMembers.userId })
      if (updated.length === 0) return false
      await tx
        .update(teams)
        .set({
          memberCount: sql`${teams.memberCount} - 1`,
          status: team.status === 'full' ? 'recruiting' : team.status,
          updatedAt: new Date(),
        })
        .where(eq(teams.id, teamId))
      await tx
        .delete(teamContacts)
        .where(and(eq(teamContacts.teamId, teamId), eq(teamContacts.userId, userId)))
      return true
    })
  }

  async isActiveMember(teamId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
          isNull(teamMembers.leftAt),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async listMembers(teamId: string): Promise<MemberRecord[]> {
    const rows = await this.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt)))
      .orderBy(asc(teamMembers.joinedAt))
    return rows.map((r) => ({ teamId, userId: r.userId, joinedAt: r.joinedAt.toISOString() }))
  }

  async activeTeamIdsOf(eventSlug: string, userId: string): Promise<string[]> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return []
    const rows = await this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.eventId, eventId),
          eq(teamMembers.userId, userId),
          isNull(teamMembers.leftAt),
        ),
      )
    return rows.map((r) => r.teamId)
  }

  async activeTeamOf(eventSlug: string, userId: string): Promise<TeamRecord | null> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return null
    const rows = await this.db
      .select({ team: teams })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(
        and(
          eq(teamMembers.eventId, eventId),
          eq(teamMembers.userId, userId),
          isNull(teamMembers.leftAt),
        ),
      )
      .limit(1)
    return rows[0] ? toRecord(eventSlug, rows[0].team) : null
  }

  async setContacts(teamId: string, contacts: ContactRecord[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(teamContacts).where(eq(teamContacts.teamId, teamId))
      if (contacts.length > 0) {
        await tx
          .insert(teamContacts)
          .values(contacts.map((c) => ({ teamId, userId: c.userId, rank: c.rank })))
      }
    })
  }

  async listPendingPitches(): Promise<TeamRecord[]> {
    const rows = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.pitchVisibility, 'pending_review'), sql`${teams.pitch} <> ''`))
    return Promise.all(rows.map(async (row) => toRecord(await this.eventSlugById(row.eventId), row)))
  }

  async getContacts(teamId: string): Promise<ContactRecord[]> {
    const rows = await this.db
      .select()
      .from(teamContacts)
      .where(eq(teamContacts.teamId, teamId))
      .orderBy(asc(teamContacts.rank))
    return rows.map((r) => ({ userId: r.userId, rank: r.rank }))
  }

  async transferOwnership(teamId: string, newOwnerUserId: string): Promise<void> {
    await this.db
      .update(teams)
      .set({ ownerUserId: newOwnerUserId, updatedAt: new Date() })
      .where(eq(teams.id, teamId))
  }

  async deleteByEvent(eventSlug: string): Promise<void> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return
    await this.db.delete(teams).where(eq(teams.eventId, eventId))
  }

  async delete(teamId: string): Promise<void> {
    await this.db.delete(teams).where(eq(teams.id, teamId))
  }
}
