import type { ContentVisibility, ParticipantIntent } from '@teamup/shared'

export interface ParticipationRecord {
  eventSlug: string
  userId: string
  intent: ParticipantIntent
  preferredRoles: string[]
  skills: string[]
  blurb: string
  /** Free-form tags; blurbVisibility governs these too. */
  customTags: string[]
  blurbVisibility: ContentVisibility
  /** null = the event never asked (requiresAdultCheck = false). */
  isAdult: boolean | null
  guardianConsentConfirmed: boolean
  /** Last write — drives the stale-review re-queue; set by the repository. */
  updatedAt?: string
}

export interface ParticipantRepository {
  get(eventSlug: string, userId: string): Promise<ParticipationRecord | null>
  upsert(record: ParticipationRecord): Promise<ParticipationRecord>
  /** Participants who marked themselves as looking for a team. */
  listLookingForTeam(eventSlug: string): Promise<ParticipationRecord[]>
  updateBlurbVisibility(
    eventSlug: string,
    userId: string,
    visibility: ContentVisibility,
  ): Promise<void>
  /** Non-empty blurbs still awaiting moderation (the review queue). */
  listPendingBlurbs(): Promise<ParticipationRecord[]>
  /** Account deletion: purge the user's per-event profiles immediately. */
  deleteForUser(userId: string): Promise<void>
  /** Retention cleanup: purge all participations of an event. */
  deleteByEvent(eventSlug: string): Promise<void>
  /** Admin dashboard: participant counts keyed by intent. */
  countByIntent(eventSlug: string): Promise<Record<string, number>>
  /** Admin member roster: every participation of an event. */
  listByEvent(eventSlug: string): Promise<ParticipationRecord[]>
}
