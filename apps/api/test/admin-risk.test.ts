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
  joinEvent,
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
  await joinEvent(t, SLUG, 'owner@example.com')
  await joinEvent(t, SLUG, 'applicant@example.com', 'looking_for_team')
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

  it('refuses to open a thread with no risk-relevant message (ordinary conversations stay private)', async () => {
    // A second pair whose only message is clean, unflagged and unreported.
    await joinEvent(t, SLUG, 'quiet@example.com')
    await joinEvent(t, SLUG, 'friend@example.com', 'looking_for_team')
    const teamRes = await t.app.request(`/api/events/${SLUG}/teams`, {
      method: 'POST',
      headers: jsonHeaders('quiet@example.com'),
      body: JSON.stringify({ name: '安靜隊' }),
    })
    const team = (await teamRes.json()) as TeamDetail
    const applyRes = await t.app.request(`/api/teams/${team.id}/applications`, {
      method: 'POST',
      headers: jsonHeaders('friend@example.com'),
      body: JSON.stringify({ message: '' }),
    })
    const application = (await applyRes.json()) as ApplicationView
    const sent = await t.app.request(`/api/events/${SLUG}/threads`, {
      method: 'POST',
      headers: jsonHeaders('quiet@example.com'),
      body: JSON.stringify({ toUserId: application.applicantId, body: '你好，聊聊題目' }),
    })
    const { thread } = (await sent.json()) as { thread: ThreadView }

    const auditBefore = t.auditRepo.entries.length
    const res = await t.app.request(`/api/admin/threads/${thread.id}`, {
      headers: authHeader(ADMIN),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('forbidden')
    // No decrypting read happened, so no read is audited either.
    expect(
      t.auditRepo.entries.slice(auditBefore).some((e) => e.targetType === 'thread'),
    ).toBe(false)

    // Unknown / malformed ids are 404, not 500.
    expect(
      (await t.app.request('/api/admin/threads/not-a-uuid', { headers: authHeader(ADMIN) })).status,
    ).toBe(404)
  })

  it('admin decrypting reads fail closed when the audit trail cannot be written', async () => {
    const original = t.auditRepo.create.bind(t.auditRepo)
    t.auditRepo.create = () => Promise.reject(new Error('audit store down'))
    try {
      const thread = await t.app.request(`/api/admin/threads/${threadId}`, {
        headers: authHeader(ADMIN),
      })
      expect(thread.status).toBe(500)
      expect(await thread.text()).not.toContain('LINE ID')
      const queue = await t.app.request('/api/admin/moderation/pending', {
        headers: authHeader(ADMIN),
      })
      expect(queue.status).toBe(500)
    } finally {
      t.auditRepo.create = original
    }
  })

  it('the pending queue audits every item the admin is shown', async () => {
    const medium = { review: () => Promise.resolve({ riskLevel: 'medium' as const, categories: [] }) }
    const world = buildTestApp([seed], { moderator: medium, adminEmails: [ADMIN] })
    for (const email of ['a@example.com', 'b@example.com']) {
      await world.app.request(`/api/events/${SLUG}/participation`, {
        method: 'PUT',
        headers: jsonHeaders(email),
        body: JSON.stringify({ intent: 'browsing', preferredRoles: [], skills: [], blurb: '待審', isAdult: true }),
      })
    }
    const res = await world.app.request('/api/admin/moderation/pending', { headers: authHeader(ADMIN) })
    expect(res.status).toBe(200)
    const reads = world.auditRepo.entries.filter(
      (e) => e.action === 'admin_review_read' && e.targetType === 'participant_blurb',
    )
    expect(reads).toHaveLength(2)
    expect(new Set(reads.map((e) => e.targetId)).size).toBe(2)
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
