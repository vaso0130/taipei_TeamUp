import type { EventSeed, EventStatus } from '@teamup/shared'
import { bySortOrder, type SeedEventRepository } from './seed-repository.js'

/** One stored event as the admin sees it: the full seed, inactive options included. */
export interface StoredEvent {
  seed: EventSeed
  updatedAt: string
}

/**
 * Admin read/write access to event configuration. Public reads stay on
 * EventRepository; this interface sees every status and every dictionary
 * row. Two implementations: DbEventAdminRepository (production) and
 * MemoryEventAdminRepository (unit tests, layered over the seed repo so
 * the public routes observe admin writes).
 *
 * Deliberately narrow: counts, usage and guardrails are computed in the
 * service from TeamRepository / ParticipantRepository, so both storage
 * modes share one rule set.
 */
export interface EventAdminRepository {
  listAll(): Promise<StoredEvent[]>
  getBySlug(slug: string): Promise<StoredEvent | null>
  /** Strict insert — an existing slug is reported, never overwritten. */
  insert(seed: EventSeed): Promise<'ok' | 'slug_taken'>
  /**
   * Full replacement of an existing event: every field of `seed.event`
   * (status included — the caller decides what it is) and both
   * dictionaries; option rows whose key is absent from the seed are
   * deleted (the caller has verified they are unreferenced).
   */
  replace(seed: EventSeed): Promise<void>
  setStatus(slug: string, status: EventStatus): Promise<void>
  /** Hard delete; dependent rows cascade. */
  delete(slug: string): Promise<void>
}

const sortedSeed = (seed: EventSeed): EventSeed => ({
  event: { ...seed.event },
  roles: [...seed.roles].sort(bySortOrder).map((r) => ({ ...r })),
  skills: [...seed.skills].sort(bySortOrder).map((s) => ({ ...s })),
})

/** In-memory implementation for unit tests, sharing state with the public seed repository. */
export class MemoryEventAdminRepository implements EventAdminRepository {
  private readonly updatedAt = new Map<string, string>()

  constructor(private readonly store: SeedEventRepository) {
    const now = new Date().toISOString()
    for (const seed of store.snapshot()) this.updatedAt.set(seed.event.slug, now)
  }

  private stored(seed: EventSeed): StoredEvent {
    return {
      seed: sortedSeed(seed),
      updatedAt: this.updatedAt.get(seed.event.slug) ?? new Date(0).toISOString(),
    }
  }

  private touch(slug: string) {
    this.updatedAt.set(slug, new Date().toISOString())
  }

  listAll(): Promise<StoredEvent[]> {
    return Promise.resolve(this.store.snapshot().map((s) => this.stored(s)))
  }

  getBySlug(slug: string): Promise<StoredEvent | null> {
    const seed = this.store.snapshot().find((s) => s.event.slug === slug)
    return Promise.resolve(seed ? this.stored(seed) : null)
  }

  insert(seed: EventSeed): Promise<'ok' | 'slug_taken'> {
    if (this.store.snapshot().some((s) => s.event.slug === seed.event.slug)) {
      return Promise.resolve('slug_taken')
    }
    this.store.put(seed)
    this.touch(seed.event.slug)
    return Promise.resolve('ok')
  }

  replace(seed: EventSeed): Promise<void> {
    this.store.put(seed)
    this.touch(seed.event.slug)
    return Promise.resolve()
  }

  setStatus(slug: string, status: EventStatus): Promise<void> {
    const seed = this.store.snapshot().find((s) => s.event.slug === slug)
    if (seed) {
      this.store.put({ ...seed, event: { ...seed.event, status } })
      this.touch(slug)
    }
    return Promise.resolve()
  }

  delete(slug: string): Promise<void> {
    this.store.remove(slug)
    this.updatedAt.delete(slug)
    return Promise.resolve()
  }
}
