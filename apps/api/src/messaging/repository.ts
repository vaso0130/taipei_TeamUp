import type { ContentVisibility } from '@teamup/shared'

export interface ThreadRecord {
  id: string
  eventSlug: string
  /** Normalized: userAId < userBId — one thread per pair per event. */
  userAId: string
  userBId: string
  createdAt: string
  lastMessageAt: string
}

export interface MessageRecord {
  id: string
  threadId: string
  senderId: string
  bodyCiphertext: Buffer
  visibility: ContentVisibility
  createdAt: string
}

/** Stable pair ordering shared by every implementation. */
export const orderPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

export interface ThreadRepository {
  /** Find or create the unique thread for this pair within the event. */
  getOrCreate(eventSlug: string, userA: string, userB: string): Promise<ThreadRecord>
  getById(id: string): Promise<ThreadRecord | null>
  listForUser(eventSlug: string, userId: string): Promise<ThreadRecord[]>
  touch(id: string, at: Date): Promise<void>
  /** Retention cleanup: purge all threads of an event (messages cascade). */
  deleteByEvent(eventSlug: string): Promise<void>
}

export interface MessageRepository {
  create(record: MessageRecord): Promise<MessageRecord>
  /** Ascending by creation time. */
  listForThread(threadId: string): Promise<MessageRecord[]>
  getById(id: string): Promise<MessageRecord | null>
  updateVisibility(id: string, visibility: ContentVisibility): Promise<void>
  /** Messages still awaiting moderation (the review queue). */
  listPending(): Promise<MessageRecord[]>
  /** Data export: everything the user has written. */
  listBySender(senderId: string): Promise<MessageRecord[]>
  /** Admin dashboard: total stored messages. */
  count(): Promise<number>
}
