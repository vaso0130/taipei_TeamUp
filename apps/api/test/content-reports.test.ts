import { beforeEach, describe, expect, it } from 'vitest'
import type { TeamDetail } from '@teamup/shared'
import type { ModerationVerdict, Moderator } from '../src/moderation/moderator.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import { authHeader, buildTestApp, jsonHeaders, openRecruitWindow } from './helpers.js'
import { emailLookupHmac } from '../src/crypto/email.js'
import { TEST_PEPPER } from './helpers.js'

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug
const ADMIN = 'admin@example.gov'

/** Escalation stub that records what it was asked to review. */
class RecordingModerator implements Moderator {
  reviewed: string[] = []
  constructor(private readonly riskLevel: 'low' | 'medium' | 'high') {}
  review(text: string): Promise<ModerationVerdict> {
    this.reviewed.push(text)
    return Promise.resolve({
      riskLevel: this.riskLevel,
      categories: ['financial_scam'],
      rationale: '測試',
    })
  }
}

let t: ReturnType<typeof buildTestApp>

const userIdOf = async (email: string) =>
  (await t.userRepo.findByLookup(emailLookupHmac(email, TEST_PEPPER)))!.id

const createTeam = async (email: string, name: string, pitch = '') => {
  const res = await t.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ name, pitch }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as TeamDetail
}

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

const reportTeam = (email: string, teamId: string, reason = 'scam') =>
  t.app.request(`/api/teams/${teamId}/report`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ reason }),
  })

const reportParticipant = (email: string, userId: string, reason = 'scam') =>
  t.app.request(`/api/events/${SLUG}/participants/${userId}/report`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ reason }),
  })

describe('team reports', () => {
  let escalation: RecordingModerator

  beforeEach(() => {
    escalation = new RecordingModerator('low')
    t = buildTestApp([seed], { escalationModerator: escalation, adminEmails: [ADMIN] })
  })

  it('re-reviews name + pitch, then republishes on a low verdict', async () => {
    const team = await createTeam('owner@example.com', '可疑隊伍', '我們想做好玩的東西')
    const res = await reportTeam('reporter@example.com', team.id)
    expect(res.status).toBe(201)

    // The escalation reviewer saw the whole public face of the team.
    const reviewed = escalation.reviewed.join('\n')
    expect(reviewed).toContain('名稱：可疑隊伍')
    expect(reviewed).toContain('我們想做好玩的東西')

    // Low verdict → pitch visible again, report resolved, audit logged.
    const detail = (await (await t.app.request(`/api/teams/${team.id}`)).json()) as TeamDetail
    expect(detail.pitch).toBe('我們想做好玩的東西')
    const reports = await t.contentReportRepo.listByTarget('team', team.id)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.status).toBe('resolved')
    expect(t.auditRepo.entries.some((e) => e.action === 'content_report')).toBe(true)
  })

  it('rejects self-reports and duplicates', async () => {
    const team = await createTeam('owner@example.com', '自家隊伍')
    const self = await reportTeam('owner@example.com', team.id)
    expect(self.status).toBe(400)
    expect(((await self.json()) as { error: string }).error).toBe('cannot_report_own')

    expect((await reportTeam('reporter@example.com', team.id)).status).toBe(201)
    const dup = await reportTeam('reporter@example.com', team.id)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: string }).error).toBe('already_reported')
  })
})

describe('participant reports', () => {
  it('reviews nickname + blurb; a high verdict blocks the blurb', async () => {
    const escalation = new RecordingModerator('high')
    t = buildTestApp([seed], { escalationModerator: escalation })
    await putBlurb('target@example.com', '正常的自介')
    const targetId = await userIdOf('target@example.com')
    await putBlurb('reporter@example.com', '')

    const res = await reportParticipant('reporter@example.com', targetId)
    expect(res.status).toBe(201)
    expect(escalation.reviewed.join('\n')).toContain('暱稱：')

    const record = await t.participantRepo.get(SLUG, targetId)
    expect(record?.blurbVisibility).toBe('blocked')
    const reports = await t.contentReportRepo.listByTarget(
      'participant',
      `${SLUG}/${targetId}`,
    )
    expect(reports[0]!.status).toBe('resolved')
  })

  it('404s on a non-participant and rejects self-reports', async () => {
    t = buildTestApp([seed])
    await putBlurb('someone@example.com', '')
    const someone = await userIdOf('someone@example.com')
    expect((await reportParticipant('someone@example.com', someone)).status).toBe(400)

    // A user that never joined the event cannot be reported.
    const ghost = '01890000-0000-7000-8000-000000000000'
    expect((await reportParticipant('someone@example.com', ghost)).status).toBe(404)
  })
})

describe('reported content in the review queue', () => {
  it('a medium verdict lands the team in the pending queue with its verdict', async () => {
    const escalation = new RecordingModerator('medium')
    t = buildTestApp([seed], { escalationModerator: escalation, adminEmails: [ADMIN] })
    const team = await createTeam('owner@example.com', '灰色地帶', '看看就好')
    await reportTeam('reporter@example.com', team.id)

    const pending = (await (
      await t.app.request('/api/admin/moderation/pending', { headers: authHeader(ADMIN) })
    ).json()) as { items: { target: { type: string }; verdict: { riskLevel: string } | null }[] }
    const item = pending.items.find((i) => i.target.type === 'team_pitch')
    expect(item).toBeTruthy()
    expect(item!.verdict?.riskLevel).toBe('medium')

    // Human approve republishes and resolves the report.
    const decide = await t.app.request('/api/admin/moderation/decide', {
      method: 'POST',
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({
        target: { type: 'team_pitch', teamId: team.id },
        action: 'approve',
      }),
    })
    expect(decide.status).toBe(200)
    const reports = await t.contentReportRepo.listByTarget('team', team.id)
    expect(reports[0]!.status).toBe('resolved')
    const detail = (await (await t.app.request(`/api/teams/${team.id}`)).json()) as TeamDetail
    expect(detail.pitch).toBe('看看就好')
  })
})
