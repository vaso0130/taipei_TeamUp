import {
  LISTED_EVENT_STATUSES,
  type EventDetail,
  type EventSeed,
  type EventStatus,
  type EventSummary,
} from '@teamup/shared'
import type { EventRepository } from './repository.js'
import { loadEventSeeds } from './seed-loader.js'

const toSummary = (seed: EventSeed): EventSummary => ({
  slug: seed.event.slug,
  name: seed.event.name,
  status: seed.event.status,
  startsAt: seed.event.startsAt,
  endsAt: seed.event.endsAt,
  recruitClosesAt: seed.event.recruitClosesAt,
})

export const bySortOrder = <T extends { sortOrder: number; label: string }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)

const isListed = (status: EventStatus) =>
  (LISTED_EVENT_STATUSES as readonly EventStatus[]).includes(status)

/**
 * Repository backed by seed files (ADR-004). Read-only from the public
 * API's point of view; the `MemoryEventAdminRepository` used by unit
 * tests mutates the underlying seed list through the internal methods
 * below (production seed mode has no admin service at all — 503).
 */
export class SeedEventRepository implements EventRepository {
  private readonly seeds: EventSeed[]

  constructor(seeds: EventSeed[]) {
    this.seeds = seeds.map((s) => structuredClone(s))
  }

  static fromDirectory(seedDir?: string): SeedEventRepository {
    return new SeedEventRepository(loadEventSeeds(seedDir))
  }

  listEvents(): Promise<EventSummary[]> {
    return Promise.resolve(
      this.seeds
        .filter((s) => isListed(s.event.status))
        .sort((a, b) => a.event.startsAt.localeCompare(b.event.startsAt))
        .map(toSummary),
    )
  }

  getEventBySlug(slug: string): Promise<EventDetail | null> {
    const seed = this.seeds.find((s) => s.event.slug === slug)
    // Drafts do not exist publicly; archived events stay readable by link.
    if (!seed || seed.event.status === 'draft') return Promise.resolve(null)
    return Promise.resolve({
      event: structuredClone(seed.event),
      roles: seed.roles.filter((r) => r.isActive).sort(bySortOrder).map((r) => ({ ...r })),
      skills: seed.skills.filter((s) => s.isActive).sort(bySortOrder).map((s) => ({ ...s })),
    })
  }

  // ---- internal: in-memory admin repository support ----

  /** @internal Every seed, drafts included (deep copies). */
  snapshot(): EventSeed[] {
    return this.seeds.map((s) => structuredClone(s))
  }

  /** @internal Insert or replace by slug. */
  put(seed: EventSeed): void {
    const index = this.seeds.findIndex((s) => s.event.slug === seed.event.slug)
    const copy = structuredClone(seed)
    if (index === -1) this.seeds.push(copy)
    else this.seeds[index] = copy
  }

  /** @internal */
  remove(slug: string): void {
    const index = this.seeds.findIndex((s) => s.event.slug === slug)
    if (index !== -1) this.seeds.splice(index, 1)
  }
}
