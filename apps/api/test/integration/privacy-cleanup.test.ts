import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { uuidv7 } from 'uuidv7'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DbApplicationRepository } from '../../src/applications/db-repository.js'
import { AuditLogger, DbAuditLogRepository } from '../../src/audit/log.js'
import { FieldCipher } from '../../src/crypto/envelope.js'
import { LocalKek } from '../../src/crypto/kek.js'
import { createDb, type Db } from '../../src/db/client.js'
import { DbEventRepository } from '../../src/events/db-repository.js'
import { loadEventSeeds } from '../../src/events/seed-loader.js'
import { DbMessageRepository, DbThreadRepository } from '../../src/messaging/db-repository.js'
import { DbModerationRecordRepository } from '../../src/moderation/records.js'
import { DbParticipantRepository } from '../../src/participants/db-repository.js'
import { upsertSeed } from '../../src/seed/upsert.js'
import { DbTeamRepository } from '../../src/teams/db-repository.js'
import type { JoinOptions, TeamRecord } from '../../src/teams/repository.js'
import { DbUserRepository } from '../../src/users/db-repository.js'
import { CleanupService, PrivacyService } from '../../src/users/privacy-service.js'
import type { UserRecord } from '../../src/users/repository.js'

/**
 * Integration tests against real PostgreSQL for the behaviours the
 * in-memory repositories cannot prove: foreign-key interplay between
 * account deletion and teams (C-1), row-by-row hard deletion, the
 * guarded application status transition (M-6), the pending-only
 * messaging relationship (L-11) and distinct-hash strike counting (M-1).
 *
 * Runs when DATABASE_URL is set (CI: postgres service container).
 */
const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('account deletion, cleanup and state guards (PostgreSQL)', () => {
  let db: Db
  let users: DbUserRepository
  let teams: DbTeamRepository
  let applications: DbApplicationRepository
  let participants: DbParticipantRepository
  let threads: DbThreadRepository
  let messages: DbMessageRepository
  let records: DbModerationRecordRepository
  let auditRepo: DbAuditLogRepository
  let events: DbEventRepository
  let privacy: PrivacyService
  let cleanup: CleanupService

  const seeds = loadEventSeeds()
  const exclusiveSeed = seeds.find((s) => s.event.exclusiveMembership)!
  const SLUG = exclusiveSeed.event.slug
  const joinOpts: JoinOptions = {
    maxMembers: exclusiveSeed.event.maxMembers,
    exclusive: exclusiveSeed.event.exclusiveMembership,
  }
  const cipher = new FieldCipher(new LocalKek(randomBytes(32).toString('base64')))

  async function newUser(): Promise<UserRecord> {
    const id = uuidv7()
    return users.create({
      id,
      emailCiphertext: await cipher.encrypt(`${id}@example.com`),
      emailLookup: randomBytes(32),
      displayName: `it-${id.slice(-6)}`,
      status: 'active',
    })
  }

  const newTeam = (ownerUserId: string): TeamRecord => ({
    id: uuidv7(),
    eventSlug: SLUG,
    name: `integration-${uuidv7().slice(-6)}`,
    pitch: '',
    pitchVisibility: 'published',
    neededRoles: [],
    neededSkills: [],
    status: 'recruiting',
    ownerUserId,
    memberCount: 0,
    createdAt: new Date().toISOString(),
  })

  beforeAll(async () => {
    db = createDb(DATABASE_URL!)
    await migrate(db, { migrationsFolder: 'drizzle' })
    for (const seed of seeds) await upsertSeed(db, seed)
    users = new DbUserRepository(db)
    teams = new DbTeamRepository(db)
    applications = new DbApplicationRepository(db)
    participants = new DbParticipantRepository(db)
    threads = new DbThreadRepository(db)
    messages = new DbMessageRepository(db)
    records = new DbModerationRecordRepository(db)
    auditRepo = new DbAuditLogRepository(db)
    events = new DbEventRepository(db)
    const audit = new AuditLogger(auditRepo)
    privacy = new PrivacyService({
      events,
      users,
      participants,
      teams,
      applications,
      messages,
      cipher,
      audit,
      records,
    })
    // The cleanup under test must not depend on the seeded events' own
    // retention windows (which move relative to the calendar): give it an
    // event list that never expires anything, so only the account and
    // record paths are exercised.
    const noEvents = { listEvents: () => Promise.resolve([]), getEventBySlug: () => Promise.resolve(null) }
    cleanup = new CleanupService({
      events: noEvents,
      users,
      participants,
      teams,
      threads,
      auditRepo,
      records,
      applications,
      messages,
    })
  })

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE moderation_records, audit_logs, messages, message_threads, applications, team_contacts, team_members, teams, event_participants, users CASCADE`,
    )
  })

  afterAll(async () => {
    await db.$client.end()
  })

  it('a sole-member owner who deletes their account can be hard-deleted after the grace period (C-1)', async () => {
    const owner = await newUser()
    const team = newTeam(owner.id)
    expect((await teams.create(team, joinOpts)).ok).toBe(true)
    // Someone else's pending application would otherwise dangle forever.
    const hopeful = await newUser()
    await applications.create({
      id: uuidv7(),
      teamId: team.id,
      applicantId: hopeful.id,
      direction: 'apply',
      messageCiphertext: null,
      messageVisibility: 'published',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })

    await privacy.deleteAccount(owner)
    expect(await teams.getById(team.id)).toBeNull()
    expect(await applications.listForTeam(team.id)).toHaveLength(0)
    expect((await users.findById(owner.id))?.status).toBe('deleted')

    // 31 days later the row goes — no foreign key stands in the way.
    const result = await cleanup.run(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))
    expect(result.hardDeletedUsers).toBe(1)
    expect(result.hardDeleteFailures).toBe(0)
    expect(await users.findById(owner.id)).toBeNull()
    expect(await users.findById(hopeful.id)).not.toBeNull()
  })

  it('a row the database refuses to delete fails alone; the others are still removed', async () => {
    // Simulate legacy state: a soft-deleted account still named as team owner.
    const stuck = await newUser()
    expect((await teams.create(newTeam(stuck.id), joinOpts)).ok).toBe(true)
    await users.updateStatus(stuck.id, 'deleted')
    const clean = await newUser()
    await users.updateStatus(clean.id, 'deleted')

    const result = await users.hardDeleteBefore(new Date(Date.now() + 1000))
    expect(result).toEqual({ deleted: 1, failed: 1 })
    expect(await users.findById(clean.id)).toBeNull()
    expect(await users.findById(stuck.id)).not.toBeNull()

    // The scheduled job reports the failure instead of blowing up.
    const summary = await cleanup.run(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))
    expect(summary.hardDeleteFailures).toBe(1)
  })

  it('application status transitions are guarded: only pending rows move (M-6)', async () => {
    const owner = await newUser()
    const applicant = await newUser()
    const team = newTeam(owner.id)
    await teams.create(team, joinOpts)
    const application = await applications.create({
      id: uuidv7(),
      teamId: team.id,
      applicantId: applicant.id,
      direction: 'apply',
      messageCiphertext: null,
      messageVisibility: 'published',
      status: 'pending',
      createdAt: new Date().toISOString(),
    })

    // Two deciders race: exactly one transition wins.
    const [a, b] = await Promise.all([
      applications.updateStatus(application.id, 'accepted'),
      applications.updateStatus(application.id, 'withdrawn'),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    const settled = (await applications.getById(application.id))!.status
    expect(['accepted', 'withdrawn']).toContain(settled)
    // A later write cannot overwrite the settled state.
    expect(await applications.updateStatus(application.id, 'rejected')).toBe(false)
    expect((await applications.getById(application.id))!.status).toBe(settled)

    // Only a PENDING application is a messaging relationship (L-11).
    expect(await applications.hasActiveRelationship(SLUG, owner.id, applicant.id)).toBe(false)
  })

  it('strike counting is per distinct content hash (M-1) and old verdicts expire (H-1)', async () => {
    const subject = await newUser()
    const record = (sha: string, targetId: string) => ({
      id: uuidv7(),
      targetType: 'message',
      targetId,
      contentSha256: sha,
      riskLevel: 'high' as const,
      categories: ['financial_scam'],
      rationale: '',
      modelId: 'test',
      promptVersion: 'v1',
      decidedBy: 'auto',
      subjectUserId: subject.id,
      flagged: false,
      createdAt: new Date().toISOString(),
    })
    const messageId = uuidv7()
    await records.create(record('aaaa', messageId))
    await records.create(record('aaaa', messageId)) // replayed task
    await records.create(record('bbbb', uuidv7()))
    expect(await records.countHighSince(subject.id, new Date(0))).toBe(2)

    // Retention: everything at least 180 days old is purged.
    expect(await records.purgeBefore(new Date(Date.now() - 1000))).toBe(0)
    expect(await records.purgeBefore(new Date(Date.now() + 1000))).toBe(3)
    expect(await records.countHighSince(subject.id, new Date(0))).toBe(0)
  })

  it('updateEmailLookup honours the unique index (pepper rotation / re-hash safety)', async () => {
    const a = await newUser()
    const b = await newUser()
    await expect(users.updateEmailLookup(b.id, a.emailLookup)).rejects.toThrowError(/unique/)
    const fresh = randomBytes(32)
    await users.updateEmailLookup(b.id, fresh)
    expect((await users.findByLookup(fresh))?.id).toBe(b.id)
  })
})
