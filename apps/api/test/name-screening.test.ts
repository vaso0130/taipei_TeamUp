import { describe, expect, it } from 'vitest'
import type { ModerationContext, ModerationVerdict } from '../src/moderation/moderator.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import { authHeader, buildTestApp, jsonHeaders, openRecruitWindow } from './helpers.js'

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug

/** Flags name reviews only, so body-content pipelines stay untouched. */
const nameFlagging = (riskLevel: 'medium' | 'high') => ({
  review: (_text: string, ctx?: ModerationContext): Promise<ModerationVerdict> =>
    Promise.resolve(
      ctx?.contentType === 'name'
        ? { riskLevel, categories: ['financial_scam'], rationale: '測試' }
        : { riskLevel: 'low', categories: ['none'] },
    ),
})

const throwingOnName = {
  review: (_text: string, ctx?: ModerationContext): Promise<ModerationVerdict> => {
    if (ctx?.contentType === 'name') return Promise.reject(new Error('model down'))
    return Promise.resolve({ riskLevel: 'low', categories: ['none'] })
  },
}

const createTeam = (t: ReturnType<typeof buildTestApp>, email: string, name: string) =>
  t.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ name }),
  })

describe('public name screening', () => {
  it('refuses a team whose name fails screening', async () => {
    const t = buildTestApp([seed], { nameModerator: nameFlagging('high') })
    const res = await createTeam(t, 'owner@example.com', '加LINE領補助')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('name_rejected')
    // The refusal left no team behind.
    const list = await t.app.request(`/api/events/${SLUG}/teams`)
    expect(((await list.json()) as { teams: unknown[] }).teams).toHaveLength(0)
  })

  it('medium verdicts also refuse (names have no pending state)', async () => {
    const t = buildTestApp([seed], { nameModerator: nameFlagging('medium') })
    expect((await createTeam(t, 'owner@example.com', '怪怪的名字')).status).toBe(400)
  })

  it('refuses a nickname that fails screening, keeping the old one', async () => {
    const t = buildTestApp([seed], { nameModerator: nameFlagging('high') })
    const before = (await (
      await t.app.request('/api/me', { headers: authHeader('user@example.com') })
    ).json()) as { displayName: string }
    const res = await t.app.request('/api/me', {
      method: 'PATCH',
      headers: jsonHeaders('user@example.com'),
      body: JSON.stringify({ displayName: '代辦貸款找我' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('name_rejected')
    const after = (await (
      await t.app.request('/api/me', { headers: authHeader('user@example.com') })
    ).json()) as { displayName: string }
    expect(after.displayName).toBe(before.displayName)
  })

  it('fails closed when the moderator is unavailable', async () => {
    const t = buildTestApp([seed], { nameModerator: throwingOnName })
    const res = await createTeam(t, 'owner@example.com', '任何名字')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('moderation_unavailable')
  })

  it('low-verdict names pass through unchanged', async () => {
    const clean = buildTestApp([seed])
    expect((await createTeam(clean, 'owner@example.com', '午夜除錯俱樂部')).status).toBe(201)
    const rename = await clean.app.request('/api/me', {
      method: 'PATCH',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ displayName: '柴犬本柴' }),
    })
    expect(rename.status).toBe(200)
  })
})
