import { z } from 'zod'
import type { ContentVisibility } from './profile.js'

/** Addressing for moderation tasks and admin decisions. */
export const ModerationTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('participant_blurb'),
    eventSlug: z.string(),
    userId: z.string().uuid(),
  }),
  z.object({ type: z.literal('team_pitch'), teamId: z.string().uuid() }),
  z.object({ type: z.literal('application_message'), applicationId: z.string().uuid() }),
  z.object({ type: z.literal('message'), messageId: z.string().uuid() }),
  /**
   * A user-reported message: reviewed asynchronously by the escalation
   * moderator (a stronger model) instead of the default pipeline.
   */
  z.object({ type: z.literal('reported_message'), messageId: z.string().uuid() }),
  /** A user-reported team: name + pitch re-reviewed by escalation. */
  z.object({ type: z.literal('reported_team_pitch'), teamId: z.string().uuid() }),
  /** A user-reported participant: nickname + blurb + tags re-reviewed. */
  z.object({
    type: z.literal('reported_blurb'),
    eventSlug: z.string(),
    userId: z.string().uuid(),
  }),
])
export type ModerationTargetInput = z.infer<typeof ModerationTargetSchema>

export const AdminDecideSchema = z.object({
  target: ModerationTargetSchema,
  action: z.enum(['approve', 'block']),
})
export type AdminDecideInput = z.infer<typeof AdminDecideSchema>

export const ModerationTaskSchema = z.object({
  target: ModerationTargetSchema,
})

/** One entry in the human review queue (admin backend, spec §5.7). */
export interface PendingModerationItem {
  target: ModerationTargetInput
  /** Decrypted/raw content shown to the reviewing admin only. */
  content: string
  authorDisplayName: string
  visibility: ContentVisibility
  /**
   * Why the item landed here: the latest automatic verdict, or null
   * when it is still waiting for its first automatic review.
   */
  verdict: {
    riskLevel: 'low' | 'medium' | 'high'
    categories: string[]
    rationale: string
    decidedAt: string
  } | null
  /** Thread of a message target, so the reviewer can open the context. */
  threadId: string | null
}

/**
 * Admin risk overview row: message metadata + latest verdict, WITHOUT
 * the message text — content decrypts only in the thread view, where
 * every read is audit-logged.
 */
export interface RiskMessageItem {
  messageId: string
  threadId: string
  senderId: string
  senderDisplayName: string
  visibility: ContentVisibility
  riskLevel: 'low' | 'medium' | 'high'
  categories: string[]
  rationale: string
  decidedBy: string
  modelId: string
  /** Published as low risk but marked for an after-the-fact look. */
  flagged: boolean
  reportCount: number
  reportReasons: string[]
  messageCreatedAt: string
  decidedAt: string
}

export interface AdminThreadMessage {
  id: string
  senderId: string
  senderDisplayName: string
  /** Decrypted body — admin thread review only. */
  body: string
  visibility: ContentVisibility
  createdAt: string
  riskLevel: 'low' | 'medium' | 'high' | null
  flagged: boolean
  reportCount: number
}

export interface AdminThreadDetail {
  id: string
  eventSlug: string
  participants: { userId: string; displayName: string; status: string }[]
  messages: AdminThreadMessage[]
}

/** Platform overview numbers for the admin dashboard. */
export interface AdminStats {
  users: { total: number; active: number; suspended: number; deleted: number }
  participants: {
    total: number
    /** Keyed by participant intent (looking_for_team / has_team / browsing). */
    byIntent: Record<string, number>
  }
  /** Accounts that exist but never joined this event. */
  registeredWithoutParticipation: number
  teams: {
    total: number
    /** Keyed by team status (recruiting / full / closed). */
    byStatus: Record<string, number>
    /** Active memberships across all teams. */
    membersInTeams: number
  }
  messages: { total: number }
}

/**
 * Admin member roster row — metadata only, by design: display name and
 * counters, never email or content (data minimization).
 */
export interface AdminUserItem {
  userId: string
  displayName: string
  status: string
  createdAt: string | null
  /** Participant intent in the viewed event; null = not participating. */
  intent: string | null
  teamId: string | null
  teamName: string | null
  highCount: number
  mediumCount: number
}

/** Admin team roster row (metadata + public team fields). */
export interface AdminTeamItem {
  id: string
  name: string
  status: string
  memberCount: number
  ownerUserId: string
  ownerDisplayName: string
  createdAt: string
}

/** A user's moderation history (strike view). */
export interface UserModerationHistory {
  userId: string
  displayName: string
  status: string
  records: {
    targetType: string
    riskLevel: 'low' | 'medium' | 'high'
    categories: string[]
    rationale: string
    decidedBy: string
    flagged: boolean
    createdAt: string
  }[]
}
