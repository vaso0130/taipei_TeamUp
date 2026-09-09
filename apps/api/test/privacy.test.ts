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
import type { ModerationQueue } from '../src/moderation/service.js'
import type { CleanupSummary, UserDataExport } from '../src/users/privacy-service.js'
import {
  TEST_PEPPER,
  authHeader,
  buildTestApp,
  joinEvent,
  jsonHeaders,
  openRecruitWindow,
  seedVariant,
  userIdOf as resolveUserId,
} from './helpers.js'

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug

let t: ReturnType<typeof buildTestApp>
beforeEach(() => {
  t = buildTestApp([seed])
})

const userIdOf = (email: string) => resolveUserId(t, email)

const createTeam = async (world: typeof t, email: string, name: string, pitch = '') => {
  await joinEvent(world, SLUG, email)
  const res = await world.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ name, pitch }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as TeamDetail
}

const exportOf = async (world: typeof t, email: string) =>
  (await (
    await world.app.request('/api/me/export', { headers: authHeader(email) })
  ).json()) as UserDataExport

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
    const team = await createTeam(t, 'captain@example.com', '完賽隊', '目標是完賽')
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
    const exported = await exportOf(t, 'rider@example.com')
    expect(exported.account.email).toBe('rider@example.com')
    expect(exported.account.status).toBe('active')
    expect(exported.participations).toHaveLength(1)
    expect(exported.teams).toHaveLength(1)
    expect(exported.applications).toHaveLength(1)
    expect(exported.applications[0]?.message).toBe('帶我一個！')
    // Verdicts about the rider's own content, metadata only.
    expect(exported.moderation.length).toBeGreaterThan(0)
    expect(exported.moderation.every((m) => m.decidedBy === 'auto' || m.decidedBy === 'human')).toBe(true)
    expect(JSON.stringify(exported.moderation)).not.toContain('human:')
    expect(exported.reportsFiled).toEqual([])

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

    // The old row is dead: the captain no longer sees the rider's messages…
    const captainView = (await (
      await t.app.request(`/api/threads/${started.thread.id}/messages`, {
        headers: authHeader('captain@example.com'),
      })
    ).json()) as { messages: MessageView[] }
    expect(captainView.messages.every((m) => m.mine || m.body === null)).toBe(true)

    // …and logging in again starts a brand-new empty account.
    const meAfter = await t.app.request('/api/me', { headers: authHeader('rider@example.com') })
    expect(meAfter.status).toBe(200)
    const fresh = (await meAfter.json()) as { userId: string; displayName: string }
    expect(fresh.userId).not.toBe(riderId)
    expect(fresh.displayName).not.toBe('（已刪除的帳號）')
    const oldRow = await t.userRepo.findById(riderId)
    expect(oldRow?.status).toBe('deleted')
    const noProfile = await t.app.request(`/api/events/${SLUG}/participation`, {
      headers: authHeader('rider@example.com'),
    })
    expect(noProfile.status).toBe(404)
    const freshExport = await exportOf(t, 'rider@example.com')
    expect(freshExport.teams).toEqual([])
    expect(freshExport.messages).toEqual([])
  })

  it('deleting the owner transfers ownership to the earliest remaining member', async () => {
    const team = await createTeam(t, 'owner@example.com', '交棒隊')
    await joinEvent(t, SLUG, 'heir@example.com', 'looking_for_team')
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

  it('deleting a sole-member owner deletes the team, so the account can be hard-deleted later', async () => {
    const team = await createTeam(t, 'solo@example.com', '一人隊')
    const soloId = await userIdOf('solo@example.com')
    // A pending application from someone else would otherwise wait forever.
    await joinEvent(t, SLUG, 'hopeful@example.com', 'looking_for_team')
    const applyRes = await t.app.request(`/api/teams/${team.id}/applications`, {
      method: 'POST',
      headers: jsonHeaders('hopeful@example.com'),
      body: JSON.stringify({ message: '' }),
    })
    expect(applyRes.status).toBe(201)

    expect(
      (await t.app.request('/api/me', { method: 'DELETE', headers: authHeader('solo@example.com') }))
        .status,
    ).toBe(200)

    // No zombie team left behind pointing at the deleted account.
    expect(await t.teamRepo.getById(team.id)).toBeNull()
    expect((await t.app.request(`/api/teams/${team.id}`)).status).toBe(404)
    // The hopeful applicant's request is gone with the team (cascade in
    // PostgreSQL; the memory repo mirrors the observable outcome).
    const mine = (await (
      await t.app.request(`/api/events/${SLUG}/my-applications`, {
        headers: authHeader('hopeful@example.com'),
      })
    ).json()) as { applications: ApplicationView[] }
    expect(mine.applications.filter((a) => a.status === 'pending')).toHaveLength(0)

    // Grace period elapsed → the row goes, nothing blocks it.
    const purged = await t.userRepo.hardDeleteBefore(new Date(Date.now() + 1000))
    expect(purged).toEqual({ deleted: 1, failed: 0 })
    expect(await t.userRepo.findById(soloId)).toBeNull()
  })
})

describe('data export visibility (spec §5.1 applies to exports too)', () => {
  it('shows the user their own note but hides the counterpart’s unpublished note', async () => {
    const cautious = buildTestApp([seed], {
      moderator: {
        review: () => Promise.resolve({ riskLevel: 'medium' as const, categories: [] }),
      },
    })
    const team = await createTeam(cautious, 'owner@example.com', '慎重隊')
    await joinEvent(cautious, SLUG, 'invitee@example.com', 'looking_for_team')
    const inviteeId = await resolveUserId(cautious, 'invitee@example.com')
    // Owner's invite note is held in review (medium) — the invitee must not read it anywhere.
    const invite = await cautious.app.request(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ userId: inviteeId, message: '先加我 LINE 再說' }),
    })
    expect(invite.status).toBe(201)

    const inviteeExport = await exportOf(cautious, 'invitee@example.com')
    expect(inviteeExport.applications).toHaveLength(1)
    expect(inviteeExport.applications[0]?.messageVisibility).toBe('pending_review')
    expect(inviteeExport.applications[0]?.message).toBeNull()
    expect(JSON.stringify(inviteeExport)).not.toContain('先加我 LINE')

    // The invitee's own (pending) apply note is theirs to export.
    const other = await createTeam(cautious, 'other@example.com', '另一隊')
    await cautious.app.request(`/api/teams/${other.id}/applications`, {
      method: 'POST',
      headers: jsonHeaders('invitee@example.com'),
      body: JSON.stringify({ message: '我的自我推薦' }),
    })
    const again = await exportOf(cautious, 'invitee@example.com')
    const ownNote = again.applications.find((a) => a.direction === 'apply')
    expect(ownNote?.message).toBe('我的自我推薦')
  })

  it('never exports blocked text, and lists the reports the user filed', async () => {
    const strict = buildTestApp([seed], {
      moderator: {
        review: () =>
          Promise.resolve({ riskLevel: 'high' as const, categories: ['financial_scam' as const] }),
      },
    })
    const team = await createTeam(strict, 'owner@example.com', '嚴格隊')
    await joinEvent(strict, SLUG, 'scammer@example.com', 'looking_for_team')
    await strict.app.request(`/api/teams/${team.id}/applications`, {
      method: 'POST',
      headers: jsonHeaders('scammer@example.com'),
      body: JSON.stringify({ message: '匯款到這個帳戶' }),
    })
    const exported = await exportOf(strict, 'scammer@example.com')
    expect(exported.applications[0]?.messageVisibility).toBe('blocked')
    expect(exported.applications[0]?.message).toBeNull()
    expect(exported.moderation.some((m) => m.riskLevel === 'high')).toBe(true)

    // Report filed by the owner against the team's would-be scammer profile.
    await joinEvent(strict, SLUG, 'reporter@example.com')
    const scammerId = await resolveUserId(strict, 'scammer@example.com')
    const report = await strict.app.request(
      `/api/events/${SLUG}/participants/${scammerId}/report`,
      { method: 'POST', headers: jsonHeaders('reporter@example.com'), body: JSON.stringify({ reason: 'scam' }) },
    )
    expect(report.status).toBe(201)
    const reporterExport = await exportOf(strict, 'reporter@example.com')
    expect(reporterExport.reportsFiled).toHaveLength(1)
    expect(reporterExport.reportsFiled[0]).toMatchObject({ targetType: 'participant', reason: 'scam' })
  })

  it('exports are rate limited (each one decrypts every field)', async () => {
    const world = buildTestApp([seed], { rateLimits: { exportsPerDay: 2 } })
    expect((await world.app.request('/api/me/export', { headers: authHeader('a@example.com') })).status).toBe(200)
    expect((await world.app.request('/api/me/export', { headers: authHeader('a@example.com') })).status).toBe(200)
    expect((await world.app.request('/api/me/export', { headers: authHeader('a@example.com') })).status).toBe(429)
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
    const summary = (await res.json()) as CleanupSummary
    expect(summary.purgedEvents).toContain('expired-event')
    expect(summary.purgedEvents).not.toContain(SLUG)
    expect(summary.hardDeleteFailures).toBe(0)

    expect(await world.teamRepo.listByEvent(expired.event.slug)).toHaveLength(0)
    expect(await world.teamRepo.listByEvent(SLUG)).toHaveLength(1)
  })

  it('hard-deletes accounts 30 days after soft deletion, one row at a time', async () => {
    const world = buildTestApp([seed], { taskSecret: 'clean' })
    for (const email of ['gone@example.com', 'stuck@example.com']) {
      await world.app.request('/api/me', { headers: authHeader(email) })
      const record = (await world.userRepo.findByLookup(emailLookupHmac(email, TEST_PEPPER)))!
      await world.userRepo.updateStatus(record.id, 'deleted')
    }
    const stuck = (await world.userRepo.findByLookup(
      emailLookupHmac('stuck@example.com', TEST_PEPPER),
    ))!
    // Emulate a row PostgreSQL would refuse to delete (dangling FK).
    world.userRepo.undeletableIds.add(stuck.id)

    const cleanup = await world.app.request('/internal/cleanup', {
      method: 'POST',
      headers: { 'x-task-secret': 'clean' },
    })
    expect(cleanup.status).toBe(200)
    // Just soft-deleted → still inside the 30-day grace window.
    expect(await world.userRepo.findById(stuck.id)).not.toBeNull()

    const purged = await world.userRepo.hardDeleteBefore(new Date(Date.now() + 1000))
    // The failing row does not block the other one.
    expect(purged).toEqual({ deleted: 1, failed: 1 })
    expect(
      await world.userRepo.findByLookup(emailLookupHmac('gone@example.com', TEST_PEPPER)),
    ).toBeNull()
    expect(await world.userRepo.findById(stuck.id)).not.toBeNull()
  })

  it('expires moderation records past their retention', async () => {
    const world = buildTestApp([seed], { taskSecret: 'clean' })
    await world.app.request(`/api/events/${SLUG}/participation`, {
      method: 'PUT',
      headers: jsonHeaders('writer@example.com'),
      body: JSON.stringify({ intent: 'browsing', preferredRoles: [], skills: [], blurb: '自介', isAdult: true }),
    })
    expect(world.moderationRecords.records.length).toBeGreaterThan(0)
    // Nothing is old enough yet.
    let summary = (await (
      await world.app.request('/internal/cleanup', { method: 'POST', headers: { 'x-task-secret': 'clean' } })
    ).json()) as CleanupSummary
    expect(summary.purgedModerationRecords).toBe(0)

    // Run "181 days later".
    const later = new Date(Date.now() + 181 * 24 * 60 * 60 * 1000)
    const purged = await world.moderationRecords.purgeBefore(
      new Date(later.getTime() - 180 * 24 * 60 * 60 * 1000),
    )
    expect(purged).toBeGreaterThan(0)
    expect(world.moderationRecords.records).toHaveLength(0)
    summary = (await (
      await world.app.request('/internal/cleanup', { method: 'POST', headers: { 'x-task-secret': 'clean' } })
    ).json()) as CleanupSummary
    expect(summary.purgedModerationRecords).toBe(0)
  })

  it('re-queues pending content whose enqueue failed, without failing the user request', async () => {
    let queueDown = true
    const flaky = (inner: ModerationQueue): ModerationQueue => ({
      enqueue: (target) =>
        queueDown ? Promise.reject(new Error('cloud tasks 503')) : inner.enqueue(target),
    })
    const world = buildTestApp([seed], {
      taskSecret: 'clean',
      queue: flaky,
      cleanup: { requeueAfterMinutes: 0 },
    })
    const put = await world.app.request(`/api/events/${SLUG}/participation`, {
      method: 'PUT',
      headers: jsonHeaders('writer@example.com'),
      body: JSON.stringify({
        intent: 'looking_for_team',
        preferredRoles: [],
        skills: [],
        blurb: '排隊失敗也不能 500',
        isAdult: true,
      }),
    })
    // The user sees a normal response; the text simply stays in review.
    expect(put.status).toBe(200)
    expect(((await put.json()) as { blurbVisibility: string }).blurbVisibility).toBe('pending_review')
    expect(world.moderationRecords.records).toHaveLength(0)

    queueDown = false
    const cleanup = await world.app.request('/internal/cleanup', {
      method: 'POST',
      headers: { 'x-task-secret': 'clean' },
    })
    const summary = (await cleanup.json()) as CleanupSummary
    expect(summary.requeuedForReview).toBe(1)
    const writerId = await resolveUserId(world, 'writer@example.com')
    expect((await world.participantRepo.get(SLUG, writerId))?.blurbVisibility).toBe('published')

    // Second run: nothing pending, nothing re-queued.
    const again = (await (
      await world.app.request('/internal/cleanup', { method: 'POST', headers: { 'x-task-secret': 'clean' } })
    ).json()) as CleanupSummary
    expect(again.requeuedForReview).toBe(0)
  })
})

describe('rate limits (spec §8)', () => {
  it('caps team creation per account per day', async () => {
    // The seed is exclusive — use a non-exclusive variant so one user
    // can create several teams and actually hit the limiter.
    const open = seedVariant(seed, { slug: 'open-event', exclusiveMembership: false })
    const world = buildTestApp([open])
    await joinEvent(world, 'open-event', 'busy@example.com')
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

  it('caps participation writes per account per hour', async () => {
    const world = buildTestApp([seed], { rateLimits: { participationWritesPerHour: 1 } })
    await joinEvent(world, SLUG, 'edgy@example.com')
    const res = await world.app.request(`/api/events/${SLUG}/participation`, {
      method: 'PUT',
      headers: jsonHeaders('edgy@example.com'),
      body: JSON.stringify({ intent: 'browsing', preferredRoles: [], skills: [], blurb: '', isAdult: true }),
    })
    expect(res.status).toBe(429)
  })
})
