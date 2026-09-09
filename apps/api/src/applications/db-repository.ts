import { and, asc, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm'
import type { ApplicationStatus } from '@teamup/shared'
import type { Db } from '../db/client.js'
import { isUniqueViolation } from '../db/pg-errors.js'
import { applications, events, teams } from '../db/schema.js'
import {
  DuplicatePendingError,
  type ApplicationRecord,
  type ApplicationRepository,
} from './repository.js'

type ApplicationRow = typeof applications.$inferSelect

const toRecord = (row: ApplicationRow): ApplicationRecord => ({
  id: row.id,
  teamId: row.teamId,
  applicantId: row.applicantId,
  direction: row.direction,
  messageCiphertext: row.messageCiphertext,
  messageVisibility: row.messageVisibility,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
})

export class DbApplicationRepository implements ApplicationRepository {
  constructor(private readonly db: Db) {}

  async create(record: ApplicationRecord): Promise<ApplicationRecord> {
    try {
      await this.db.insert(applications).values({
        id: record.id,
        teamId: record.teamId,
        applicantId: record.applicantId,
        direction: record.direction,
        messageCiphertext: record.messageCiphertext,
        messageVisibility: record.messageVisibility,
        status: record.status,
      })
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicatePendingError()
      }
      throw err
    }
    return record
  }

  async getById(id: string): Promise<ApplicationRecord | null> {
    const rows = await this.db.select().from(applications).where(eq(applications.id, id)).limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async listForTeam(teamId: string, status?: ApplicationStatus): Promise<ApplicationRecord[]> {
    const conditions = [eq(applications.teamId, teamId)]
    if (status) conditions.push(eq(applications.status, status))
    const rows = await this.db
      .select()
      .from(applications)
      .where(and(...conditions))
      .orderBy(asc(applications.createdAt))
    return rows.map(toRecord)
  }

  async listForUser(eventSlug: string, userId: string): Promise<ApplicationRecord[]> {
    const rows = await this.db
      .select({ application: applications })
      .from(applications)
      .innerJoin(teams, eq(teams.id, applications.teamId))
      .innerJoin(events, eq(events.id, teams.eventId))
      .where(and(eq(applications.applicantId, userId), eq(events.slug, eventSlug)))
      .orderBy(desc(applications.createdAt))
    return rows.map((r) => toRecord(r.application))
  }

  async hasActiveRelationship(eventSlug: string, userA: string, userB: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: applications.id })
      .from(applications)
      .innerJoin(teams, eq(teams.id, applications.teamId))
      .innerJoin(events, eq(events.id, teams.eventId))
      .where(
        and(
          eq(events.slug, eventSlug),
          eq(applications.status, 'pending'),
          or(
            and(eq(applications.applicantId, userA), eq(teams.ownerUserId, userB)),
            and(eq(applications.applicantId, userB), eq(teams.ownerUserId, userA)),
          ),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async updateMessageVisibility(
    id: string,
    visibility: ApplicationRecord['messageVisibility'],
  ): Promise<void> {
    await this.db
      .update(applications)
      .set({ messageVisibility: visibility })
      .where(eq(applications.id, id))
  }

  async listPendingMessages(): Promise<ApplicationRecord[]> {
    const rows = await this.db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.messageVisibility, 'pending_review'),
          isNotNull(applications.messageCiphertext),
        ),
      )
    return rows.map(toRecord)
  }

  async updateStatus(
    id: string,
    status: ApplicationStatus,
    from: ApplicationStatus = 'pending',
  ): Promise<boolean> {
    const updated = await this.db
      .update(applications)
      .set({ status, decidedAt: new Date() })
      .where(and(eq(applications.id, id), eq(applications.status, from)))
      .returning({ id: applications.id })
    return updated.length > 0
  }

  async withdrawPendingForUser(
    eventSlug: string,
    userId: string,
    exceptTeamId: string,
  ): Promise<void> {
    const teamIds = this.db
      .select({ id: teams.id })
      .from(teams)
      .innerJoin(events, eq(events.id, teams.eventId))
      .where(eq(events.slug, eventSlug))
    await this.db
      .update(applications)
      .set({ status: 'withdrawn', decidedAt: new Date() })
      .where(
        and(
          eq(applications.applicantId, userId),
          eq(applications.status, 'pending'),
          ne(applications.teamId, exceptTeamId),
          inArray(applications.teamId, teamIds),
        ),
      )
  }
}
