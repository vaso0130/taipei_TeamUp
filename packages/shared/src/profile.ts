import { z } from 'zod'
import { SCHEMA_LIMITS } from './event-config.js'
import { multiLineText, singleLineText } from './text.js'

/** Participation intent within one event. */
export const PARTICIPANT_INTENTS = ['looking_for_team', 'has_team', 'browsing'] as const
export type ParticipantIntent = (typeof PARTICIPANT_INTENTS)[number]

/** Moderation-driven visibility of user-generated text. */
export const CONTENT_VISIBILITIES = ['pending_review', 'published', 'blocked'] as const
export type ContentVisibility = (typeof CONTENT_VISIBILITIES)[number]

/** Nickname: 1–30 chars, no control characters, not only whitespace. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1, '暱稱不可空白')
  .max(30, '暱稱最多 30 字')
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), '暱稱含有不允許的字元')

export const UpdateMeSchema = z.object({
  displayName: DisplayNameSchema,
})
export type UpdateMeInput = z.infer<typeof UpdateMeSchema>

/**
 * Per-event profile ("what I bring to this event"). Role and skill keys
 * are validated against the event's dictionaries server-side.
 */
export const ParticipationInputSchema = z.object({
  intent: z.enum(PARTICIPANT_INTENTS),
  preferredRoles: z.array(z.string().max(50)).max(SCHEMA_LIMITS.maxDictionaryOptions).default([]),
  skills: z.array(z.string().max(50)).max(SCHEMA_LIMITS.maxDictionaryOptions).default([]),
  /** Free text — goes through moderation before becoming public. */
  blurb: multiLineText(500).default(''),
  /**
   * Free-form tags; the schema ceiling equals the event-config ceiling
   * (SCHEMA_LIMITS), the service enforces the event's own
   * maxCustomTags / customTagMaxLength.
   */
  customTags: z
    .array(singleLineText(SCHEMA_LIMITS.maxCustomTagLength, 1))
    .max(SCHEMA_LIMITS.maxCustomTags)
    .default([]),
  /**
   * Only asked (and required) when the event has requiresAdultCheck.
   * We never store a birth date — a single boolean only (spec §6.3).
   */
  isAdult: z.boolean().optional(),
  /** Self-declared confirmation; the platform never stores the consent form. */
  guardianConsentConfirmed: z.boolean().default(false),
})
export type ParticipationInput = z.infer<typeof ParticipationInputSchema>

/** What the API returns about the caller. */
export interface MeView {
  /** The caller's own user id (needed client-side for self-row checks). */
  userId: string
  displayName: string
  /** Masked, display-only hint such as "w***@gmail.com" — never the full email. */
  emailHint: string
  status: 'active' | 'suspended' | 'deleted'
  /** Set by the route layer from the configured admin allowlist. */
  isAdmin?: boolean
}

export interface ParticipationView {
  eventSlug: string
  intent: ParticipantIntent
  preferredRoles: string[]
  skills: string[]
  blurb: string
  customTags: string[]
  blurbVisibility: ContentVisibility
  isAdult: boolean | null
  guardianConsentConfirmed: boolean
}
