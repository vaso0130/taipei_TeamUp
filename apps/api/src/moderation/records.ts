import { and, count, desc, eq, gte, inArray } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { moderationRecords } from '../db/schema.js'
import type { ModerationCategory, RiskLevel } from './moderator.js'

export interface ModerationRecord {
  id: string
  targetType: string
  targetId: string
  /** SHA-256 hex of the reviewed content — never the content itself. */
  contentSha256: string
  riskLevel: RiskLevel
  categories: ModerationCategory[] | string[]
  rationale: string
  modelId: string
  promptVersion: string
  /** 'auto' or 'human:<user uuid>'. */
  decidedBy: string
  subjectUserId: string | null
  /** Published as low risk but worth an after-the-fact human look. */
  flagged: boolean
  createdAt: string
}

export interface ModerationRecordRepository {
  create(record: ModerationRecord): Promise<void>
  /** High-risk strikes for the suspension rule (spec §5.5). */
  countHighSince(subjectUserId: string, since: Date): Promise<number>
  /**
   * Latest verdict per message (across 'message' and 'reported_message'
   * target types) — the admin risk overview's raw material.
   */
  listLatestMessageRecords(): Promise<ModerationRecord[]>
  /** A user's verdict history, newest first (admin strike view). */
  listBySubject(subjectUserId: string, limit: number): Promise<ModerationRecord[]>
  /**
   * Latest verdict for one target (pending-queue context) — null when
   * the target has never been auto-reviewed (e.g. still queued).
   */
  latestFor(targetTypes: string[], targetId: string): Promise<ModerationRecord | null>
  /** Admin member roster: high/medium verdict counts per user. */
  countRiskBySubject(): Promise<Map<string, { high: number; medium: number }>>
  /**
   * Reset the strike counter on admin reactivation: remove the user's
   * high verdicts inside the strike window so the next high doesn't
   * instantly re-suspend. The reactivation itself is audit-logged.
   */
  deleteHighSince(subjectUserId: string, since: Date): Promise<number>
}

export class MemoryModerationRecordRepository implements ModerationRecordRepository {
  readonly records: ModerationRecord[] = []

  create(record: ModerationRecord): Promise<void> {
    this.records.push({ ...record })
    return Promise.resolve()
  }

  countHighSince(subjectUserId: string, since: Date): Promise<number> {
    return Promise.resolve(
      this.records.filter(
        (r) =>
          r.subjectUserId === subjectUserId &&
          r.riskLevel === 'high' &&
          new Date(r.createdAt) >= since,
      ).length,
    )
  }

  listLatestMessageRecords(): Promise<ModerationRecord[]> {
    const latest = new Map<string, ModerationRecord>()
    for (const r of this.records) {
      if (r.targetType !== 'message' && r.targetType !== 'reported_message') continue
      const seen = latest.get(r.targetId)
      if (!seen || r.createdAt >= seen.createdAt) latest.set(r.targetId, r)
    }
    return Promise.resolve([...latest.values()].map((r) => ({ ...r })))
  }

  listBySubject(subjectUserId: string, limit: number): Promise<ModerationRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => r.subjectUserId === subjectUserId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((r) => ({ ...r })),
    )
  }

  latestFor(targetTypes: string[], targetId: string): Promise<ModerationRecord | null> {
    let latest: ModerationRecord | null = null
    for (const r of this.records) {
      if (r.targetId !== targetId || !targetTypes.includes(r.targetType)) continue
      if (!latest || r.createdAt >= latest.createdAt) latest = r
    }
    return Promise.resolve(latest ? { ...latest } : null)
  }

  countRiskBySubject(): Promise<Map<string, { high: number; medium: number }>> {
    const counts = new Map<string, { high: number; medium: number }>()
    for (const r of this.records) {
      if (!r.subjectUserId || (r.riskLevel !== 'high' && r.riskLevel !== 'medium')) continue
      const entry = counts.get(r.subjectUserId) ?? { high: 0, medium: 0 }
      entry[r.riskLevel]++
      counts.set(r.subjectUserId, entry)
    }
    return Promise.resolve(counts)
  }

  deleteHighSince(subjectUserId: string, since: Date): Promise<number> {
    let removed = 0
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!
      if (
        r.subjectUserId === subjectUserId &&
        r.riskLevel === 'high' &&
        new Date(r.createdAt) >= since
      ) {
        this.records.splice(i, 1)
        removed++
      }
    }
    return Promise.resolve(removed)
  }
}

export class DbModerationRecordRepository implements ModerationRecordRepository {
  constructor(private readonly db: Db) {}

  async create(record: ModerationRecord): Promise<void> {
    await this.db.insert(moderationRecords).values({
      id: record.id,
      targetType: record.targetType,
      targetId: record.targetId,
      contentSha256: record.contentSha256,
      riskLevel: record.riskLevel,
      categories: [...record.categories],
      rationale: record.rationale,
      modelId: record.modelId,
      promptVersion: record.promptVersion,
      decidedBy: record.decidedBy,
      subjectUserId: record.subjectUserId,
      flagged: record.flagged,
    })
  }

  async countHighSince(subjectUserId: string, since: Date): Promise<number> {
    const rows = await this.db
      .select({ id: moderationRecords.id })
      .from(moderationRecords)
      .where(
        and(
          eq(moderationRecords.subjectUserId, subjectUserId),
          eq(moderationRecords.riskLevel, 'high'),
          gte(moderationRecords.createdAt, since),
        ),
      )
    return rows.length
  }

  async listLatestMessageRecords(): Promise<ModerationRecord[]> {
    const rows = await this.db
      .selectDistinctOn([moderationRecords.targetId])
      .from(moderationRecords)
      .where(inArray(moderationRecords.targetType, ['message', 'reported_message']))
      .orderBy(moderationRecords.targetId, desc(moderationRecords.createdAt))
    return rows.map(toRecord)
  }

  async listBySubject(subjectUserId: string, limit: number): Promise<ModerationRecord[]> {
    const rows = await this.db
      .select()
      .from(moderationRecords)
      .where(eq(moderationRecords.subjectUserId, subjectUserId))
      .orderBy(desc(moderationRecords.createdAt))
      .limit(limit)
    return rows.map(toRecord)
  }

  async latestFor(targetTypes: string[], targetId: string): Promise<ModerationRecord | null> {
    const rows = await this.db
      .select()
      .from(moderationRecords)
      .where(
        and(
          eq(moderationRecords.targetId, targetId),
          inArray(moderationRecords.targetType, targetTypes),
        ),
      )
      .orderBy(desc(moderationRecords.createdAt))
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async countRiskBySubject(): Promise<Map<string, { high: number; medium: number }>> {
    const rows = await this.db
      .select({
        subjectUserId: moderationRecords.subjectUserId,
        riskLevel: moderationRecords.riskLevel,
        n: count(),
      })
      .from(moderationRecords)
      .where(inArray(moderationRecords.riskLevel, ['high', 'medium']))
      .groupBy(moderationRecords.subjectUserId, moderationRecords.riskLevel)
    const counts = new Map<string, { high: number; medium: number }>()
    for (const row of rows) {
      if (!row.subjectUserId) continue
      const entry = counts.get(row.subjectUserId) ?? { high: 0, medium: 0 }
      if (row.riskLevel === 'high' || row.riskLevel === 'medium') entry[row.riskLevel] += Number(row.n)
      counts.set(row.subjectUserId, entry)
    }
    return counts
  }

  async deleteHighSince(subjectUserId: string, since: Date): Promise<number> {
    const rows = await this.db
      .delete(moderationRecords)
      .where(
        and(
          eq(moderationRecords.subjectUserId, subjectUserId),
          eq(moderationRecords.riskLevel, 'high'),
          gte(moderationRecords.createdAt, since),
        ),
      )
      .returning({ id: moderationRecords.id })
    return rows.length
  }
}

const toRecord = (row: typeof moderationRecords.$inferSelect): ModerationRecord => ({
  id: row.id,
  targetType: row.targetType,
  targetId: row.targetId,
  contentSha256: row.contentSha256,
  riskLevel: row.riskLevel,
  categories: row.categories as ModerationRecord['categories'],
  rationale: row.rationale,
  modelId: row.modelId,
  promptVersion: row.promptVersion,
  decidedBy: row.decidedBy,
  subjectUserId: row.subjectUserId,
  flagged: row.flagged,
  createdAt: row.createdAt.toISOString(),
})
