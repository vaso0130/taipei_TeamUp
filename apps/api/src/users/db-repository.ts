import { and, count, desc, eq, lte } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { isUniqueViolation } from '../db/pg-errors.js'
import { users } from '../db/schema.js'
import {
  UniqueViolationError,
  type HardDeleteResult,
  type UserRecord,
  type UserRepository,
} from './repository.js'

type UserRow = typeof users.$inferSelect

const toRecord = (row: UserRow): UserRecord => ({
  id: row.id,
  emailCiphertext: row.emailCiphertext,
  emailLookup: row.emailLookup,
  displayName: row.displayName,
  status: row.status,
})

export class DbUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async findByLookup(lookup: Buffer): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.emailLookup, lookup)).limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async listAll(): Promise<(UserRecord & { createdAt: string | null })[]> {
    const rows = await this.db.select().from(users).orderBy(desc(users.createdAt))
    return rows.map((row) => ({ ...toRecord(row), createdAt: row.createdAt.toISOString() }))
  }

  async countByStatus(): Promise<Record<UserRecord['status'], number>> {
    const rows = await this.db
      .select({ status: users.status, n: count() })
      .from(users)
      .groupBy(users.status)
    const counts: Record<UserRecord['status'], number> = { active: 0, suspended: 0, deleted: 0 }
    for (const r of rows) counts[r.status] = Number(r.n)
    return counts
  }

  async create(record: UserRecord): Promise<UserRecord> {
    try {
      await this.db.insert(users).values({
        id: record.id,
        emailCiphertext: record.emailCiphertext,
        emailLookup: record.emailLookup,
        displayName: record.displayName,
        status: record.status,
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new UniqueViolationError('users_email_lookup_idx')
      }
      throw err
    }
    return record
  }

  async updateDisplayName(id: string, displayName: string): Promise<void> {
    await this.db
      .update(users)
      .set({ displayName, updatedAt: new Date() })
      .where(eq(users.id, id))
  }

  async updateStatus(id: string, status: UserRecord['status']): Promise<void> {
    await this.db
      .update(users)
      .set({
        status,
        updatedAt: new Date(),
        deletedAt: status === 'deleted' ? new Date() : null,
      })
      .where(eq(users.id, id))
  }

  async updateEmailLookup(id: string, lookup: Buffer): Promise<void> {
    try {
      await this.db
        .update(users)
        .set({ emailLookup: lookup, updatedAt: new Date() })
        .where(eq(users.id, id))
    } catch (err) {
      if (isUniqueViolation(err)) throw new UniqueViolationError('users_email_lookup_idx')
      throw err
    }
  }

  /**
   * Row by row on purpose: one dangling foreign key (a team that still
   * names the user as owner, say) must fail that row only — a single
   * multi-row DELETE would roll back everyone's deletion together.
   */
  async hardDeleteBefore(cutoff: Date): Promise<HardDeleteResult> {
    const due = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, 'deleted'), lte(users.deletedAt, cutoff)))
    let deleted = 0
    let failed = 0
    for (const { id } of due) {
      try {
        const removed = await this.db.delete(users).where(eq(users.id, id)).returning({ id: users.id })
        deleted += removed.length
      } catch (err) {
        failed += 1
        // Only the id and the error class — never anything decrypted.
        console.error(
          `hard delete failed for user ${id}: ${err instanceof Error ? err.name : 'unknown error'}`,
        )
      }
    }
    return { deleted, failed }
  }
}
