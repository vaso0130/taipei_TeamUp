import type { ParticipationInput, ParticipationView, PublicParticipantView } from '@teamup/shared'
import type { EventRepository } from '../events/repository.js'
import type { ModerationQueue } from '../moderation/service.js'
import type { UserRepository } from '../users/repository.js'
import type { ParticipantRepository, ParticipationRecord } from './repository.js'

export class ParticipationError extends Error {
  constructor(
    public readonly code:
      | 'event_not_found'
      | 'invalid_role_keys'
      | 'invalid_skill_keys'
      | 'invalid_custom_tags'
      | 'adult_check_required',
    public readonly detail?: unknown,
  ) {
    super(code)
    this.name = 'ParticipationError'
  }
}

const toView = (record: ParticipationRecord): ParticipationView => ({
  eventSlug: record.eventSlug,
  intent: record.intent,
  preferredRoles: record.preferredRoles,
  skills: record.skills,
  blurb: record.blurb,
  customTags: record.customTags,
  blurbVisibility: record.blurbVisibility,
  isAdult: record.isAdult,
  guardianConsentConfirmed: record.guardianConsentConfirmed,
})

export class ParticipationService {
  constructor(
    private readonly events: EventRepository,
    private readonly repo: ParticipantRepository,
    private readonly users: UserRepository,
    private readonly moderationQueue: ModerationQueue,
  ) {}

  /**
   * Public "find people" list: only participants who opted in by
   * setting intent = looking_for_team, only active accounts, and blurbs
   * only after moderation published them.
   */
  async listPublic(eventSlug: string): Promise<PublicParticipantView[]> {
    const detail = await this.events.getEventBySlug(eventSlug)
    if (!detail) throw new ParticipationError('event_not_found')
    const records = await this.repo.listLookingForTeam(eventSlug)
    const views: PublicParticipantView[] = []
    for (const record of records) {
      const user = await this.users.findById(record.userId)
      if (!user || user.status !== 'active') continue
      views.push({
        userId: record.userId,
        displayName: user.displayName,
        preferredRoles: record.preferredRoles,
        skills: record.skills,
        blurb: record.blurbVisibility === 'published' ? record.blurb : '',
        customTags: record.blurbVisibility === 'published' ? record.customTags : [],
      })
    }
    return views
  }

  async get(eventSlug: string, userId: string): Promise<ParticipationView | null> {
    const record = await this.repo.get(eventSlug, userId)
    return record ? toView(record) : null
  }

  /**
   * Create or update the caller's per-event profile. Role/skill keys are
   * validated against the event's dictionaries — free-form values never
   * enter the database (spec §4 event_participants).
   */
  async upsert(
    eventSlug: string,
    userId: string,
    input: ParticipationInput,
  ): Promise<ParticipationView> {
    const detail = await this.events.getEventBySlug(eventSlug)
    if (!detail) throw new ParticipationError('event_not_found')

    const roleKeys = new Set(detail.roles.map((r) => r.key))
    const badRoles = input.preferredRoles.filter((k) => !roleKeys.has(k))
    if (badRoles.length > 0) throw new ParticipationError('invalid_role_keys', badRoles)

    const skillKeys = new Set(detail.skills.map((s) => s.key))
    const badSkills = input.skills.filter((k) => !skillKeys.has(k))
    if (badSkills.length > 0) throw new ParticipationError('invalid_skill_keys', badSkills)

    if (detail.event.requiresAdultCheck && typeof input.isAdult !== 'boolean') {
      throw new ParticipationError('adult_check_required')
    }

    // Free-form tags: the ceiling comes from the event config, never
    // code. Empty entries drop; oversize count or length is an error.
    const customTags = dedupe(input.customTags.map((t) => t.trim()).filter((t) => t.length > 0))
    if (customTags.length > detail.event.maxCustomTags) {
      throw new ParticipationError('invalid_custom_tags', {
        max: detail.event.maxCustomTags,
      })
    }
    const oversized = customTags.filter((t) => t.length > detail.event.customTagMaxLength)
    if (oversized.length > 0) {
      throw new ParticipationError('invalid_custom_tags', {
        maxLength: detail.event.customTagMaxLength,
        tags: oversized,
      })
    }

    const existing = await this.repo.get(eventSlug, userId)
    const blurb = input.blurb.trim()
    // New or changed free text (blurb OR tags) always goes back through
    // moderation (pending_review). The moderation worker publishes it.
    const contentEmpty = blurb === '' && customTags.length === 0
    const unchanged =
      existing &&
      existing.blurb === blurb &&
      existing.customTags.length === customTags.length &&
      existing.customTags.every((t, i) => t === customTags[i])
    const blurbVisibility = contentEmpty
      ? 'published'
      : unchanged
        ? existing.blurbVisibility
        : 'pending_review'

    const record: ParticipationRecord = {
      eventSlug,
      userId,
      intent: input.intent,
      preferredRoles: dedupe(input.preferredRoles),
      skills: dedupe(input.skills),
      blurb,
      customTags,
      blurbVisibility,
      // Store only what the event asked for — data minimization.
      isAdult: detail.event.requiresAdultCheck ? (input.isAdult ?? null) : null,
      guardianConsentConfirmed:
        detail.event.requiresAdultCheck && input.isAdult === false
          ? input.guardianConsentConfirmed
          : false,
    }
    const saved = await this.repo.upsert(record)
    if (
      saved.blurbVisibility === 'pending_review' &&
      (saved.blurb !== '' || saved.customTags.length > 0)
    ) {
      // Moderation runs async (spec §5.2) — the queue worker publishes.
      await this.moderationQueue.enqueue({
        type: 'participant_blurb',
        eventSlug,
        userId,
      })
      const fresh = await this.repo.get(eventSlug, userId)
      return toView(fresh ?? saved)
    }
    return toView(saved)
  }
}

const dedupe = (values: string[]) => [...new Set(values)]
