import { asc, eq, inArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { DictionaryOption, EventSeed, EventStatus } from '@teamup/shared'
import type { Db } from '../db/client.js'
import { isUniqueViolation } from '../db/pg-errors.js'
import { eventRoleOptions, eventSkillOptions, events } from '../db/schema.js'
import { eventRowValues, upsertSeed, writeDictionaries } from '../seed/upsert.js'
import type { EventAdminRepository, StoredEvent } from './admin-repository.js'
import { toConfig, toOption } from './db-repository.js'

type EventRow = typeof events.$inferSelect
type DictionaryTable = typeof eventRoleOptions | typeof eventSkillOptions

export class DbEventAdminRepository implements EventAdminRepository {
  constructor(private readonly db: Db) {}

  /** Every option row (inactive included) of the given events, grouped by event id. */
  private async optionsByEvent(
    table: DictionaryTable,
    eventIds: string[],
  ): Promise<Map<string, DictionaryOption[]>> {
    const grouped = new Map<string, DictionaryOption[]>()
    if (eventIds.length === 0) return grouped
    const rows = await this.db
      .select()
      .from(table)
      .where(inArray(table.eventId, eventIds))
      .orderBy(asc(table.sortOrder), asc(table.label))
    for (const row of rows) {
      const list = grouped.get(row.eventId) ?? []
      list.push(toOption(row))
      grouped.set(row.eventId, list)
    }
    return grouped
  }

  private async toStored(rows: EventRow[]): Promise<StoredEvent[]> {
    const ids = rows.map((r) => r.id)
    const [roles, skills] = await Promise.all([
      this.optionsByEvent(eventRoleOptions, ids),
      this.optionsByEvent(eventSkillOptions, ids),
    ])
    return rows.map((row) => ({
      seed: {
        event: toConfig(row),
        roles: roles.get(row.id) ?? [],
        skills: skills.get(row.id) ?? [],
      },
      updatedAt: row.updatedAt.toISOString(),
    }))
  }

  async listAll(): Promise<StoredEvent[]> {
    const rows = await this.db.select().from(events).orderBy(asc(events.startsAt))
    return this.toStored(rows)
  }

  async getBySlug(slug: string): Promise<StoredEvent | null> {
    const rows = await this.db.select().from(events).where(eq(events.slug, slug)).limit(1)
    return (await this.toStored(rows))[0] ?? null
  }

  async insert(seed: EventSeed): Promise<'ok' | 'slug_taken'> {
    try {
      await this.db.transaction(async (tx) => {
        const id = uuidv7()
        await tx.insert(events).values({ id, ...eventRowValues(seed.event) })
        await writeDictionaries(tx, id, seed, 'delete')
      })
      return 'ok'
    } catch (err) {
      if (isUniqueViolation(err)) return 'slug_taken'
      throw err
    }
  }

  /** Same code path as the seed CLI, with removed keys deleted instead of deactivated. */
  async replace(seed: EventSeed): Promise<void> {
    await upsertSeed(this.db, seed, { missingKeys: 'delete' })
  }

  async setStatus(slug: string, status: EventStatus): Promise<void> {
    await this.db.update(events).set({ status, updatedAt: new Date() }).where(eq(events.slug, slug))
  }

  async delete(slug: string): Promise<void> {
    await this.db.delete(events).where(eq(events.slug, slug))
  }
}
