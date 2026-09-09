import { beforeEach, describe, expect, it } from 'vitest'
import type { ApplicationView, MessageView, TeamDetail, ThreadView } from '@teamup/shared'
import { emailLookupHmac } from '../src/crypto/email.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import type { Moderator } from '../src/moderation/moderator.js'
import {
  TEST_PEPPER,
  authHeader,
  buildTestApp,
  joinEvent,
  jsonHeaders,
  openRecruitWindow,
} from './helpers.js'

const baseSeeds = loadEventSeeds()
const seed = openRecruitWindow(baseSeeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug

let t: ReturnType<typeof buildTestApp>
beforeEach(() => {
  t = buildTestApp([seed])
})

async function userIdOf(email: string): Promise<string> {
  await t.app.request('/api/me', { headers: authHeader(email) })
  const record = await t.userRepo.findByLookup(emailLookupHmac(email, TEST_PEPPER))
  if (!record) throw new Error(`user ${email} not provisioned`)
  return record.id
}

async function createTeam(ownerEmail: string, name = '訊息測試隊'): Promise<TeamDetail> {
  await joinEvent(t, SLUG, ownerEmail)
  const res = await t.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders(ownerEmail),
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as TeamDetail
}

async function joinTeam(teamId: string, memberEmail: string, ownerEmail: string) {
  await joinEvent(t, SLUG, memberEmail, 'looking_for_team')
  const applyRes = await t.app.request(`/api/teams/${teamId}/applications`, {
    method: 'POST',
    headers: jsonHeaders(memberEmail),
    body: JSON.stringify({ message: '' }),
  })
  expect(applyRes.status).toBe(201)
  const application = (await applyRes.json()) as ApplicationView
  const acceptRes = await t.app.request(`/api/applications/${application.id}/respond`, {
    method: 'POST',
    headers: jsonHeaders(ownerEmail),
    body: JSON.stringify({ action: 'accept' }),
  })
  expect(acceptRes.status).toBe(200)
  return application
}

const startThread = (fromEmail: string, toUserId: string, body: string) =>
  t.app.request(`/api/events/${SLUG}/threads`, {
    method: 'POST',
    headers: jsonHeaders(fromEmail),
    body: JSON.stringify({ toUserId, body }),
  })

describe('messaging permissions', () => {
  it('teammates can message each other; both directions share one thread', async () => {
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'member@example.com', 'owner@example.com')
    const memberId = await userIdOf('member@example.com')
    const ownerId = await userIdOf('owner@example.com')

    const first = await startThread('owner@example.com', memberId, '嗨，歡迎加入！')
    expect(first.status).toBe(201)
    const { thread } = (await first.json()) as { thread: ThreadView }

    const second = await startThread('member@example.com', ownerId, '謝謝！')
    expect(second.status).toBe(201)
    const { thread: sameThread } = (await second.json()) as { thread: ThreadView }
    expect(sameThread.id).toBe(thread.id)

    const list = await t.app.request(`/api/threads/${thread.id}/messages`, {
      headers: authHeader('owner@example.com'),
    })
    const { messages } = (await list.json()) as { messages: MessageView[] }
    expect(messages).toHaveLength(2)
    expect(messages[0]?.body).toBe('嗨，歡迎加入！')
    expect(messages[1]?.body).toBe('謝謝！')
    expect(messages[0]?.mine).toBe(true)
    expect(messages[1]?.mine).toBe(false)
  })

  it('strangers cannot start a thread (403)', async () => {
    await createTeam('owner@example.com')
    const strangerTarget = await userIdOf('target@example.com')
    const res = await startThread('owner@example.com', strangerTarget, '你好')
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('not_allowed')
  })

  it('an applicant and the team owner can message while the application is pending', async () => {
    const team = await createTeam('owner@example.com')
    await joinEvent(t, SLUG, 'applicant@example.com', 'looking_for_team')
    const applyRes = await t.app.request(`/api/teams/${team.id}/applications`, {
      method: 'POST',
      headers: jsonHeaders('applicant@example.com'),
      body: JSON.stringify({ message: '' }),
    })
    expect(applyRes.status).toBe(201)

    const ownerId = await userIdOf('owner@example.com')
    const res = await startThread('applicant@example.com', ownerId, '想多了解你們的題目')
    expect(res.status).toBe(201)
  })

  it('after a rejection the relationship is gone: sending is blocked, history stays readable', async () => {
    const team = await createTeam('owner@example.com')
    await joinEvent(t, SLUG, 'applicant@example.com', 'looking_for_team')
    const applyRes = await t.app.request(`/api/teams/${team.id}/applications`, {
      method: 'POST',
      headers: jsonHeaders('applicant@example.com'),
      body: JSON.stringify({ message: '' }),
    })
    const application = (await applyRes.json()) as ApplicationView
    const ownerId = await userIdOf('owner@example.com')
    const started = await startThread('applicant@example.com', ownerId, '哈囉')
    const { thread } = (await started.json()) as { thread: ThreadView }

    await t.app.request(`/api/applications/${application.id}/respond`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ action: 'reject' }),
    })

    const send = await t.app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: jsonHeaders('applicant@example.com'),
      body: JSON.stringify({ body: '再考慮一下嘛' }),
    })
    expect(send.status).toBe(403)

    const read = await t.app.request(`/api/threads/${thread.id}/messages`, {
      headers: authHeader('applicant@example.com'),
    })
    expect(read.status).toBe(200)
  })

  it('leaving the team ends the messaging relationship (an old accepted application is not a licence)', async () => {
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'member@example.com', 'owner@example.com')
    const memberId = await userIdOf('member@example.com')
    const ownerId = await userIdOf('owner@example.com')
    const started = await startThread('owner@example.com', memberId, '歡迎')
    expect(started.status).toBe(201)
    const { thread } = (await started.json()) as { thread: ThreadView }

    const leave = await t.app.request(`/api/teams/${team.id}/leave`, {
      method: 'POST',
      headers: authHeader('member@example.com'),
    })
    expect(leave.status).toBe(200)

    // Neither a new thread nor a message into the old one.
    expect((await startThread('owner@example.com', memberId, '回來啦')).status).toBe(403)
    expect((await startThread('member@example.com', ownerId, '我走了')).status).toBe(403)
    const send = await t.app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ body: '還在嗎' }),
    })
    expect(send.status).toBe(403)
    // History stays readable.
    const read = await t.app.request(`/api/threads/${thread.id}/messages`, {
      headers: authHeader('member@example.com'),
    })
    expect(read.status).toBe(200)
  })

  it('a third party can neither read nor post into someone else’s thread', async () => {
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'member@example.com', 'owner@example.com')
    const memberId = await userIdOf('member@example.com')
    const started = await startThread('owner@example.com', memberId, '祕密作戰計畫')
    const { thread } = (await started.json()) as { thread: ThreadView }

    const read = await t.app.request(`/api/threads/${thread.id}/messages`, {
      headers: authHeader('intruder@example.com'),
    })
    expect(read.status).toBe(403)

    const post = await t.app.request(`/api/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: jsonHeaders('intruder@example.com'),
      body: JSON.stringify({ body: '我也要加入' }),
    })
    expect(post.status).toBe(403)
  })

  it('you cannot message yourself', async () => {
    const selfId = await userIdOf('me@example.com')
    const res = await startThread('me@example.com', selfId, '喂喂')
    expect(res.status).toBe(400)
  })

  it('empty message bodies are rejected', async () => {
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'member@example.com', 'owner@example.com')
    const memberId = await userIdOf('member@example.com')
    const res = await startThread('owner@example.com', memberId, '   ')
    expect(res.status).toBe(400)
  })
})

describe('messaging storage and moderation', () => {
  it('message bodies are stored encrypted only', async () => {
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'member@example.com', 'owner@example.com')
    const memberId = await userIdOf('member@example.com')
    const secret = '這句話不可以明文落地'
    const started = await startThread('owner@example.com', memberId, secret)
    const { thread } = (await started.json()) as { thread: ThreadView }

    const stored = await t.messageRepo.listForThread(thread.id)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.bodyCiphertext.includes(Buffer.from(secret, 'utf8'))).toBe(false)
  })

  it('fail-closed: a broken moderator keeps the message hidden from the recipient', async () => {
    const failing: Moderator = {
      review: () => Promise.reject(new Error('model down')),
    }
    t = buildTestApp([seed], { moderator: failing })
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'member@example.com', 'owner@example.com')
    const memberId = await userIdOf('member@example.com')

    const started = await startThread('owner@example.com', memberId, '審核掛了也不能直接發布')
    expect(started.status).toBe(201)
    const { thread, message } = (await started.json()) as {
      thread: ThreadView
      message: MessageView
    }
    expect(message.visibility).toBe('pending_review')

    // The sender still sees their own text…
    const asSender = await t.app.request(`/api/threads/${thread.id}/messages`, {
      headers: authHeader('owner@example.com'),
    })
    const senderView = ((await asSender.json()) as { messages: MessageView[] }).messages[0]!
    expect(senderView.body).toBe('審核掛了也不能直接發布')

    // …but the recipient does not.
    const asRecipient = await t.app.request(`/api/threads/${thread.id}/messages`, {
      headers: authHeader('member@example.com'),
    })
    const recipientView = ((await asRecipient.json()) as { messages: MessageView[] }).messages[0]!
    expect(recipientView.body).toBeNull()
    expect(recipientView.visibility).toBe('pending_review')
  })

  it('high-risk verdicts block the message for everyone', async () => {
    const strict: Moderator = {
      review: () => Promise.resolve({ riskLevel: 'high', categories: ['financial_scam'] }),
    }
    t = buildTestApp([seed], { moderator: strict })
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'member@example.com', 'owner@example.com')
    const memberId = await userIdOf('member@example.com')

    const started = await startThread('owner@example.com', memberId, '加我 LINE 帶你賺')
    expect(started.status).toBe(201)
    const { thread, message } = (await started.json()) as {
      thread: ThreadView
      message: MessageView
    }
    expect(message.visibility).toBe('blocked')
    expect(message.body).toBeNull()

    const asSender = await t.app.request(`/api/threads/${thread.id}/messages`, {
      headers: authHeader('owner@example.com'),
    })
    expect(((await asSender.json()) as { messages: MessageView[] }).messages[0]!.body).toBeNull()
  })

  it('threads list shows the other participant, most recent first', async () => {
    const team = await createTeam('owner@example.com')
    await joinTeam(team.id, 'amy@example.com', 'owner@example.com')
    await joinTeam(team.id, 'bob@example.com', 'owner@example.com')
    await startThread('owner@example.com', await userIdOf('amy@example.com'), '哈囉 Amy')
    await startThread('owner@example.com', await userIdOf('bob@example.com'), '哈囉 Bob')

    const res = await t.app.request(`/api/events/${SLUG}/threads`, {
      headers: authHeader('owner@example.com'),
    })
    const { threads } = (await res.json()) as { threads: ThreadView[] }
    expect(threads).toHaveLength(2)
    expect(threads.map((x) => x.otherDisplayName)).toHaveLength(2)
    expect(threads[0]!.lastMessageAt >= threads[1]!.lastMessageAt).toBe(true)
  })
})
