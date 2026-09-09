import type { ReportReason } from '@teamup/shared'

export interface ReportRecord {
  id: string
  messageId: string
  reporterUserId: string
  reason: ReportReason
  /** 'pending' until the escalation review (auto or human) lands. */
  status: 'pending' | 'resolved'
  createdAt: string
}

/** Admin report log filter (shared by message and content reports). */
export interface ReportListFilter {
  /** Absent → both pending and resolved. */
  status?: 'pending' | 'resolved'
  limit: number
}

export interface ReportRepository {
  /** Returns null when this reporter already reported this message. */
  create(record: ReportRecord): Promise<ReportRecord | null>
  /** Latest-first reports against one message (context for the reviewer). */
  listByMessage(messageId: string): Promise<ReportRecord[]>
  /** Which of these messages the viewer has reported (for the UI). */
  reportedMessageIds(reporterUserId: string, messageIds: string[]): Promise<Set<string>>
  /** Mark every report on the message resolved once a verdict lands. */
  resolveForMessage(messageId: string): Promise<void>
  /** Every report, newest first (admin risk overview; field-test scale). */
  listAll(): Promise<ReportRecord[]>
  /** Newest-first page for the admin report log (ADR-034), optionally by status. */
  listRecent(filter: ReportListFilter): Promise<ReportRecord[]>
  /** Reports one user filed (their own data export). */
  listByReporter(reporterUserId: string): Promise<ReportRecord[]>
}

export class MemoryReportRepository implements ReportRepository {
  private readonly records: ReportRecord[] = []

  create(record: ReportRecord): Promise<ReportRecord | null> {
    const duplicate = this.records.some(
      (r) => r.messageId === record.messageId && r.reporterUserId === record.reporterUserId,
    )
    if (duplicate) return Promise.resolve(null)
    this.records.push({ ...record })
    return Promise.resolve({ ...record })
  }

  listByMessage(messageId: string): Promise<ReportRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => r.messageId === messageId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => ({ ...r })),
    )
  }

  reportedMessageIds(reporterUserId: string, messageIds: string[]): Promise<Set<string>> {
    const wanted = new Set(messageIds)
    const found = new Set<string>()
    for (const r of this.records) {
      if (r.reporterUserId === reporterUserId && wanted.has(r.messageId)) found.add(r.messageId)
    }
    return Promise.resolve(found)
  }

  resolveForMessage(messageId: string): Promise<void> {
    for (const r of this.records) {
      if (r.messageId === messageId) r.status = 'resolved'
    }
    return Promise.resolve()
  }

  listAll(): Promise<ReportRecord[]> {
    return Promise.resolve(
      [...this.records]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => ({ ...r })),
    )
  }

  listRecent(filter: ReportListFilter): Promise<ReportRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => filter.status === undefined || r.status === filter.status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, filter.limit)
        .map((r) => ({ ...r })),
    )
  }

  listByReporter(reporterUserId: string): Promise<ReportRecord[]> {
    return Promise.resolve(
      this.records
        .filter((r) => r.reporterUserId === reporterUserId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => ({ ...r })),
    )
  }
}
