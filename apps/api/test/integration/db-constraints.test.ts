import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../../src/db/client.js'
import { loadEventSeeds } from '../../src/events/seed-loader.js'
import { upsertSeed } from '../../src/seed/upsert.js'
import { DbTeamRepository } from '../../src/teams/db-repository.js'
import type { JoinOptions, TeamRecord } from '../../src/teams/repository.js'
import { DbUserRepository } from '../../src/users/db-repository.js'
import { UniqueViolationError } from '../../src/users/repository.js'

/**
 * Integration tests against real PostgreSQL — the authoritative proof
 * of the two concurrency-critical rules (spec §9 M3 acceptance):
 *   1. a team can never exceed events.max_members under concurrency
 *   2. one person can never hold two active memberships in an
 *      exclusive event (partial unique index)
 *
 * Runs when DATABASE_URL is set (CI: postgres service container).
 * Locally without a database the whole suite is skipped.
 */
const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('PostgreSQL constraint enforcement', () => {
  let db: Db
  let teams: DbTeamRepository
  let users: DbUserRepository

  const seeds = loadEventSeeds()
  const exclusiveSeed = seeds.find((s) => s.event.exclusiveMembership)!
  const nonExclusiveSeed = seeds.find((s) => !s.event.exclusiveMembership)!

  const joinOpts = (seed: typeof exclusiveSeed): JoinOptions => ({
    maxMembers: seed.event.maxMembers,
    exclusive: seed.event.exclusiveMembership,
  })

  async function newUser(): Promise<string> {
    const id = uuidv7()
    await users.create({
      id,
      emailCiphertext: randomBytes(48),
      emailLookup: randomBytes(32),
      displayName: `it-${id.slice(-6)}`,
      status: 'active',
    })
    return id
  }

  function newTeam(eventSlug: string, ownerUserId: string): TeamRecord {
    return {
      id: uuidv7(),
      eventSlug,
      name: `integration-${uuidv7().slice(-6)}`,
      pitch: '',
      pitchVisibility: 'published',
      neededRoles: [],
      neededSkills: [],
      status: 'recruiting',
      ownerUserId,
      memberCount: 0,
      createdAt: new Date().toISOString(),
    }
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL!)
    await migrate(db, { migrationsFolder: 'drizzle' })
    for (const seed of seeds) await upsertSeed(db, seed)
    teams = new DbTeamRepository(db)
    users = new DbUserRepository(db)
  })

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE applications, team_contacts, team_members, teams, event_participants, users CASCADE`,
    )
  })

  afterAll(async () => {
    await db.$client.end()
  })

  it('concurrent joins can never push a team past max_members', async () => {
    const max = exclusiveSeed.event.maxMembers
    const owner = await newUser()
    const record = newTeam(exclusiveSeed.event.slug, owner)
    const created = await teams.create(record, joinOpts(exclusiveSeed))
    expect(created.ok).toBe(true)

    // Twice as many hopefuls as there are remaining seats, all at once.
    const hopefuls = await Promise.all(
      Array.from({ length: (max - 1) * 2 }, () => newUser()),
    )
    const results = await Promise.all(
      hopefuls.map((userId) => teams.addMember(record.id, userId, joinOpts(exclusiveSeed))),
    )

    const succeeded = results.filter((r) => r.ok).length
    expect(succeeded).toBe(max - 1)
    const team = await teams.getById(record.id)
    expect(team?.memberCount).toBe(max)
    expect(team?.status).toBe('full')
    expect(await teams.listMembers(record.id)).toHaveLength(max)
  })

  it('one person cannot join two teams concurrently in an exclusive event', async () => {
    const slug = exclusiveSeed.event.slug
    const [ownerA, ownerB, joiner] = await Promise.all([newUser(), newUser(), newUser()])
    const teamA = newTeam(slug, ownerA!)
    const teamB = newTeam(slug, ownerB!)
    expect((await teams.create(teamA, joinOpts(exclusiveSeed))).ok).toBe(true)
    expect((await teams.create(teamB, joinOpts(exclusiveSeed))).ok).toBe(true)

    const [ra, rb] = await Promise.all([
      teams.addMember(teamA.id, joiner!, joinOpts(exclusiveSeed)),
      teams.addMember(teamB.id, joiner!, joinOpts(exclusiveSeed)),
    ])
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1)

    const active = await teams.activeTeamOf(slug, joiner!)
    expect(active).not.toBeNull()
  })

  it('sequential double-join is also rejected in an exclusive event', async () => {
    const slug = exclusiveSeed.event.slug
    const [ownerA, ownerB, joiner] = await Promise.all([newUser(), newUser(), newUser()])
    const teamA = newTeam(slug, ownerA!)
    const teamB = newTeam(slug, ownerB!)
    await teams.create(teamA, joinOpts(exclusiveSeed))
    await teams.create(teamB, joinOpts(exclusiveSeed))

    expect((await teams.addMember(teamA.id, joiner!, joinOpts(exclusiveSeed))).ok).toBe(true)
    const second = await teams.addMember(teamB.id, joiner!, joinOpts(exclusiveSeed))
    expect(second).toEqual({ ok: false, reason: 'already_in_another_team' })
  })

  it('non-exclusive events allow one person in two teams', async () => {
    const slug = nonExclusiveSeed.event.slug
    const [ownerA, ownerB, joiner] = await Promise.all([newUser(), newUser(), newUser()])
    const teamA = newTeam(slug, ownerA!)
    const teamB = newTeam(slug, ownerB!)
    await teams.create(teamA, joinOpts(nonExclusiveSeed))
    await teams.create(teamB, joinOpts(nonExclusiveSeed))

    expect((await teams.addMember(teamA.id, joiner!, joinOpts(nonExclusiveSeed))).ok).toBe(true)
    expect((await teams.addMember(teamB.id, joiner!, joinOpts(nonExclusiveSeed))).ok).toBe(true)
  })

  it('leaving frees the seat and permits joining another exclusive team', async () => {
    const slug = exclusiveSeed.event.slug
    const [ownerA, ownerB, joiner] = await Promise.all([newUser(), newUser(), newUser()])
    const teamA = newTeam(slug, ownerA!)
    const teamB = newTeam(slug, ownerB!)
    await teams.create(teamA, joinOpts(exclusiveSeed))
    await teams.create(teamB, joinOpts(exclusiveSeed))

    await teams.addMember(teamA.id, joiner!, joinOpts(exclusiveSeed))
    expect(await teams.removeMember(teamA.id, joiner!)).toBe(true)
    expect((await teams.addMember(teamB.id, joiner!, joinOpts(exclusiveSeed))).ok).toBe(true)
  })

  it('duplicate email lookups are rejected by the unique index', async () => {
    const lookup = randomBytes(32)
    const make = () => ({
      id: uuidv7(),
      emailCiphertext: randomBytes(48),
      emailLookup: lookup,
      displayName: 'dup',
      status: 'active' as const,
    })
    await users.create(make())
    await expect(users.create(make())).rejects.toThrowError(UniqueViolationError)
  })
})
