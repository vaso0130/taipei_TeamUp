import { z } from 'zod'
import {
  EVENT_STATUSES,
  EventSeedSchema,
  EventSlugSchema,
  type EventSeed,
  type EventStatus,
} from './event-config.js'

/**
 * Admin event management (design spec docs/design/admin-events.md §8).
 * The form and the seed JSON are two entry points to the same data: every
 * write goes through EventSeedSchema, so the editor can never produce a
 * configuration the seed CLI would refuse, and vice versa.
 */

/** Error codes the admin event endpoints return besides `validation_failed`. */
export const ADMIN_EVENT_ERRORS = {
  eventNotFound: 'event_not_found',
  slugTaken: 'slug_taken',
  slugImmutable: 'slug_immutable',
  maxMembersBelowExisting: 'max_members_below_existing',
  minMembersAboveExisting: 'min_members_above_existing',
  dictionaryKeyInUse: 'dictionary_key_in_use',
  invalidStatusTransition: 'invalid_status_transition',
  cannotOpenIncomplete: 'cannot_open_incomplete',
  eventNotEmpty: 'event_not_empty',
} as const
export type AdminEventErrorCode = (typeof ADMIN_EVENT_ERRORS)[keyof typeof ADMIN_EVENT_ERRORS]

/**
 * Allowed status transitions (spec §6). Everything else — including a
 * no-op "same status" request — is `invalid_status_transition`.
 */
export const EVENT_STATUS_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ['open'],
  open: ['closed'],
  closed: ['open', 'archived'],
  archived: [],
}

/** `POST /api/admin/events` — a new event is always a draft. */
export const CreateEventInputSchema = EventSeedSchema.superRefine((seed, ctx) => {
  if (seed.event.status !== 'draft') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '新活動必須是草稿',
      path: ['event', 'status'],
    })
  }
})
export type CreateEventInput = z.infer<typeof CreateEventInputSchema>

/** `PUT /api/admin/events/:slug` — the whole seed; `event.status` is ignored. */
export const UpdateEventInputSchema = EventSeedSchema
export type UpdateEventInput = z.infer<typeof UpdateEventInputSchema>

/** `POST /api/admin/events/:slug/status`. */
export const AdminEventStatusInputSchema = z.object({
  status: z.enum(EVENT_STATUSES),
})
export type AdminEventStatusInput = z.infer<typeof AdminEventStatusInputSchema>

/** `POST /api/admin/events/:slug/duplicate` — the copy's identity; everything else is cloned. */
export const DuplicateEventInputSchema = z.object({
  slug: EventSlugSchema,
  name: z.string().trim().min(1).max(100),
})
export type DuplicateEventInput = z.infer<typeof DuplicateEventInputSchema>

/** `GET /api/admin/events` row (every status, drafts and archived included). */
export interface AdminEventSummary {
  slug: string
  name: string
  status: EventStatus
  startsAt: string
  endsAt: string
  recruitClosesAt: string
  termTeam: string
  counts: { teams: number; participants: number }
  updatedAt: string
}

/** How many participants + teams currently reference each dictionary key. */
export interface AdminEventUsage {
  roles: Record<string, number>
  skills: Record<string, number>
}

/** Team-size facts the member-limit guardrails are checked against (0 when there are no teams). */
export interface AdminEventStats {
  teams: number
  participants: number
  largestTeam: number
  smallestTeam: number
}

/** `GET /api/admin/events/:slug` — seed with inactive options included. */
export interface AdminEventDetail {
  seed: EventSeed
  usage: AdminEventUsage
  stats: AdminEventStats
}

/**
 * `GET /api/admin/events/templates` entry: a repo seed file turned into a
 * starting point — slug cleared, status draft. Not schema-valid until the
 * editor fills in a slug.
 */
export interface EventTemplate {
  key: string
  name: string
  description: string
  seed: EventSeed
}

export interface AdminEventUpdateResult {
  seed: EventSeed
  /** Non-blocking observations about the saved configuration (繁中). */
  warnings: string[]
}
