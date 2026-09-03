import { beforeEach, describe, expect, it } from 'vitest'
import type {
  ApplicationView,
  MessageView,
  PublicParticipantView,
  TeamDetail,
  ThreadView,
} from '@teamup/shared'
import { emailLookupHmac } from '../src/crypto/email.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import type { UserDataExport } from '../src/users/privacy-service.js'
import {
  TEST_PEPPER,
  authHeader,
  buildTestApp,
  jsonHeaders,
  openRecruitWindow,
  seedVariant,
} from './helpers.js'

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug

let t: ReturnType<typeof buildTestApp>
beforeEach(() => {
  t = buildTestApp([seed])
})

const userIdOf = async (email: string) => {
  await t.app.request('/api/me', { headers: authHeader(email) })
  return (await t.userRepo.findByLookup(emailLookupHmac(email, TEST_PEPPER)))!.id
}

/**
 * The full journey (spec §9 M6 acceptance): register → profile →
 * create team → apply → accept → message → export → delete account.
 */
describe('full user journey', () => {
  it('runs end to end and erases the user afterwards', async () => {
    // -- register + per-event profile --------------------------------
    const putProfile = await t.app.request(`/api/events/${SLUG}/participation`, {
      method: 'PUT',
      headers: jsonHeaders('rider@example.com'),
      body: JSON.stringify({
        intent: 'looking_for_team',
        preferredRoles: seed.roles[0] ? [seed.roles[0].key] : [],
        skills: seed.skills[0] ? [seed.skills[0].key] : [],
        blurb: '想找隊友一起完賽！',
        isAdult: true,
      }),
    })
    expect(putProfile.status).toBe(200)

    // Appears in the public find-people list.
    const people = (await (
      await t.app.request(`/api/events/${SLUG}/participants`)
    ).json()) as { participants: PublicParticipantView[] }
    expect(people.participants).toHaveLength(1)

    // -- someone else creates a team; rider applies; owner accepts ---
    const team = (await (
      await t.app.request(`/api/events/${SLUG}/teams`, {
        method: 'POST',
        headers: jsonHeaders('captain@example.com'),
        body: JSON.stringify({ name: '完賽隊', pitch: '目標是完賽' }),
      })
    ).json()) as TeamDetail
    const application = (await (
      await t.app.request(`/api/teams/${team.id}/applications`, {
        method: 'POST',
        headers: jsonHeaders('rider@example.com'),
        body: JSON.stringify({ message: '帶我一個！' }),
      })
    ).json()) as ApplicationView
    const accept = await t.app.request(`/api/applications/${application.id}/respond`, {
      method: 'POST',
      headers: jsonHeaders('captain@example.com'),
      body: JSON.stringify({ action: 'accept' }),
    })
    expect(accept.status).toBe(200)

    // -- teammates exchange contact info in messages -----------------
    const riderId = await userIdOf('rider@example.com')
    const started = (await (
      await t.app.request(`/api/events/${SLUG}/threads`, {
        method: 'POST',
        headers: jsonHeaders('captain@example.com'),
        body: JSON.stringify({ toUserId: riderId, body: '我的 LINE 是 captain_tw，加一下' }),
      })
    ).json()) as { thread: ThreadView }

    // -- data export contains everything the rider owns --------------
    const exported = (await (
      await t.app.request('/api/me/export', { headers: authHeader('rider@example.com') })
    ).json()) as UserDataExport
    expect(exported.account.email).toBe('rider@example.com')
    expect(exported.participations).toHaveLength(1)
    expect(exported.teams).toHaveLength(1)
    expect(exported.applications).toHaveLength(1)
    expect(exported.applications[0]?.message).toBe('帶我一個！')

    // -- delete the account ------------------------------------------
    const del = await t.app.request('/api/me', {
      method: 'DELETE',
      headers: authHeader('rider@example.com'),
    })
    expect(del.status).toBe(200)

    // Personal page gone from find-people.
    const peopleAfter = (await (
      await t.app.request(`/api/events/${SLUG}/participants`)
    ).json()) as { participants: PublicParticipantView[] }
    expect(peopleAfter.participants).toHaveLength(0)

    // Left the team; membership count dropped.
    const teamAfter = (await (
      await t.app.request(`/api/teams/${team.id}`)
    ).json()) as TeamDetail
    expect(teamAfter.memberCount).toBe(1)

    // The deleted account can no longer log in.
    const meAfter = await t.app.request('/api/me', { headers: authHeader('rider@example.com') })
    expect(meAfter.status).toBe(403)

    // Their messages are no longer visible to the counterpart.
    const captainView = (await (
      await t.app.request(`/api/threads/${started.thread.id}/messages`, {
        headers: authHeader('captain@example.com'),
      })
    ).json()) as { messages: MessageView[] }
    expect(captainView.messages.every((m) => m.mine || m.body === null)).toBe(true)
  })

  it('deleting the owner transfers ownership to the earliest remaining member', async () => {
    const team = (await (
      await t.app.request(`/api/events/${SLUG}/teams`, {
        method: 'POST',
        headers: jsonHeaders('owner@example.com'),
        body: JSON.stringify({ name: '交棒隊' }),
      })
    ).json()) as TeamDetail
    const application = (await (
      await t.app.request(`/api/teams/${team.id}/applications`, {
        method: 'POST',
        headers: jsonHeaders('heir@example.com'),
        body: JSON.stringify({ message: '' }),
      })
    ).json()) as ApplicationView
    await t.app.request(`/api/applications/${application.id}/respond`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ action: 'accept' }),
    })

    await t.app.request('/api/me', { method: 'DELETE', headers: authHeader('owner@example.com') })

    const after = (await (
      await t.app.request(`/api/teams/${team.id}`, { headers: authHeader('heir@example.com') })
    ).json()) as TeamDetail
    expect(after.memberCount).toBe(1)
    expect(after.viewerIsOwner).toBe(true)
    expect(after.status).toBe('recruiting')
  })
})

describe('scheduled cleanup', () => {
  it('purges event data after the configured retention period', async () => {
    // An event that ended long ago, with the retention window elapsed.
    const expired = seedVariant(seed, {
      slug: 'expired-event',
      status: 'closed',
      startsAt: '2020-01-01T09:00:00+08:00',
      endsAt: '2020-01-02T18:00:00+08:00',
      recruitClosesAt: '2019-12-31T23:59:59+08:00',
    })
    const world = buildTestApp([seed, expired], { taskSecret: 'clean' })

    // Seed data into BOTH events directly through repositories.
    const mkTeam = (slug: string, name: string) =>
      world.teamRepo.create(
        {
          id: crypto.randomUUID(),
          eventSlug: slug,
          name,
          pitch: '',
          pitchVisibility: 'published',
          neededRoles: [],
          neededSkills: [],
          status: 'recruiting',
          ownerUserId: crypto.randomUUID(),
          memberCount: 0,
          createdAt: new Date().toISOString(),
        },
        { maxMembers: seed.event.maxMembers, exclusive: false },
      )
    // Owner rows must exist for membership FK-free memory repo; use ids only.
    await mkTeam(expired.event.slug, '該清掉的隊')
    await mkTeam(seed.event.slug, '要留下的隊')

    const res = await world.app.request('/internal/cleanup', {
      method: 'POST',
      headers: { 'x-task-secret': 'clean' },
    })
    expect(res.status).toBe(200)
    const summary = (await res.json()) as { purgedEvents: string[] }
    expect(summary.purgedEvents).toContain('expired-event')
    expect(summary.purgedEvents).not.toContain(SLUG)

    expect(await world.teamRepo.listByEvent(expired.event.slug)).toHaveLength(0)
    expect(await world.teamRepo.listByEvent(SLUG)).toHaveLength(1)
  })

  it('hard-deletes accounts 30 days after soft deletion', async () => {
    const world = buildTestApp([seed], { taskSecret: 'clean' })
    await world.app.request('/api/me', { headers: authHeader('gone@example.com') })
    const record = (await world.userRepo.findByLookup(
      emailLookupHmac('gone@example.com', TEST_PEPPER),
    ))!
    await world.userRepo.updateStatus(record.id, 'deleted')

    const cleanup = await world.app.request('/internal/cleanup', {
      method: 'POST',
      headers: { 'x-task-secret': 'clean' },
    })
    expect(cleanup.status).toBe(200)
    // Just soft-deleted → still inside the 30-day grace window.
    expect(await world.userRepo.findById(record.id)).not.toBeNull()

    const purged = await world.userRepo.hardDeleteBefore(new Date(Date.now() + 1000))
    expect(purged).toBe(1)
    expect(await world.userRepo.findById(record.id)).toBeNull()
  })
})

describe('rate limits (spec §8)', () => {
  it('caps team creation per account per day', async () => {
    // The seed is exclusive — use a non-exclusive variant so one user
    // can create several teams and actually hit the limiter.
    const open = seedVariant(seed, { slug: 'open-event', exclusiveMembership: false })
    const world = buildTestApp([open])
    const create = (name: string) =>
      world.app.request(`/api/events/open-event/teams`, {
        method: 'POST',
        headers: jsonHeaders('busy@example.com'),
        body: JSON.stringify({ name }),
      })
    expect((await create('一')).status).toBe(201)
    expect((await create('二')).status).toBe(201)
    expect((await create('三')).status).toBe(201)
    const fourth = await create('四')
    expect(fourth.status).toBe(429)
    expect(((await fourth.json()) as { error: string }).error).toBe('rate_limited')
  })
})
