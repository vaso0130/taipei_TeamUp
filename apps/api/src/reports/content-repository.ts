import { and, desc, eq } from 'drizzle-orm'
import type { ReportReason } from '@teamup/shared'
import type { Db } from '../db/client.js'
import { contentReports } from '../db/schema.js'
import { isUniqueViolation } from '../db/pg-errors.js'
import type { ReportListFilter } from './repository.js'

/** What non-message content a report points at. */
export type ContentReportTargetType = 'team' | 'participant'

export interface ContentReportRecord {
  id: string
  targetType: ContentReportTargetType
  /** Team id, or `eventSlug/userId` for a participant. */
  targetId: string
  reporterUserId: string
  reason: ReportReason
  /** 'pending' until the escalation review (auto or human) lands. */
  status: 'pending' | 'resolved'
  createdAt: string
}

export interface ContentReportRepository {
  /** Returns null when this reporter already reported this target. */
  create(record: ContentReportRecord): Promise<ContentReportRecord | null>
  /** Latest-first reports against one target (context for the reviewer). */
  listByTarget(
    targetType: ContentReportTargetType,
    targetId: string,
  ): Promise<ContentReportRecord[]>
  /** Mark every report on the target resolved once a verdict lands. */
  resolveForTarget(targetType: ContentReportTargetType, targetId: string): Promise<void>
  /** Reports one user filed (their own data export). */
  listByReporter(reporterUserId: string): Promise<ContentReportRecord[]>
  /** Newest-first page for the admin report log (ADR-034), optionally by status. */
  listRecent(filter: ReportListFilter): Promise<ContentReportRecord[]>
}

export class MemoryContentReportRepository implements ContentReportRepository {
  private readonly records: ContentReportRecord[] = []

  create(record: ContentReportRecord): Promise<ContentReportRecord | null> {
    const duplicate = this.records.some(
      (r) =>
        r.targetType === record.targetType &&
        r.targetId === record.targetId &&
        r.reporterUserId === record.reporterUserId,
    )
    if (duplicate) return Promise.resolve(null)
    this.records.push({ ...record })
    return Promise.resolve({ ...record })
  }

  listByTarget(
    targetType: ContentReportTargetType,
    targetId: string,
  ): Promise<ContentReportRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => r.targetType === targetType && r.targetId === targetId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => ({ ...r })),
    )
  }

  resolveForTarget(targetType: ContentReportTargetType, targetId: string): Promise<void> {
    for (const r of this.records) {
      if (r.targetType === targetType && r.targetId === targetId) r.status = 'resolved'
    }
    return Promise.resolve()
  }

  listByReporter(reporterUserId: string): Promise<ContentReportRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => r.reporterUserId === reporterUserId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => ({ ...r })),
    )
  }

  listRecent(filter: ReportListFilter): Promise<ContentReportRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => filter.status === undefined || r.status === filter.status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, filter.limit)
        .map((r) => ({ ...r })),
    )
  }
}

type ContentReportRow = typeof contentReports.$inferSelect

const toRecord = (row: ContentReportRow): ContentReportRecord => ({
  id: row.id,
  targetType: row.targetType as ContentReportTargetType,
  targetId: row.targetId,
  reporterUserId: row.reporterUserId,
  reason: row.reason as ReportReason,
  status: row.status as ContentReportRecord['status'],
  createdAt: row.createdAt.toISOString(),
})

export class DbContentReportRepository implements ContentReportRepository {
  constructor(private readonly db: Db) {}

  async create(record: ContentReportRecord): Promise<ContentReportRecord | null> {
    try {
      await this.db.insert(contentReports).values({
        id: record.id,
        targetType: record.targetType,
        targetId: record.targetId,
        reporterUserId: record.reporterUserId,
        reason: record.reason,
        status: record.status,
      })
      return record
    } catch (err) {
      if (isUniqueViolation(err)) return null
      throw err
    }
  }

  async listByTarget(
    targetType: ContentReportTargetType,
    targetId: string,
  ): Promise<ContentReportRecord[]> {
    const rows = await this.db
      .select()
      .from(contentReports)
      .where(
        and(eq(contentReports.targetType, targetType), eq(contentReports.targetId, targetId)),
      )
      .orderBy(desc(contentReports.createdAt))
    return rows.map(toRecord)
  }

  async resolveForTarget(
    targetType: ContentReportTargetType,
    targetId: string,
  ): Promise<void> {
    await this.db
      .update(contentReports)
      .set({ status: 'resolved' })
      .where(
        and(eq(contentReports.targetType, targetType), eq(contentReports.targetId, targetId)),
      )
  }

  async listByReporter(reporterUserId: string): Promise<ContentReportRecord[]> {
    const rows = await this.db
      .select()
      .from(contentReports)
      .where(eq(contentReports.reporterUserId, reporterUserId))
      .orderBy(desc(contentReports.createdAt))
    return rows.map(toRecord)
  }

  async listRecent(filter: ReportListFilter): Promise<ContentReportRecord[]> {
    const rows = await this.db
      .select()
      .from(contentReports)
      .where(filter.status ? eq(contentReports.status, filter.status) : undefined)
      .orderBy(desc(contentReports.createdAt))
      .limit(filter.limit)
    return rows.map(toRecord)
  }
}
