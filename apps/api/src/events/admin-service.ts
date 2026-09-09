import {
  ADMIN_EVENT_ERRORS,
  EVENT_STATUS_TRANSITIONS,
  EventSeedSchema,
  type AdminEventDetail,
  type AdminEventErrorCode,
  type AdminEventStats,
  type AdminEventSummary,
  type AdminEventUpdateResult,
  type AdminEventUsage,
  type DictionaryOption,
  type DuplicateEventInput,
  type EventSeed,
  type EventStatus,
  type EventTemplate,
} from '@teamup/shared'
import type { AuditLogger } from '../audit/log.js'
import type { ParticipantRepository } from '../participants/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { EventAdminRepository, StoredEvent } from './admin-repository.js'
import type { EventSeedFile } from './seed-loader.js'

/**
 * Slugs the admin API itself occupies under /api/admin/events/ — an event
 * with one of these slugs would be unreachable in the editor.
 */
const RESERVED_SLUGS = new Set(['templates'])

const TEMPLATE_DESCRIPTION_CHARS = 80

/** Extra fields returned next to the error code (spec §8). */
export type EventAdminErrorExtra =
  | { current: number }
  | { key: string; count: number }
  | { from: EventStatus; to: EventStatus }
  | { details: string[] }
  | { teams: number; participants: number }
  | Record<string, never>

export class EventAdminError extends Error {
  constructor(
    public readonly code: AdminEventErrorCode,
    public readonly extra: EventAdminErrorExtra = {},
  ) {
    super(code)
    this.name = 'EventAdminError'
  }
}

/** Sort order of the admin list (spec §2): open → draft → closed → archived, then by start. */
const LIST_ORDER: Record<EventStatus, number> = { open: 0, draft: 1, closed: 2, archived: 3 }

const firstChars = (s: string, n: number) => Array.from(s).slice(0, n).join('')

const isValidDate = (iso: string) => !Number.isNaN(new Date(iso).getTime())

/**
 * Admin event management (ADR-035, spec docs/design/admin-events.md).
 * All guardrails live here so the DB and in-memory repositories stay
 * dumb and identical in behaviour; every write is audit-logged.
 */
export class EventAdminService {
  private templateCache: EventTemplate[] | null = null

  constructor(
    private readonly deps: {
      events: EventAdminRepository
      teams: TeamRepository
      participants: ParticipantRepository
      audit: AuditLogger
      /** Repo seed files offered as starting points; failures degrade to "no templates". */
      loadTemplates?: () => EventSeedFile[]
      now?: () => Date
    },
  ) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  private async require(slug: string): Promise<StoredEvent> {
    const stored = await this.deps.events.getBySlug(slug)
    if (!stored) throw new EventAdminError(ADMIN_EVENT_ERRORS.eventNotFound)
    return stored
  }

  private async counts(slug: string): Promise<{ teams: number; participants: number }> {
    const [teams, byIntent] = await Promise.all([
      this.deps.teams.listByEvent(slug),
      this.deps.participants.countByIntent(slug),
    ])
    return {
      teams: teams.length,
      participants: Object.values(byIntent).reduce((a, b) => a + b, 0),
    }
  }

  async list(): Promise<AdminEventSummary[]> {
    const stored = await this.deps.events.listAll()
    const items = await Promise.all(
      stored.map(async ({ seed, updatedAt }) => ({
        slug: seed.event.slug,
        name: seed.event.name,
        status: seed.event.status,
        startsAt: seed.event.startsAt,
        endsAt: seed.event.endsAt,
        recruitClosesAt: seed.event.recruitClosesAt,
        termTeam: seed.event.termTeam,
        counts: await this.counts(seed.event.slug),
        updatedAt,
      })),
    )
    return items.sort(
      (a, b) =>
        LIST_ORDER[a.status] - LIST_ORDER[b.status] || a.startsAt.localeCompare(b.startsAt),
    )
  }

  /** Repo seed files as templates: slug cleared, status draft. */
  templates(): EventTemplate[] {
    if (this.templateCache) return this.templateCache
    let files: EventSeedFile[] = []
    try {
      files = this.deps.loadTemplates?.() ?? []
    } catch (err) {
      console.error(
        'event templates unavailable',
        err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error',
      )
    }
    this.templateCache = files.map(({ key, seed }) => ({
      key,
      name: seed.event.name,
      description: firstChars(seed.event.description, TEMPLATE_DESCRIPTION_CHARS),
      seed: {
        ...structuredClone(seed),
        event: { ...seed.event, slug: '', status: 'draft' as const },
      },
    }))
    return this.templateCache
  }

  /** How many participants + teams reference each dictionary key. */
  private async usage(seed: EventSeed): Promise<AdminEventUsage> {
    const slug = seed.event.slug
    const roles: Record<string, number> = {}
    const skills: Record<string, number> = {}
    for (const r of seed.roles) roles[r.key] = 0
    for (const s of seed.skills) skills[s.key] = 0
    const bump = (table: Record<string, number>, keys: string[]) => {
      for (const key of new Set(keys)) table[key] = (table[key] ?? 0) + 1
    }
    const [participants, teams] = await Promise.all([
      this.deps.participants.listByEvent(slug),
      this.deps.teams.listByEvent(slug),
    ])
    for (const p of participants) {
      bump(roles, p.preferredRoles)
      bump(skills, p.skills)
    }
    for (const t of teams) {
      bump(roles, t.neededRoles)
      bump(skills, t.neededSkills)
    }
    return { roles, skills }
  }

  private async stats(slug: string): Promise<AdminEventStats> {
    const [teams, byIntent] = await Promise.all([
      this.deps.teams.listByEvent(slug),
      this.deps.participants.countByIntent(slug),
    ])
    const sizes = teams.map((t) => t.memberCount)
    return {
      teams: teams.length,
      participants: Object.values(byIntent).reduce((a, b) => a + b, 0),
      largestTeam: sizes.length > 0 ? Math.max(...sizes) : 0,
      smallestTeam: sizes.length > 0 ? Math.min(...sizes) : 0,
    }
  }

  async get(slug: string): Promise<AdminEventDetail> {
    const { seed } = await this.require(slug)
    const [usage, stats] = await Promise.all([this.usage(seed), this.stats(slug)])
    return { seed, usage, stats }
  }

  async create(seed: EventSeed, adminUserId: string): Promise<EventSeed> {
    // Defence in depth: the route schema already forces draft.
    const draft: EventSeed = { ...seed, event: { ...seed.event, status: 'draft' } }
    await this.insertNew(draft)
    await this.deps.audit.log('admin_event_create', {
      actorUserId: adminUserId,
      targetType: 'event',
      targetId: draft.event.slug,
    })
    return (await this.require(draft.event.slug)).seed
  }

  private async insertNew(seed: EventSeed): Promise<void> {
    if (RESERVED_SLUGS.has(seed.event.slug)) {
      throw new EventAdminError(ADMIN_EVENT_ERRORS.slugTaken)
    }
    if ((await this.deps.events.insert(seed)) === 'slug_taken') {
      throw new EventAdminError(ADMIN_EVENT_ERRORS.slugTaken)
    }
  }

  /**
   * Full update. Guardrails (spec §8): slug immutable; status only via
   * setStatus; member limits must accommodate every existing team;
   * dictionary keys that vanish from the body are deleted when unused
   * and refused when referenced (the editor only ever deactivates those).
   */
  async update(
    slug: string,
    body: EventSeed,
    adminUserId: string,
  ): Promise<AdminEventUpdateResult> {
    const existing = await this.require(slug)
    if (body.event.slug !== slug) throw new EventAdminError(ADMIN_EVENT_ERRORS.slugImmutable)

    const teams = await this.deps.teams.listByEvent(slug)
    if (teams.length > 0) {
      const sizes = teams.map((t) => t.memberCount)
      const largest = Math.max(...sizes)
      const smallest = Math.min(...sizes)
      if (body.event.maxMembers < largest) {
        throw new EventAdminError(ADMIN_EVENT_ERRORS.maxMembersBelowExisting, { current: largest })
      }
      if (body.event.minMembers > smallest) {
        throw new EventAdminError(ADMIN_EVENT_ERRORS.minMembersAboveExisting, {
          current: smallest,
        })
      }
    }

    const usage = await this.usage(existing.seed)
    const guardRemoved = (
      before: DictionaryOption[],
      after: DictionaryOption[],
      used: Record<string, number>,
    ) => {
      const kept = new Set(after.map((o) => o.key))
      for (const option of before) {
        const count = used[option.key] ?? 0
        if (!kept.has(option.key) && count > 0) {
          throw new EventAdminError(ADMIN_EVENT_ERRORS.dictionaryKeyInUse, {
            key: option.key,
            count,
          })
        }
      }
    }
    guardRemoved(existing.seed.roles, body.roles, usage.roles)
    guardRemoved(existing.seed.skills, body.skills, usage.skills)

    const next: EventSeed = {
      ...body,
      // Status changes only through the status endpoint.
      event: { ...body.event, status: existing.seed.event.status },
    }
    await this.deps.events.replace(next)
    await this.deps.audit.log('admin_event_update', {
      actorUserId: adminUserId,
      targetType: 'event',
      targetId: slug,
    })
    return { seed: (await this.require(slug)).seed, warnings: this.warningsFor(next, usage) }
  }

  /** Non-blocking observations shown after a save (繁中, spec §5). */
  private warningsFor(seed: EventSeed, usage: AdminEventUsage): string[] {
    const e = seed.event
    const warnings: string[] = []
    if (e.status === 'open' && new Date(e.recruitClosesAt) <= this.now()) {
      warnings.push(`招募已截止，參加者目前無法開${e.termTeam}與申請`)
    }
    if (new Date(e.recruitClosesAt) > new Date(e.endsAt)) {
      warnings.push('招募截止晚於活動結束，活動結束後仍可組隊')
    }
    const deactivatedInUse = (options: DictionaryOption[], used: Record<string, number>) => {
      for (const o of options) {
        const count = used[o.key] ?? 0
        if (!o.isActive && count > 0) {
          warnings.push(`「${o.label}」已停用，但仍有 ${count} 筆資料選用它；既有選擇會保留但不再顯示`)
        }
      }
    }
    deactivatedInUse(seed.roles, usage.roles)
    deactivatedInUse(seed.skills, usage.skills)
    return warnings
  }

  /** What still blocks draft → open (spec §6 checklist), as 繁中 sentences. */
  openChecklist(seed: EventSeed): string[] {
    const e = seed.event
    const details: string[] = []
    if (e.name.trim() === '') details.push('活動名稱不可空白')
    const datesValid = [e.startsAt, e.endsAt, e.recruitClosesAt].every(isValidDate)
    if (!datesValid) {
      details.push('活動開始、結束與招募截止時間必須是有效的時間')
    } else {
      if (new Date(e.endsAt) <= new Date(e.startsAt)) details.push('活動結束時間必須晚於開始時間')
      if (new Date(e.recruitClosesAt) > new Date(e.endsAt)) details.push('招募截止不得晚於活動結束')
      if (new Date(e.recruitClosesAt) <= this.now()) details.push('招募截止時間必須在未來')
    }
    if (e.maxMembers < e.minMembers) details.push('人數上限不得低於下限')
    if (!seed.roles.some((r) => r.isActive)) details.push('至少要有一個啟用的角色')
    if (!seed.skills.some((s) => s.isActive)) details.push('至少要有一個啟用的技能')
    return details
  }

  async setStatus(slug: string, to: EventStatus, adminUserId: string): Promise<EventSeed> {
    const { seed } = await this.require(slug)
    const from = seed.event.status
    if (!EVENT_STATUS_TRANSITIONS[from].includes(to)) {
      throw new EventAdminError(ADMIN_EVENT_ERRORS.invalidStatusTransition, { from, to })
    }
    if (from === 'draft' && to === 'open') {
      const details = this.openChecklist(seed)
      if (details.length > 0) {
        throw new EventAdminError(ADMIN_EVENT_ERRORS.cannotOpenIncomplete, { details })
      }
    }
    await this.deps.events.setStatus(slug, to)
    await this.deps.audit.log('admin_event_status', {
      actorUserId: adminUserId,
      targetType: 'event',
      targetId: slug,
      detail: `${from}->${to}`,
    })
    return (await this.require(slug)).seed
  }

  /** Clone as a fresh draft under a new slug and name; dictionaries copied verbatim. */
  async duplicate(
    slug: string,
    input: DuplicateEventInput,
    adminUserId: string,
  ): Promise<EventSeed> {
    const source = await this.require(slug)
    const copy: EventSeed = {
      roles: source.seed.roles.map((r) => ({ ...r })),
      skills: source.seed.skills.map((s) => ({ ...s })),
      event: { ...source.seed.event, slug: input.slug, name: input.name, status: 'draft' },
    }
    await this.insertNew(copy)
    await this.deps.audit.log('admin_event_duplicate', {
      actorUserId: adminUserId,
      targetType: 'event',
      targetId: input.slug,
      detail: `from=${slug}`,
    })
    return (await this.require(input.slug)).seed
  }

  /** Seed-file-compatible JSON: `EventSeedSchema.parse(export)` round-trips. */
  async exportSeed(slug: string): Promise<EventSeed> {
    const { seed } = await this.require(slug)
    return EventSeedSchema.parse(seed)
  }

  /**
   * Delete an event in any status as long as nobody has touched it: no
   * teams, no participants (ADR-035). Anything with data is archived instead.
   */
  async delete(slug: string, adminUserId: string): Promise<void> {
    await this.require(slug)
    const counts = await this.counts(slug)
    if (counts.teams > 0 || counts.participants > 0) {
      throw new EventAdminError(ADMIN_EVENT_ERRORS.eventNotEmpty, counts)
    }
    await this.deps.events.delete(slug)
    await this.deps.audit.log('admin_event_delete', {
      actorUserId: adminUserId,
      targetType: 'event',
      targetId: slug,
    })
  }
}
