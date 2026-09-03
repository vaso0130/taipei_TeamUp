import { uuidv7 } from 'uuidv7'
import type { ContentVisibility, MessageView, ReportReason, ThreadView } from '@teamup/shared'
import type { ApplicationRepository } from '../applications/repository.js'
import type { AuditLogger } from '../audit/log.js'
import type { FieldCipher } from '../crypto/envelope.js'
import type { EventRepository } from '../events/repository.js'
import type { ModerationQueue, ModerationService } from '../moderation/service.js'
import type { ReportRepository } from '../reports/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { UserRepository } from '../users/repository.js'
import type {
  MessageRepository,
  ThreadRecord,
  ThreadRepository,
} from './repository.js'

export type MessagingErrorCode =
  | 'event_not_found'
  | 'thread_not_found'
  | 'message_not_found'
  | 'user_not_found'
  | 'not_allowed'
  | 'cannot_message_self'
  | 'cannot_report_own'
  | 'already_reported'
  | 'forbidden'

export class MessagingError extends Error {
  constructor(public readonly code: MessagingErrorCode) {
    super(code)
    this.name = 'MessagingError'
  }
}

export class MessagingService {
  constructor(
    private readonly events: EventRepository,
    private readonly teams: TeamRepository,
    private readonly applications: ApplicationRepository,
    private readonly users: UserRepository,
    private readonly threads: ThreadRepository,
    private readonly messages: MessageRepository,
    private readonly cipher: FieldCipher,
    private readonly moderation: ModerationService,
    private readonly moderationQueue: ModerationQueue,
    private readonly reports?: ReportRepository,
    private readonly audit?: AuditLogger,
  ) {}

  /**
   * Strangers can never DM each other (spec §8): messaging requires a
   * shared active team or a live application/invite between the two.
   * Checked on every send, not just on thread creation.
   */
  private async canMessage(eventSlug: string, userA: string, userB: string): Promise<boolean> {
    const [teamsA, teamsB] = await Promise.all([
      this.teams.activeTeamIdsOf(eventSlug, userA),
      this.teams.activeTeamIdsOf(eventSlug, userB),
    ])
    const setB = new Set(teamsB)
    if (teamsA.some((id) => setB.has(id))) return true
    return this.applications.hasActiveRelationship(eventSlug, userA, userB)
  }

  async startThread(
    eventSlug: string,
    fromUserId: string,
    toUserId: string,
    body: string,
  ): Promise<{ thread: ThreadView; message: MessageView }> {
    if (fromUserId === toUserId) throw new MessagingError('cannot_message_self')
    if (!(await this.events.getEventBySlug(eventSlug))) throw new MessagingError('event_not_found')
    const recipient = await this.users.findById(toUserId)
    if (!recipient || recipient.status !== 'active') throw new MessagingError('user_not_found')
    if (!(await this.canMessage(eventSlug, fromUserId, toUserId))) {
      throw new MessagingError('not_allowed')
    }
    const thread = await this.threads.getOrCreate(eventSlug, fromUserId, toUserId)
    const message = await this.appendMessage(thread, fromUserId, body)
    return { thread: await this.toThreadView(thread, fromUserId), message }
  }

  async send(threadId: string, senderId: string, body: string): Promise<MessageView> {
    const thread = await this.requireParticipant(threadId, senderId)
    const other = thread.userAId === senderId ? thread.userBId : thread.userAId
    if (!(await this.canMessage(thread.eventSlug, senderId, other))) {
      throw new MessagingError('not_allowed')
    }
    return this.appendMessage(thread, senderId, body)
  }

  async listThreads(eventSlug: string, userId: string): Promise<ThreadView[]> {
    const records = await this.threads.listForUser(eventSlug, userId)
    return Promise.all(records.map((t) => this.toThreadView(t, userId)))
  }

  async listMessages(threadId: string, viewerId: string): Promise<MessageView[]> {
    const thread = await this.requireParticipant(threadId, viewerId)
    const otherUserId = thread.userAId === viewerId ? thread.userBId : thread.userAId
    const other = await this.users.findById(otherUserId)
    // A deleted account's messages disappear for the counterpart (DoD).
    const otherErased = !other || other.status === 'deleted'
    const records = await this.messages.listForThread(thread.id)
    const reported =
      (await this.reports?.reportedMessageIds(
        viewerId,
        records.map((m) => m.id),
      )) ?? new Set<string>()
    return Promise.all(
      records.map(async (m) => {
        const mine = m.senderId === viewerId
        // Sender always sees their own text; the counterpart only after
        // moderation publishes it. Blocked content is shown to no one.
        const readable = mine
          ? m.visibility !== 'blocked'
          : m.visibility === 'published' && !otherErased
        return {
          id: m.id,
          senderId: m.senderId,
          mine,
          body: readable ? await this.cipher.decrypt(m.bodyCiphertext) : null,
          visibility: m.visibility,
          createdAt: m.createdAt,
          reportedByMe: reported.has(m.id),
        }
      }),
    )
  }

  async getThread(threadId: string, viewerId: string): Promise<ThreadView> {
    const thread = await this.requireParticipant(threadId, viewerId)
    return this.toThreadView(thread, viewerId)
  }

  private async requireParticipant(threadId: string, userId: string): Promise<ThreadRecord> {
    const thread = await this.threads.getById(threadId)
    if (!thread) throw new MessagingError('thread_not_found')
    if (thread.userAId !== userId && thread.userBId !== userId) {
      throw new MessagingError('forbidden')
    }
    return thread
  }

  private async appendMessage(
    thread: ThreadRecord,
    senderId: string,
    body: string,
  ): Promise<MessageView> {
    const trimmed = body.trim()
    const now = new Date()
    // Stored hidden first; moderation decides the final visibility.
    const record = await this.messages.create({
      id: uuidv7(),
      threadId: thread.id,
      senderId,
      bodyCiphertext: await this.cipher.encrypt(trimmed),
      visibility: 'pending_review',
      createdAt: now.toISOString(),
    })
    await this.threads.touch(thread.id, now)

    // Messages are latency-sensitive (spec §5.2): one synchronous
    // moderation attempt; on any failure fall back to the async queue.
    // Either way the message is never published without a verdict.
    let visibility: ContentVisibility = 'pending_review'
    try {
      visibility = await this.moderation.processSync({ type: 'message', messageId: record.id })
    } catch {
      await this.moderationQueue.enqueue({ type: 'message', messageId: record.id })
      visibility = (await this.messages.getById(record.id))?.visibility ?? 'pending_review'
    }

    return {
      id: record.id,
      senderId,
      mine: true,
      body: visibility === 'blocked' ? null : trimmed,
      visibility,
      createdAt: record.createdAt,
      reportedByMe: false,
    }
  }

  /**
   * Report a counterpart's message. The message is hidden immediately
   * (擋比較嚴 — in a 1:1 thread only the reporter sees it anyway) and
   * queued for the escalation moderator's re-review.
   */
  async report(messageId: string, reporterId: string, reason: ReportReason): Promise<void> {
    if (!this.reports) throw new MessagingError('not_allowed')
    const message = await this.messages.getById(messageId)
    if (!message) throw new MessagingError('message_not_found')
    await this.requireParticipant(message.threadId, reporterId)
    if (message.senderId === reporterId) throw new MessagingError('cannot_report_own')

    const created = await this.reports.create({
      id: uuidv7(),
      messageId,
      reporterUserId: reporterId,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    if (!created) throw new MessagingError('already_reported')

    if (message.visibility === 'published') {
      await this.messages.updateVisibility(messageId, 'pending_review')
    }
    await this.moderationQueue.enqueue({ type: 'reported_message', messageId })
    // The report reason is an enum — safe to audit verbatim.
    await this.audit?.log('message_report', {
      actorUserId: reporterId,
      targetType: 'message',
      targetId: messageId,
      detail: reason,
    })
  }

  private async toThreadView(thread: ThreadRecord, viewerId: string): Promise<ThreadView> {
    const otherUserId = thread.userAId === viewerId ? thread.userBId : thread.userAId
    const other = await this.users.findById(otherUserId)
    return {
      id: thread.id,
      otherUserId,
      otherDisplayName: other?.displayName ?? '（帳號已刪除）',
      createdAt: thread.createdAt,
      lastMessageAt: thread.lastMessageAt,
    }
  }
}
