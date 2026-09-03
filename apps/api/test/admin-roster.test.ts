import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AdminTeamItem,
  AdminUserItem,
  PendingModerationItem,
  TeamDetail,
} from '@teamup/shared'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import { authHeader, buildTestApp, jsonHeaders, openRecruitWindow, TEST_PEPPER } from './helpers.js'
import { emailLookupHmac } from '../src/crypto/email.js'

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug
const ADMIN = 'admin@example.gov'

let t: ReturnType<typeof buildTestApp>

const userIdOf = async (email: string) =>
  (await t.userRepo.findByLookup(emailLookupHmac(email, TEST_PEPPER)))!.id

const putBlurb = (email: string, blurb: string) =>
  t.app.request(`/api/events/${SLUG}/participation`, {
    method: 'PUT',
    headers: jsonHeaders(email),
    body: JSON.stringify({
      intent: 'looking_for_team',
      preferredRoles: [],
      skills: [],
      blurb,
      isAdult: true,
    }),
  })

const createTeam = async (email: string, name: string) => {
  const res = await t.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as TeamDetail
}

describe('admin member and team roster', () => {
  beforeEach(() => {
    t = buildTestApp([seed], { adminEmails: [ADMIN] })
  })

  it('lists members with intent and team, without emails', async () => {
    await putBlurb('alice@example.com', '')
    await createTeam('bob@example.com', '名冊測試隊')
    const aliceId = await userIdOf('alice@example.com')
    const bobId = await userIdOf('bob@example.com')
    const res = await t.app.request(`/api/admin/users?event=${SLUG}`, {
      headers: authHeader(ADMIN),
    })
    expect(res.status).toBe(200)
    const { items } = (await res.json()) as { items: AdminUserItem[] }
    const alice = items.find((u) => u.userId === aliceId)
    const bob = items.find((u) => u.userId === bobId)
    expect(alice?.intent).toBe('looking_for_team')
    expect(bob?.teamName).toBe('名冊測試隊')
    // Data minimization: the roster payload must never carry emails.
    expect(JSON.stringify(items)).not.toContain('example.com')
  })

  it('lists teams and force-disbands one, freeing exclusivity', async () => {
    const team = await createTeam('owner@example.com', '假隊伍')
    const list = await t.app.request(`/api/admin/teams?event=${SLUG}`, {
      headers: authHeader(ADMIN),
    })
    const { items } = (await list.json()) as { items: AdminTeamItem[] }
    expect(items.map((x) => x.name)).toContain('假隊伍')

    const del = await t.app.request(`/api/admin/teams/${team.id}`, {
      method: 'DELETE',
      headers: authHeader(ADMIN),
    })
    expect(del.status).toBe(200)
    // The disband is audited and the ex-member can start over.
    expect(t.auditRepo.entries.some((e) => e.action === 'admin_team_delete')).toBe(true)
    await createTeam('owner@example.com', '重新開始隊')
  })

  it('roster and disband are admin-only', async () => {
    const team = await createTeam('owner@example.com', '路人勿擾隊')
    for (const [method, path] of [
      ['GET', `/api/admin/users?event=${SLUG}`],
      ['GET', `/api/admin/teams?event=${SLUG}`],
      ['DELETE', `/api/admin/teams/${team.id}`],
      ['POST', `/api/admin/users/${await userIdOf('owner@example.com')}/suspend`],
    ] as const) {
      const res = await t.app.request(path, { method, headers: authHeader('owner@example.com') })
      expect(res.status).toBe(403)
    }
  })
})

describe('manual suspension', () => {
  beforeEach(() => {
    t = buildTestApp([seed], { adminEmails: [ADMIN] })
  })

  it('suspends an active user, audited, and reactivation undoes it', async () => {
    await putBlurb('target@example.com', '')
    const targetId = await userIdOf('target@example.com')
    const res = await t.app.request(`/api/admin/users/${targetId}/suspend`, {
      method: 'POST',
      headers: authHeader(ADMIN),
    })
    expect(res.status).toBe(200)
    expect(
      (await t.app.request('/api/me', { headers: authHeader('target@example.com') })).status,
    ).toBe(403)
    expect(t.auditRepo.entries.some((e) => e.action === 'admin_suspend')).toBe(true)

    // Suspending an already-suspended account is a 409, not a no-op 200.
    const again = await t.app.request(`/api/admin/users/${targetId}/suspend`, {
      method: 'POST',
      headers: authHeader(ADMIN),
    })
    expect(again.status).toBe(409)

    const lift = await t.app.request(`/api/admin/users/${targetId}/reactivate`, {
      method: 'POST',
      headers: authHeader(ADMIN),
    })
    expect(lift.status).toBe(200)
    expect(
      (await t.app.request('/api/me', { headers: authHeader('target@example.com') })).status,
    ).toBe(200)
  })

  it('refuses to suspend an admin (strike-exempt) account', async () => {
    const secondAdmin = 'admin2@example.gov'
    t = buildTestApp([seed], { adminEmails: [ADMIN, secondAdmin] })
    await putBlurb(secondAdmin, '')
    const res = await t.app.request(`/api/admin/users/${await userIdOf(secondAdmin)}/suspend`, {
      method: 'POST',
      headers: authHeader(ADMIN),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('cannot_suspend_admin')
    expect(
      (await t.app.request('/api/me', { headers: authHeader(secondAdmin) })).status,
    ).toBe(200)
  })
})

describe('pending queue verdict context', () => {
  it('carries the automatic verdict and the message thread id', async () => {
    const mediumModerator = {
      review: () =>
        Promise.resolve({
          riskLevel: 'medium' as const,
          categories: ['off_platform_contact' as const],
          rationale: '測試用理由',
        }),
    }
    t = buildTestApp([seed], {
      moderator: mediumModerator,
      syncModerator: mediumModerator,
      adminEmails: [ADMIN],
    })
    await putBlurb('writer@example.com', '會被判中風險的自介')

    // Messaging requires a relationship: writer applies to owner's team,
    // then the owner opens the thread (same shape as admin-risk tests).
    const team = await createTeam('owner@example.com', '脈絡測試隊')
    const applyRes = await t.app.request(`/api/teams/${team.id}/applications`, {
      method: 'POST',
      headers: jsonHeaders('writer@example.com'),
      body: JSON.stringify({ message: '' }),
    })
    expect(applyRes.status).toBe(201)
    const sent = await t.app.request(`/api/events/${SLUG}/threads`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ toUserId: await userIdOf('writer@example.com'), body: '你好' }),
    })
    expect(sent.status).toBe(201)

    const res = await t.app.request('/api/admin/moderation/pending', {
      headers: authHeader(ADMIN),
    })
    const { items } = (await res.json()) as { items: PendingModerationItem[] }
    const blurbItem = items.find((i) => i.target.type === 'participant_blurb')
    expect(blurbItem?.verdict?.riskLevel).toBe('medium')
    expect(blurbItem?.verdict?.rationale).toBe('測試用理由')
    const messageItem = items.find((i) => i.target.type === 'message')
    expect(messageItem?.threadId).toBeTruthy()
  })
})
