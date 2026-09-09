import { and, asc, eq, inArray, ne } from 'drizzle-orm'
import {
  LISTED_EVENT_STATUSES,
  type DictionaryOption,
  type EventConfig,
  type EventDetail,
  type EventSummary,
} from '@teamup/shared'
import type { Db } from '../db/client.js'
import { eventRoleOptions, eventSkillOptions, events } from '../db/schema.js'
import type { EventRepository } from './repository.js'

type EventRow = typeof events.$inferSelect
type OptionRow = typeof eventRoleOptions.$inferSelect

export const toConfig = (row: EventRow): EventConfig => ({
  slug: row.slug,
  name: row.name,
  description: row.description,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt.toISOString(),
  recruitClosesAt: row.recruitClosesAt.toISOString(),
  minMembers: row.minMembers,
  maxMembers: row.maxMembers,
  exclusiveMembership: row.exclusiveMembership,
  requiredContacts: row.requiredContacts,
  requiresAdultCheck: row.requiresAdultCheck,
  termTeam: row.termTeam,
  termMember: row.termMember,
  status: row.status,
  retentionDays: row.retentionDays,
  maxCustomTags: row.maxCustomTags,
  customTagMaxLength: row.customTagMaxLength,
})

export const toOption = (row: OptionRow): DictionaryOption => ({
  key: row.key,
  label: row.label,
  ...(row.category === null ? {} : { category: row.category }),
  sortOrder: row.sortOrder,
  isActive: row.isActive,
})

export class DbEventRepository implements EventRepository {
  constructor(private readonly db: Db) {}

  async listEvents(): Promise<EventSummary[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(inArray(events.status, [...LISTED_EVENT_STATUSES]))
      .orderBy(asc(events.startsAt))
    return rows.map((row) => {
      const c = toConfig(row)
      return {
        slug: c.slug,
        name: c.name,
        status: c.status,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        recruitClosesAt: c.recruitClosesAt,
      }
    })
  }

  async getEventBySlug(slug: string): Promise<EventDetail | null> {
    // Drafts do not exist publicly; archived events stay readable by link.
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.slug, slug), ne(events.status, 'draft')))
      .limit(1)
    const row = rows[0]
    if (!row) return null

    const [roles, skills] = await Promise.all([
      this.db
        .select()
        .from(eventRoleOptions)
        .where(and(eq(eventRoleOptions.eventId, row.id), eq(eventRoleOptions.isActive, true)))
        .orderBy(asc(eventRoleOptions.sortOrder), asc(eventRoleOptions.label)),
      this.db
        .select()
        .from(eventSkillOptions)
        .where(and(eq(eventSkillOptions.eventId, row.id), eq(eventSkillOptions.isActive, true)))
        .orderBy(asc(eventSkillOptions.sortOrder), asc(eventSkillOptions.label)),
    ])

    return {
      event: toConfig(row),
      roles: roles.map(toOption),
      skills: skills.map(toOption),
    }
  }
}
