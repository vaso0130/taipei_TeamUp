import { desc, eq, inArray, and } from 'drizzle-orm'
import type { ReportReason } from '@teamup/shared'
import type { Db } from '../db/client.js'
import { isUniqueViolation } from '../db/pg-errors.js'
import { messageReports } from '../db/schema.js'
import type { ReportRecord, ReportRepository } from './repository.js'

type ReportRow = typeof messageReports.$inferSelect

const toRecord = (row: ReportRow): ReportRecord => ({
  id: row.id,
  messageId: row.messageId,
  reporterUserId: row.reporterUserId,
  reason: row.reason as ReportReason,
  status: row.status as ReportRecord['status'],
  createdAt: row.createdAt.toISOString(),
})

export class DbReportRepository implements ReportRepository {
  constructor(private readonly db: Db) {}

  async create(record: ReportRecord): Promise<ReportRecord | null> {
    try {
      await this.db.insert(messageReports).values({
        id: record.id,
        messageId: record.messageId,
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

  async listByMessage(messageId: string): Promise<ReportRecord[]> {
    const rows = await this.db
      .select()
      .from(messageReports)
      .where(eq(messageReports.messageId, messageId))
      .orderBy(desc(messageReports.createdAt))
    return rows.map(toRecord)
  }

  async reportedMessageIds(reporterUserId: string, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set()
    const rows = await this.db
      .select({ messageId: messageReports.messageId })
      .from(messageReports)
      .where(
        and(
          eq(messageReports.reporterUserId, reporterUserId),
          inArray(messageReports.messageId, messageIds),
        ),
      )
    return new Set(rows.map((r) => r.messageId))
  }

  async resolveForMessage(messageId: string): Promise<void> {
    await this.db
      .update(messageReports)
      .set({ status: 'resolved' })
      .where(eq(messageReports.messageId, messageId))
  }

  async listAll(): Promise<ReportRecord[]> {
    const rows = await this.db
      .select()
      .from(messageReports)
      .orderBy(desc(messageReports.createdAt))
    return rows.map(toRecord)
  }

  async listByReporter(reporterUserId: string): Promise<ReportRecord[]> {
    const rows = await this.db
      .select()
      .from(messageReports)
      .where(eq(messageReports.reporterUserId, reporterUserId))
      .orderBy(desc(messageReports.createdAt))
    return rows.map(toRecord)
  }
}
