import { z } from 'zod'
import type { ContentVisibility } from './profile.js'

export const SendMessageSchema = z.object({
  body: z.string().trim().min(1, '訊息不可空白').max(1000, '訊息最多 1000 字'),
})
export type SendMessageInput = z.infer<typeof SendMessageSchema>

export const StartThreadSchema = z.object({
  toUserId: z.string().uuid(),
  body: z.string().trim().min(1, '訊息不可空白').max(1000, '訊息最多 1000 字'),
})
export type StartThreadInput = z.infer<typeof StartThreadSchema>

export interface ThreadView {
  id: string
  otherUserId: string
  otherDisplayName: string
  createdAt: string
  lastMessageAt: string
}

export const REPORT_REASONS = ['scam', 'harassment', 'spam', 'other'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

export const ReportMessageSchema = z.object({
  reason: z.enum(REPORT_REASONS),
})
export type ReportMessageInput = z.infer<typeof ReportMessageSchema>

export interface MessageView {
  id: string
  senderId: string
  /** True when the requesting viewer sent this message. */
  mine: boolean
  /**
   * Senders always see their own text; the counterpart sees null until
   * moderation publishes it (spec §5.1).
   */
  body: string | null
  visibility: ContentVisibility
  createdAt: string
  /** True when the requesting viewer has already reported this message. */
  reportedByMe: boolean
}
