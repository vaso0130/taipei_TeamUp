import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AdminReportItem,
  ApplicationView,
  MessageView,
  TeamDetail,
  ThreadView,
} from '@teamup/shared'
import type { ModerationVerdict, Moderator } from '../src/moderation/moderator.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import {
  authHeader,
  buildTestApp,
  joinEvent,
  jsonHeaders,
  openRecruitWindow,
  userIdOf,
} from './helpers.js'

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug
const ADMIN = 'admin@example.gov'
const OWNER = 'owner@example.com'
const APPLICANT = 'applicant@example.com'
const REPORTER = 'reporter@example.com'

/** Escalation stub with a fixed verdict. */
const fixed = (riskLevel: 'low' | 'medium' | 'high'): Moderator => ({
  review: (): Promise<ModerationVerdict> =>
    Promise.resolve({ riskLevel, categories: ['financial_scam'], rationale: '測試' }),
})

let t: ReturnType<typeof buildTestApp>
let team: TeamDetail
let message: MessageView

const listReports = (email: string, query = '') =>
  t.app.request(`/api/admin/reports${query}`, { headers: authHeader(email) })

const itemsOf = async (query = '') => {
  const res = await listReports(ADMIN, query)
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: AdminReportItem[] }).items
}

/**
 * One of each report kind, filed in order: message → team → participant.
 * The owner runs a team the applicant applied to; the applicant reports a
 * message from the owner; a third user reports the team and the owner's
 * public profile.
 */
async function setup(escalation: Moderator = fixed('low')) {
  t = buildTestApp([seed], { escalationModerator: escalation, adminEmails: [ADMIN] })
  await joinEvent(t, SLUG, OWNER)
  await joinEvent(t, SLUG, APPLICANT, 'looking_for_team')
  await joinEvent(t, SLUG, REPORTER, 'looking_for_team')

  const teamRes = await t.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders(OWNER),
    body: JSON.stringify({ name: '檢舉紀錄測試隊', pitch: '公開簡介全文不得出現在紀錄裡' }),
  })
  expect(teamRes.status).toBe(201)
  team = (await teamRes.json()) as TeamDetail

  const applyRes = await t.app.request(`/api/teams/${team.id}/applications`, {
    method: 'POST',
    headers: jsonHeaders(APPLICANT),
    body: JSON.stringify({ message: '' }),
  })
  const application = (await applyRes.json()) as ApplicationView
  const sent = await t.app.request(`/api/events/${SLUG}/threads`, {
    method: 'POST',
    headers: jsonHeaders(OWNER),
    body: JSON.stringify({ toUserId: application.applicantId, body: '訊息全文不得出現在紀錄裡' }),
  })
  expect(sent.status).toBe(201)
  message = ((await sent.json()) as { thread: ThreadView; message: MessageView }).message

  const reportMessage = await t.app.request(`/api/messages/${message.id}/report`, {
    method: 'POST',
    headers: jsonHeaders(APPLICANT),
    body: JSON.stringify({ reason: 'spam' }),
  })
  expect(reportMessage.status).toBe(201)
  const reportTeam = await t.app.request(`/api/teams/${team.id}/report`, {
    method: 'POST',
    headers: jsonHeaders(REPORTER),
    body: JSON.stringify({ reason: 'scam' }),
  })
  expect(reportTeam.status).toBe(201)
  const ownerId = await userIdOf(t, OWNER)
  const reportParticipant = await t.app.request(
    `/api/events/${SLUG}/participants/${ownerId}/report`,
    {
      method: 'POST',
      headers: jsonHeaders(REPORTER),
      body: JSON.stringify({ reason: 'harassment' }),
    },
  )
  expect(reportParticipant.status).toBe(201)
}

describe('admin report log', () => {
  beforeEach(() => setup())

  it('is admin-only', async () => {
    expect((await listReports(OWNER)).status).toBe(403)
    expect((await listReports(REPORTER, `?event=${SLUG}`)).status).toBe(403)
  })

  it('merges message, team and participant reports newest-first, metadata only', async () => {
    const items = await itemsOf()
    expect(items.map((i) => i.kind).sort()).toEqual(['message', 'participant', 'team'])

    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.createdAt >= items[i]!.createdAt).toBe(true)
    }

    const msg = items.find((i) => i.kind === 'message')!
    expect(msg.targetType).toBe('message')
    expect(msg.targetId).toBe(message.id)
    expect(msg.eventSlug).toBe(SLUG)
    expect(msg.reason).toBe('spam')
    expect(msg.reporterDisplayName).toBeTruthy()
    expect(msg.targetDisplayName).toBeTruthy()

    const tm = items.find((i) => i.kind === 'team')!
    expect(tm.targetType).toBe('team_pitch')
    expect(tm.targetId).toBe(team.id)
    expect(tm.targetDisplayName).toBe('檢舉紀錄測試隊')
    expect(tm.eventSlug).toBe(SLUG)

    const pp = items.find((i) => i.kind === 'participant')!
    expect(pp.targetType).toBe('participant_blurb')
    expect(pp.targetId).toBe(`${SLUG}/${await userIdOf(t, OWNER)}`)
    expect(pp.eventSlug).toBe(SLUG)
    expect(pp.reason).toBe('harassment')

    // Data minimization: no reported text and no email in the payload.
    const raw = JSON.stringify(items)
    expect(raw).not.toContain('不得出現在紀錄裡')
    expect(raw).not.toContain('example.com')
    expect(raw).not.toContain('example.gov')
  })

  it('filters by event', async () => {
    expect(await itemsOf(`?event=${SLUG}`)).toHaveLength(3)
    expect(await itemsOf('?event=no-such-event')).toHaveLength(0)
  })

  it('validates the query and honours limit', async () => {
    expect((await listReports(ADMIN, '?status=bogus')).status).toBe(400)
    expect((await listReports(ADMIN, '?limit=0')).status).toBe(400)
    expect(await itemsOf('?limit=2')).toHaveLength(2)
  })

  it('maps the latest verdict to auto/human and reports resolved status', async () => {
    // The low escalation verdict resolved every report at filing time —
    // exactly the trace that used to vanish from the backend.
    const resolved = await itemsOf('?status=resolved')
    expect(resolved).toHaveLength(3)
    expect(await itemsOf('?status=open')).toHaveLength(0)
    for (const item of resolved) {
      expect(item.status).toBe('resolved')
      expect(item.verdict).toEqual({
        riskLevel: 'low',
        decidedBy: 'auto',
        decidedAt: expect.any(String),
      })
    }

    // A human decision on the team becomes the latest verdict.
    const decide = await t.app.request('/api/admin/moderation/decide', {
      method: 'POST',
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({ target: { type: 'team_pitch', teamId: team.id }, action: 'block' }),
    })
    expect(decide.status).toBe(200)
    const tm = (await itemsOf()).find((i) => i.kind === 'team')!
    expect(tm.verdict?.decidedBy).toBe('human')
    expect(tm.verdict?.riskLevel).toBe('high')
    // The admin's identity is never exposed — only 'human'.
    expect(JSON.stringify(tm)).not.toContain('human:')
  })

  it('shows null display names for a deleted target and a deleted reporter', async () => {
    const del = await t.app.request(`/api/admin/teams/${team.id}`, {
      method: 'DELETE',
      headers: authHeader(ADMIN),
    })
    expect(del.status).toBe(200)
    const gone = await t.app.request('/api/me', { method: 'DELETE', headers: authHeader(REPORTER) })
    expect(gone.status).toBe(200)

    const items = await itemsOf()
    const tm = items.find((i) => i.kind === 'team')!
    expect(tm.targetDisplayName).toBeNull()
    expect(tm.reporterDisplayName).toBeNull()
    // Without its team the report can no longer be attributed to an event…
    expect(tm.eventSlug).toBeNull()
    expect((await itemsOf(`?event=${SLUG}`)).some((i) => i.kind === 'team')).toBe(false)
    // …but a participant report keeps its slug (it is part of the target id).
    const pp = items.find((i) => i.kind === 'participant')!
    expect(pp.eventSlug).toBe(SLUG)
    expect(pp.reporterDisplayName).toBeNull()
  })
})
