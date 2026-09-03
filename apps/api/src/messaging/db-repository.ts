import { and, asc, count, desc, eq, or } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { Db } from '../db/client.js'
import { isUniqueViolation } from '../db/pg-errors.js'
import { events, messageThreads, messages } from '../db/schema.js'
import {
  orderPair,
  type MessageRecord,
  type MessageRepository,
  type ThreadRecord,
  type ThreadRepository,
} from './repository.js'

type ThreadRow = typeof messageThreads.$inferSelect
type MessageRow = typeof messages.$inferSelect

const toThread = (eventSlug: string, row: ThreadRow): ThreadRecord => ({
  id: row.id,
  eventSlug,
  userAId: row.userAId,
  userBId: row.userBId,
  createdAt: row.createdAt.toISOString(),
  lastMessageAt: row.lastMessageAt.toISOString(),
})

const toMessage = (row: MessageRow): MessageRecord => ({
  id: row.id,
  threadId: row.threadId,
  senderId: row.senderId,
  bodyCiphertext: row.bodyCiphertext,
  visibility: row.visibility,
  createdAt: row.createdAt.toISOString(),
})

export class DbThreadRepository implements ThreadRepository {
  constructor(private readonly db: Db) {}

  private async eventIdBySlug(slug: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.slug, slug))
      .limit(1)
    return rows[0]?.id ?? null
  }

  async getOrCreate(eventSlug: string, userA: string, userB: string): Promise<ThreadRecord> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) throw new Error(`unknown event slug: ${eventSlug}`)
    const [a, b] = orderPair(userA, userB)

    const find = async () => {
      const rows = await this.db
        .select()
        .from(messageThreads)
        .where(
          and(
            eq(messageThreads.eventId, eventId),
            eq(messageThreads.userAId, a),
            eq(messageThreads.userBId, b),
          ),
        )
        .limit(1)
      return rows[0] ? toThread(eventSlug, rows[0]) : null
    }

    const existing = await find()
    if (existing) return existing
    try {
      const inserted = await this.db
        .insert(messageThreads)
        .values({ id: uuidv7(), eventId, userAId: a, userBId: b })
        .returning()
      return toThread(eventSlug, inserted[0]!)
    } catch (err) {
      // Lost a creation race — the winner's thread is the pair's thread.
      if (isUniqueViolation(err)) {
        const raced = await find()
        if (raced) return raced
      }
      throw err
    }
  }

  async getById(id: string): Promise<ThreadRecord | null> {
    const rows = await this.db
      .select({ thread: messageThreads, slug: events.slug })
      .from(messageThreads)
      .innerJoin(events, eq(events.id, messageThreads.eventId))
      .where(eq(messageThreads.id, id))
      .limit(1)
    return rows[0] ? toThread(rows[0].slug, rows[0].thread) : null
  }

  async listForUser(eventSlug: string, userId: string): Promise<ThreadRecord[]> {
    const rows = await this.db
      .select({ thread: messageThreads })
      .from(messageThreads)
      .innerJoin(events, eq(events.id, messageThreads.eventId))
      .where(
        and(
          eq(events.slug, eventSlug),
          or(eq(messageThreads.userAId, userId), eq(messageThreads.userBId, userId)),
        ),
      )
      .orderBy(desc(messageThreads.lastMessageAt))
    return rows.map((r) => toThread(eventSlug, r.thread))
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.db
      .update(messageThreads)
      .set({ lastMessageAt: at })
      .where(eq(messageThreads.id, id))
  }

  async deleteByEvent(eventSlug: string): Promise<void> {
    const eventId = await this.eventIdBySlug(eventSlug)
    if (!eventId) return
    await this.db.delete(messageThreads).where(eq(messageThreads.eventId, eventId))
  }
}

export class DbMessageRepository implements MessageRepository {
  constructor(private readonly db: Db) {}

  async create(record: MessageRecord): Promise<MessageRecord> {
    await this.db.insert(messages).values({
      id: record.id,
      threadId: record.threadId,
      senderId: record.senderId,
      bodyCiphertext: record.bodyCiphertext,
      visibility: record.visibility,
    })
    return record
  }

  async listForThread(threadId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt))
    return rows.map(toMessage)
  }

  async getById(id: string): Promise<MessageRecord | null> {
    const rows = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1)
    return rows[0] ? toMessage(rows[0]) : null
  }

  async updateVisibility(id: string, visibility: MessageRecord['visibility']): Promise<void> {
    await this.db.update(messages).set({ visibility }).where(eq(messages.id, id))
  }

  async listPending(): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.visibility, 'pending_review'))
      .orderBy(asc(messages.createdAt))
    return rows.map(toMessage)
  }

  async listBySender(senderId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.senderId, senderId))
      .orderBy(asc(messages.createdAt))
    return rows.map(toMessage)
  }

  async count(): Promise<number> {
    const rows = await this.db.select({ n: count() }).from(messages)
    return Number(rows[0]?.n ?? 0)
  }
}

