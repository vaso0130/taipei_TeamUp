import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AdminThreadDetail,
  ApplicationView,
  MessageView,
  RiskMessageItem,
  TeamDetail,
  ThreadView,
  UserModerationHistory,
} from '@teamup/shared'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import {
  authHeader,
  buildTestApp,
  jsonHeaders,
  openRecruitWindow,
} from './helpers.js'

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug
const ADMIN = 'admin@example.gov'

let t: ReturnType<typeof buildTestApp>
let threadId: string
let cleanMessage: MessageView
let signalMessage: MessageView
let reportedMessage: MessageView

/** owner↔applicant thread with three published messages of distinct risk shapes. */
async function setup() {
  t = buildTestApp([seed], { adminEmails: [ADMIN] })
  const teamRes = await t.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders('owner@example.com'),
    body: JSON.stringify({ name: '抽查測試隊' }),
  })
  const team = (await teamRes.json()) as TeamDetail
  const applyRes = await t.app.request(`/api/teams/${team.id}/applications`, {
    method: 'POST',
    headers: jsonHeaders('applicant@example.com'),
    body: JSON.stringify({ message: '' }),
  })
  const application = (await applyRes.json()) as ApplicationView

  const send = async (body: string) => {
    const res = await t.app.request(`/api/events/${SLUG}/threads`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ toUserId: application.applicantId, body }),
    })
    expect(res.status).toBe(201)
    const parsed = (await res.json()) as { thread: ThreadView; message: MessageView }
    threadId = parsed.thread.id
    return parsed.message
  }

  // MockModerator rates everything low; the middle one carries a rule
  // signal (messenger id) so the spot-check rule must flag it.
  cleanMessage = await send('哈囉，聊聊你們的題目吧')
  signalMessage = await send('加我 LINE ID: abc_123 討論細節')
  reportedMessage = await send('這句正常但會被檢舉')
  const reportRes = await t.app.request(`/api/messages/${reportedMessage.id}/report`, {
    method: 'POST',
    headers: jsonHeaders('applicant@example.com'),
    body: JSON.stringify({ reason: 'spam' }),
  })
  expect(reportRes.status).toBe(201)
}

const riskList = async (email: string) =>
  t.app.request('/api/admin/messages/risk', { headers: authHeader(email) })

describe('admin risk overview', () => {
  beforeEach(setup)

  it('lists flagged and reported messages but not clean low ones', async () => {
    const res = await riskList(ADMIN)
    expect(res.status).toBe(200)
    const { items } = (await res.json()) as { items: RiskMessageItem[] }
    const ids = items.map((i) => i.messageId)
    expect(ids).toContain(signalMessage.id)
    expect(ids).toContain(reportedMessage.id)
    expect(ids).not.toContain(cleanMessage.id)

    const flagged = items.find((i) => i.messageId === signalMessage.id)!
    expect(flagged.flagged).toBe(true)
    expect(flagged.visibility).toBe('published') // published anyway — spot-check only
    const reported = items.find((i) => i.messageId === reportedMessage.id)!
    expect(reported.reportCount).toBe(1)
    expect(reported.reportReasons).toContain('spam')
    // The overview itself carries no message text.
    expect(JSON.stringify(items)).not.toContain('LINE ID')
  })

  it('a human approve clears the spot-check entry', async () => {
    const decide = await t.app.request('/api/admin/moderation/decide', {
      method: 'POST',
      headers: jsonHeaders(ADMIN),
      body: JSON.stringify({
        target: { type: 'message', messageId: signalMessage.id },
        action: 'approve',
      }),
    })
    expect(decide.status).toBe(200)
    const { items } = (await (await riskList(ADMIN)).json()) as { items: RiskMessageItem[] }
    expect(items.map((i) => i.messageId)).not.toContain(signalMessage.id)
  })

  it('thread review decrypts the conversation and audits the read', async () => {
    const res = await t.app.request(`/api/admin/threads/${threadId}`, {
      headers: authHeader(ADMIN),
    })
    expect(res.status).toBe(200)
    const thread = (await res.json()) as AdminThreadDetail
    expect(thread.messages.map((m) => m.body)).toContain('加我 LINE ID: abc_123 討論細節')
    expect(thread.messages.find((m) => m.id === signalMessage.id)?.flagged).toBe(true)
    expect(thread.messages.find((m) => m.id === reportedMessage.id)?.reportCount).toBe(1)
    expect(thread.participants).toHaveLength(2)

    const audited = t.auditRepo.entries.find(
      (e) => e.action === 'admin_review_read' && e.targetType === 'thread',
    )
    expect(audited?.targetId).toBe(threadId)
  })

  it('shows a user moderation history', async () => {
    const res = await t.app.request(
      `/api/admin/users/${signalMessage.senderId}/moderation`,
      { headers: authHeader(ADMIN) },
    )
    expect(res.status).toBe(200)
    const history = (await res.json()) as UserModerationHistory
    expect(history.records.length).toBeGreaterThan(0)
    expect(history.records.some((r) => r.flagged)).toBe(true)
  })

  it('reactivation is admin-only and refuses non-suspended accounts', async () => {
    const res = await t.app.request(
      `/api/admin/users/${signalMessage.senderId}/reactivate`,
      { method: 'POST', headers: authHeader('owner@example.com') },
    )
    expect(res.status).toBe(403)
    const notSuspended = await t.app.request(
      `/api/admin/users/${signalMessage.senderId}/reactivate`,
      { method: 'POST', headers: authHeader(ADMIN) },
    )
    expect(notSuspended.status).toBe(409)
  })

  it('every risk endpoint is admin-only', async () => {
    expect((await riskList('owner@example.com')).status).toBe(403)
    expect(
      (
        await t.app.request(`/api/admin/threads/${threadId}`, {
          headers: authHeader('owner@example.com'),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await t.app.request(`/api/admin/users/${signalMessage.senderId}/moderation`, {
          headers: authHeader('owner@example.com'),
        })
      ).status,
    ).toBe(403)
  })
})

describe('suspension safeguards', () => {
  const highModerator = {
    review: () =>
      Promise.resolve({ riskLevel: 'high' as const, categories: ['financial_scam' as const] }),
  }

  const putBlurb = (email: string, text: string) =>
    t.app.request(`/api/events/${SLUG}/participation`, {
      method: 'PUT',
      headers: jsonHeaders(email),
      body: JSON.stringify({
        intent: 'looking_for_team',
        preferredRoles: [],
        skills: [],
        blurb: text,
        isAdult: true,
      }),
    })

  it('admin accounts are exempt from the automatic strike rule', async () => {
    t = buildTestApp([seed], { moderator: highModerator, adminEmails: [ADMIN] })
    for (const text of ['違規一', '違規二', '違規三', '違規四']) {
      expect((await putBlurb(ADMIN, text)).status).toBe(200)
    }
    // Still active — a regular account would have been suspended.
    expect((await t.app.request('/api/me', { headers: authHeader(ADMIN) })).status).toBe(200)
  })

  it('reactivation lifts the suspension and resets the strike window', async () => {
    t = buildTestApp([seed], { moderator: highModerator, adminEmails: [ADMIN] })
    for (const text of ['詐騙一', '詐騙二', '詐騙三']) {
      await putBlurb('scammer@example.com', text)
    }
    expect(
      (await t.app.request('/api/me', { headers: authHeader('scammer@example.com') })).status,
    ).toBe(403)

    const { emailLookupHmac } = await import('../src/crypto/email.js')
    const { TEST_PEPPER } = await import('./helpers.js')
    const scammer = await t.userRepo.findByLookup(
      emailLookupHmac('scammer@example.com', TEST_PEPPER),
    )
    const res = await t.app.request(`/api/admin/users/${scammer!.id}/reactivate`, {
      method: 'POST',
      headers: authHeader(ADMIN),
    })
    expect(res.status).toBe(200)
    expect(
      (await t.app.request('/api/me', { headers: authHeader('scammer@example.com') })).status,
    ).toBe(200)

    // Strike window was reset: one more high does not instantly re-suspend.
    await putBlurb('scammer@example.com', '詐騙四')
    expect(
      (await t.app.request('/api/me', { headers: authHeader('scammer@example.com') })).status,
    ).toBe(200)

    // The reactivation itself is audited.
    expect(t.auditRepo.entries.some((e) => e.action === 'admin_reactivate')).toBe(true)
  })
})
