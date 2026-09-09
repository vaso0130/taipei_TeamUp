import { lte } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Db } from '../db/client.js'
import { auditLogs } from '../db/schema.js'

export type AuditAction =
  | 'data_export'
  | 'account_delete'
  | 'admin_review_read'
  | 'moderation_decide'
  | 'message_report'
  | 'content_report'
  | 'admin_reactivate'
  | 'admin_suspend'
  | 'admin_team_delete'

export interface AuditEntry {
  id: string
  actorUserId: string | null
  action: AuditAction
  targetType: string
  targetId: string
  detail: string
  createdAt: string
}

export interface AuditLogRepository {
  create(entry: AuditEntry): Promise<void>
  /** Retention (spec §4): purge entries older than the cutoff. */
  purgeBefore(cutoff: Date): Promise<number>
}

export class MemoryAuditLogRepository implements AuditLogRepository {
  readonly entries: AuditEntry[] = []

  create(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry })
    return Promise.resolve()
  }

  purgeBefore(cutoff: Date): Promise<number> {
    const keep = this.entries.filter((e) => new Date(e.createdAt) > cutoff)
    const purged = this.entries.length - keep.length
    this.entries.length = 0
    this.entries.push(...keep)
    return Promise.resolve(purged)
  }
}

export class DbAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: Db) {}

  async create(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values({
      id: entry.id,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      detail: entry.detail,
    })
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const purged = await this.db
      .delete(auditLogs)
      .where(lte(auditLogs.createdAt, cutoff))
      .returning({ id: auditLogs.id })
    return purged.length
  }
}

export interface AuditFields {
  actorUserId?: string | null
  targetType?: string
  targetId?: string
  detail?: string
}

/**
 * Convenience writer with two failure modes:
 * - `log`: fail-open — a broken audit store must never break a person's
 *   own action (export, deletion, report).
 * - `logOrThrow`: fail-closed — an administrator's decrypting read is
 *   refused unless the trail is written first (擋比較嚴).
 */
export class AuditLogger {
  constructor(private readonly repo: AuditLogRepository) {}

  async log(action: AuditAction, fields: AuditFields): Promise<void> {
    try {
      await this.logOrThrow(action, fields)
    } catch (err) {
      console.error(
        'audit log write failed',
        err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error',
      )
    }
  }

  async logOrThrow(action: AuditAction, fields: AuditFields): Promise<void> {
    await this.repo.create({
      id: uuidv7(),
      actorUserId: fields.actorUserId ?? null,
      action,
      targetType: fields.targetType ?? '',
      targetId: fields.targetId ?? '',
      detail: fields.detail ?? '',
      createdAt: new Date().toISOString(),
    })
  }
}
