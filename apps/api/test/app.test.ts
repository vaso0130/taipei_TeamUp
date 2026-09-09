import { describe, expect, it } from 'vitest'
import { LISTED_EVENT_STATUSES, type EventDetail, type EventSummary } from '@teamup/shared'
import { createApp } from '../src/app.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import { SeedEventRepository } from '../src/events/seed-repository.js'

// vitest runs with cwd = apps/api, so the default seed dir resolves to
// the real seeds shipped in the repo. No event values are hardcoded in
// these tests — expectations always come from the seed files themselves.
const seeds = loadEventSeeds()
const app = createApp({ events: new SeedEventRepository(seeds) })

describe('GET /healthz', () => {
  it('returns 200 ok', async () => {
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})

describe('GET /api/events', () => {
  it('lists every open/closed seeded event', async () => {
    const res = await app.request('/api/events')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: EventSummary[] }
    const expected = seeds
      .filter((s) => (LISTED_EVENT_STATUSES as readonly string[]).includes(s.event.status))
      .map((s) => s.event.slug)
      .sort()
    expect(body.events.map((e) => e.slug).sort()).toEqual(expected)
  })

  it('hides archived events from the list but keeps them readable by slug', async () => {
    const first = seeds[0]
    if (!first) throw new Error('no seeds loaded')
    const archived = { ...first, event: { ...first.event, status: 'archived' as const } }
    const archivedApp = createApp({ events: new SeedEventRepository([archived]) })

    const list = await archivedApp.request('/api/events')
    expect(((await list.json()) as { events: EventSummary[] }).events).toEqual([])

    const detail = await archivedApp.request(`/api/events/${archived.event.slug}`)
    expect(detail.status).toBe(200)
  })
})

describe('GET /api/events/:slug', () => {
  // Generic over all seed files: adding a new event seed requires zero
  // code changes for it to be served (M1 acceptance criterion).
  for (const seed of seeds.filter((s) => s.event.status !== 'draft')) {
    it(`serves "${seed.event.slug}" exactly as configured in its seed file`, async () => {
      const res = await app.request(`/api/events/${seed.event.slug}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as EventDetail
      expect(body.event).toEqual(seed.event)
      expect(body.roles.map((r) => r.key).sort()).toEqual(
        seed.roles.filter((r) => r.isActive).map((r) => r.key).sort(),
      )
      expect(body.skills.map((s) => s.key).sort()).toEqual(
        seed.skills.filter((s) => s.isActive).map((s) => s.key).sort(),
      )
    })
  }

  it('returns 404 for an unknown slug', async () => {
    const res = await app.request('/api/events/no-such-event')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'event_not_found' })
  })

  it('hides draft events from both list and detail', async () => {
    const first = seeds[0]
    if (!first) throw new Error('no seeds loaded')
    const draftSeed = { ...first, event: { ...first.event, status: 'draft' as const } }
    const draftApp = createApp({ events: new SeedEventRepository([draftSeed]) })

    const list = await draftApp.request('/api/events')
    expect(((await list.json()) as { events: EventSummary[] }).events).toEqual([])

    const detail = await draftApp.request(`/api/events/${draftSeed.event.slug}`)
    expect(detail.status).toBe(404)
  })
})
