import type { EventDetail, EventSeed, EventSummary } from '@teamup/shared'
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

const bySortOrder = <T extends { sortOrder: number; label: string }>(a: T, b: T) =>
  a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)

/** Read-only repository backed by seed files (ADR-004). */
export class SeedEventRepository implements EventRepository {
  private readonly seeds: EventSeed[]

  constructor(seeds: EventSeed[]) {
    this.seeds = seeds.filter((s) => s.event.status !== 'draft')
  }

  static fromDirectory(seedDir?: string): SeedEventRepository {
    return new SeedEventRepository(loadEventSeeds(seedDir))
  }

  listEvents(): Promise<EventSummary[]> {
    return Promise.resolve(this.seeds.map(toSummary))
  }

  getEventBySlug(slug: string): Promise<EventDetail | null> {
    const seed = this.seeds.find((s) => s.event.slug === slug)
    if (!seed) return Promise.resolve(null)
    return Promise.resolve({
      event: seed.event,
      roles: seed.roles.filter((r) => r.isActive).sort(bySortOrder),
      skills: seed.skills.filter((s) => s.isActive).sort(bySortOrder),
    })
  }
}
