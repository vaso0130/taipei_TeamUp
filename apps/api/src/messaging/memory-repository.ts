import { uuidv7 } from 'uuidv7'
import {
  orderPair,
  type MessageRecord,
  type MessageRepository,
  type ThreadRecord,
  type ThreadRepository,
} from './repository.js'

export class MemoryThreadRepository implements ThreadRepository {
  private readonly threads = new Map<string, ThreadRecord>()

  getOrCreate(eventSlug: string, userA: string, userB: string): Promise<ThreadRecord> {
    const [a, b] = orderPair(userA, userB)
    for (const thread of this.threads.values()) {
      if (thread.eventSlug === eventSlug && thread.userAId === a && thread.userBId === b) {
        return Promise.resolve({ ...thread })
      }
    }
    const now = new Date().toISOString()
    const record: ThreadRecord = {
      id: uuidv7(),
      eventSlug,
      userAId: a,
      userBId: b,
      createdAt: now,
      lastMessageAt: now,
    }
    this.threads.set(record.id, record)
    return Promise.resolve({ ...record })
  }

  getById(id: string): Promise<ThreadRecord | null> {
    const record = this.threads.get(id)
    return Promise.resolve(record ? { ...record } : null)
  }

  listForUser(eventSlug: string, userId: string): Promise<ThreadRecord[]> {
    const result = [...this.threads.values()]
      .filter(
        (t) => t.eventSlug === eventSlug && (t.userAId === userId || t.userBId === userId),
      )
      .sort((x, y) => y.lastMessageAt.localeCompare(x.lastMessageAt))
      .map((t) => ({ ...t }))
    return Promise.resolve(result)
  }

  touch(id: string, at: Date): Promise<void> {
    const record = this.threads.get(id)
    if (record) record.lastMessageAt = at.toISOString()
    return Promise.resolve()
  }

  deleteByEvent(eventSlug: string): Promise<void> {
    for (const [id, record] of this.threads) {
      if (record.eventSlug === eventSlug) this.threads.delete(id)
    }
    return Promise.resolve()
  }
}

export class MemoryMessageRepository implements MessageRepository {
  private readonly records: MessageRecord[] = []

  create(record: MessageRecord): Promise<MessageRecord> {
    this.records.push({ ...record })
    return Promise.resolve({ ...record })
  }

  listForThread(threadId: string): Promise<MessageRecord[]> {
    return Promise.resolve(
      this.records
        .filter((m) => m.threadId === threadId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((m) => ({ ...m })),
    )
  }

  getById(id: string): Promise<MessageRecord | null> {
    const record = this.records.find((m) => m.id === id)
    return Promise.resolve(record ? { ...record } : null)
  }

  updateVisibility(id: string, visibility: MessageRecord['visibility']): Promise<void> {
    const record = this.records.find((m) => m.id === id)
    if (record) record.visibility = visibility
    return Promise.resolve()
  }

  listPending(): Promise<MessageRecord[]> {
    return Promise.resolve(
      this.records.filter((m) => m.visibility === 'pending_review').map((m) => ({ ...m })),
    )
  }

  listBySender(senderId: string): Promise<MessageRecord[]> {
    return Promise.resolve(
      this.records
        .filter((m) => m.senderId === senderId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((m) => ({ ...m })),
    )
  }

  count(): Promise<number> {
    return Promise.resolve(this.records.length)
  }
}
