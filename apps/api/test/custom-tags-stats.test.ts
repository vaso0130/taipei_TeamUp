import { beforeEach, describe, expect, it } from 'vitest'
import type { AdminStats, ParticipationView, PublicParticipantView } from '@teamup/shared'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import {
  authHeader,
  buildTestApp,
  joinEvent,
  jsonHeaders,
  openRecruitWindow,
} from './helpers.js'

const seeds = loadEventSeeds()
// Pick events by their properties — never by hardcoded slug or numbers.
const taggedBase = seeds.find((s) => s.event.maxCustomTags > 0)
const untaggedBase = seeds.find((s) => s.event.maxCustomTags === 0)
if (!taggedBase || !untaggedBase) {
  throw new Error('test setup: need one event with custom tags enabled and one without')
}
const tagged = openRecruitWindow(taggedBase)
const untagged = openRecruitWindow(untaggedBase)
const ADMIN = 'admin@example.gov'

let t: ReturnType<typeof buildTestApp>
beforeEach(() => {
  t = buildTestApp([tagged, untagged], { adminEmails: [ADMIN] })
})

const putParticipation = (slug: string, email: string, body: Record<string, unknown>) =>
  t.app.request(`/api/events/${slug}/participation`, {
    method: 'PUT',
    headers: jsonHeaders(email),
    body: JSON.stringify({
      intent: 'looking_for_team',
      preferredRoles: [],
      skills: [],
      blurb: '',
      isAdult: true,
      ...body,
    }),
  })

describe('custom participant tags (event-configured)', () => {
  it('accepts tags within the event limits and moderates them with the blurb', async () => {
    const res = await putParticipation(tagged.event.slug, 'dev@example.com', {
      customTags: ['Rust', 'Godot'],
    })
    expect(res.status).toBe(200)
    const view = (await res.json()) as ParticipationView
    expect(view.customTags).toEqual(['Rust', 'Godot'])
    // MockModerator publishes; tags become publicly visible.
    expect(view.blurbVisibility).toBe('published')

    const list = await t.app.request(`/api/events/${tagged.event.slug}/participants`)
    const { participants } = (await list.json()) as { participants: PublicParticipantView[] }
    expect(participants[0]?.customTags).toEqual(['Rust', 'Godot'])
  })

  it('rejects more tags than the event allows and oversize tags', async () => {
    const tooMany = Array.from(
      { length: tagged.event.maxCustomTags + 1 },
      (_, i) => `tag${i}`,
    )
    const res = await putParticipation(tagged.event.slug, 'dev@example.com', {
      customTags: tooMany,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_custom_tags')

    const oversize = 'x'.repeat(tagged.event.customTagMaxLength + 1)
    const res2 = await putParticipation(tagged.event.slug, 'dev@example.com', {
      customTags: [oversize],
    })
    expect(res2.status).toBe(400)
  })

  it('rejects any tag in an event that disabled custom tags', async () => {
    const res = await putParticipation(untagged.event.slug, 'dev@example.com', {
      customTags: ['Rust'],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_custom_tags')
  })

  it('a risky tag holds the whole profile in review', async () => {
    const medium = { review: () => Promise.resolve({ riskLevel: 'medium' as const, categories: [] }) }
    t = buildTestApp([tagged], { moderator: medium, adminEmails: [ADMIN] })
    const res = await putParticipation(tagged.event.slug, 'dev@example.com', {
      customTags: ['加LINE談'],
    })
    const view = (await res.json()) as ParticipationView
    expect(view.blurbVisibility).toBe('pending_review')

    const list = await t.app.request(`/api/events/${tagged.event.slug}/participants`)
    const { participants } = (await list.json()) as { participants: PublicParticipantView[] }
    expect(participants[0]?.customTags).toEqual([])

    // The pending queue shows the tags to the reviewing admin.
    const pending = await t.app.request('/api/admin/moderation/pending', {
      headers: authHeader(ADMIN),
    })
    const { items } = (await pending.json()) as { items: { content: string }[] }
    expect(items.some((i) => i.content.includes('加LINE談'))).toBe(true)
  })
})

describe('admin stats', () => {
  it('reports users, participants by intent, teams and messages', async () => {
    await putParticipation(tagged.event.slug, 'seeker@example.com', {})
    await putParticipation(tagged.event.slug, 'visitor@example.com', { intent: 'browsing' })
    await t.app.request('/api/me', { headers: authHeader('lurker@example.com') })
    await joinEvent(t, tagged.event.slug, 'ownerx@example.com')
    const teamRes = await t.app.request(`/api/events/${tagged.event.slug}/teams`, {
      method: 'POST',
      headers: jsonHeaders('ownerx@example.com'),
      body: JSON.stringify({ name: '統計測試隊' }),
    })
    expect(teamRes.status).toBe(201)

    const res = await t.app.request(
      `/api/admin/stats?event=${tagged.event.slug}`,
      { headers: authHeader(ADMIN) },
    )
    expect(res.status).toBe(200)
    const stats = (await res.json()) as AdminStats
    expect(stats.users.active).toBeGreaterThanOrEqual(4)
    expect(stats.participants.byIntent['looking_for_team']).toBe(1)
    expect(stats.participants.byIntent['browsing']).toBe(1)
    expect(stats.registeredWithoutParticipation).toBeGreaterThanOrEqual(1)
    expect(stats.teams.total).toBe(1)
    expect(stats.teams.membersInTeams).toBe(1)
  })

  it('is admin-only and requires an event', async () => {
    expect(
      (
        await t.app.request(`/api/admin/stats?event=${tagged.event.slug}`, {
          headers: authHeader('dev@example.com'),
        })
      ).status,
    ).toBe(403)
    expect(
      (await t.app.request('/api/admin/stats', { headers: authHeader(ADMIN) })).status,
    ).toBe(400)
  })
})
