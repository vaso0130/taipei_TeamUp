import { and, count, eq, ne, or, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Db } from '../db/client.js'
import { eventParticipants, events } from '../db/schema.js'
import type { ParticipantRepository, ParticipationRecord } from './repository.js'

type ParticipantRow = typeof eventParticipants.$inferSelect

const toRecord = (eventSlug: string, row: ParticipantRow): ParticipationRecord => ({
  eventSlug,
  userId: row.userId,
  intent: row.intent,
  preferredRoles: row.preferredRoles,
  skills: row.skills,
  blurb: row.blurb,
  customTags: row.customTags,
  blurbVisibility: row.blurbVisibility,
  isAdult: row.isAdult,
  guardianConsentConfirmed: row.guardianConsentConfirmed,
})

export class DbParticipantRepository implements ParticipantRepository {
  constructor(private readonly db: Db) {}

  private async eventIdBySlug(slug: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, slug))
      .limit(1)
    return rows[0]?.id ?? null
  }

  async get(eventSlug: string, userId: string): Promise<ParticipationRecord | null> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return null
    const rows = await this.db
      .select()
      .from(eventParticipants)
      .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, userId)))
      .limit(1)
    return rows[0] ? toRecord(eventSlug, rows[0]) : null
  }

  async updateBlurbVisibility(
    eventSlug: string,
    userId: string,
    visibility: ParticipationRecord['blurbVisibility'],
  ): Promise<void> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return
    await this.db
      .update(eventParticipants)
      .set({ blurbVisibility: visibility, updatedAt: new Date() })
      .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.userId, userId)))
  }

  async listPendingBlurbs(): Promise<ParticipationRecord[]> {
    const rows = await this.db
      .select({ participant: eventParticipants, slug: events.slug })
      .from(eventParticipants)
      .innerJoin(events, eq(events.id, eventParticipants.eventId))
      .where(
        and(
          eq(eventParticipants.blurbVisibility, 'pending_review'),
          or(
            ne(eventParticipants.blurb, ''),
            ne(eventParticipants.customTags, sql`'{}'::text[]`),
          ),
        ),
      )
    return rows.map((r) => toRecord(r.slug, r.participant))
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.db.delete(eventParticipants).where(eq(eventParticipants.userId, userId))
  }

  async deleteByEvent(eventSlug: string): Promise<void> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return
    await this.db.delete(eventParticipants).where(eq(eventParticipants.eventId, eventId))
  }

  async listLookingForTeam(eventSlug: string): Promise<ParticipationRecord[]> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return []
    const rows = await this.db
      .select()
      .from(eventParticipants)
      .where(
        and(
          eq(eventParticipants.eventId, eventId),
          eq(eventParticipants.intent, 'looking_for_team'),
        ),
      )
    return rows.map((row) => toRecord(eventSlug, row))
  }

  async listByEvent(eventSlug: string): Promise<ParticipationRecord[]> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return []
    const rows = await this.db
      .select()
      .from(eventParticipants)
      .where(eq(eventParticipants.eventId, eventId))
    return rows.map((row) => toRecord(eventSlug, row))
  }

  async countByIntent(eventSlug: string): Promise<Record<string, number>> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return {}
    const rows = await this.db
      .select({ intent: eventParticipants.intent, n: count() })
      .from(eventParticipants)
      .where(eq(eventParticipants.eventId, eventId))
      .groupBy(eventParticipants.intent)
    return Object.fromEntries(rows.map((r) => [r.intent, Number(r.n)]))
  }

  async upsert(record: ParticipationRecord): Promise<ParticipationRecord> {
    const eventId = await this.eventIdBySlug(record.eventSlug)
    if (!eventId) throw new Error(`unknown event slug: ${record.eventSlug}`)

    const values = {
      intent: record.intent,
      preferredRoles: record.preferredRoles,
      skills: record.skills,
      blurb: record.blurb,
      customTags: record.customTags,
      blurbVisibility: record.blurbVisibility,
      isAdult: record.isAdult,
      guardianConsentConfirmed: record.guardianConsentConfirmed,
      updatedAt: new Date(),
    }
    await this.db
      .insert(eventParticipants)
      .values({ id: uuidv7(), eventId, userId: record.userId, ...values })
      .onConflictDoUpdate({
        target: [eventParticipants.eventId, eventParticipants.userId],
        set: values,
      })
    return record
  }
}
