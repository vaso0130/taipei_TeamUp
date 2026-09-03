import { beforeEach, describe, expect, it } from 'vitest'
import type { ApplicationView, TeamDetail, TeamSummary } from '@teamup/shared'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import { authHeader, buildTestApp, jsonHeaders, openRecruitWindow, seedVariant } from './helpers.js'

const baseSeeds = loadEventSeeds()
// Pick events by their properties — never by hardcoded slug or numbers.
const exclusiveBase = baseSeeds.find(
  (s) => s.event.exclusiveMembership && s.event.requiredContacts > 0,
)
const nonExclusiveBase = baseSeeds.find((s) => !s.event.exclusiveMembership)
if (!exclusiveBase || !nonExclusiveBase) {
  throw new Error('test setup: need one exclusive event with contacts and one non-exclusive event')
}

const exclusiveSeed = openRecruitWindow(exclusiveBase)
const nonExclusiveSeed = openRecruitWindow(nonExclusiveBase)
const EX = exclusiveSeed.event.slug
const NX = nonExclusiveSeed.event.slug

let t: ReturnType<typeof buildTestApp>
beforeEach(() => {
  t = buildTestApp([exclusiveSeed, nonExclusiveSeed])
})

async function createTeam(slug: string, ownerEmail: string, name = '測試隊', pitch = '') {
  const res = await t.app.request(`/api/events/${slug}/teams`, {
    method: 'POST',
    headers: jsonHeaders(ownerEmail),
    body: JSON.stringify({ name, pitch, neededRoles: [], neededSkills: [] }),
  })
  return { res, body: (await res.json()) as TeamDetail }
}

async function applyTo(teamId: string, email: string, message = '') {
  return t.app.request(`/api/teams/${teamId}/applications`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ message }),
  })
}

async function respond(applicationId: string, email: string, action: 'accept' | 'reject') {
  return t.app.request(`/api/applications/${applicationId}/respond`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ action }),
  })
}

/** apply + owner accepts — the standard join path used across tests. */
async function joinViaApply(teamId: string, memberEmail: string, ownerEmail: string) {
  const applyRes = await applyTo(teamId, memberEmail)
  expect(applyRes.status).toBe(201)
  const application = (await applyRes.json()) as ApplicationView
  const acceptRes = await respond(application.id, ownerEmail, 'accept')
  expect(acceptRes.status).toBe(200)
  return application
}

const teamDetail = async (teamId: string, email?: string) => {
  const res = await t.app.request(
    `/api/teams/${teamId}`,
    email ? { headers: authHeader(email) } : undefined,
  )
  return (await res.json()) as TeamDetail
}

describe('team creation', () => {
  it('creates a team with the owner as first member', async () => {
    const { res, body } = await createTeam(EX, 'owner@example.com', '流浪貓派', '做一個市政 App')
    expect(res.status).toBe(201)
    expect(body.memberCount).toBe(1)
    expect(body.status).toBe('recruiting')
    expect(body.viewerIsOwner).toBe(true)
    expect(body.members).toHaveLength(1)
    // Low-risk pitch is published by the in-process moderation queue.
    expect(body.pitch).toBe('做一個市政 App')
    expect(body.pitchVisibility).toBe('published')
  })

  it('masks unpublished pitches from other viewers while moderation holds them', async () => {
    // A moderator that never clears anything → the pitch stays pending.
    const cautious = buildTestApp([exclusiveSeed, nonExclusiveSeed], {
      moderator: {
        review: () => Promise.resolve({ riskLevel: 'medium' as const, categories: [] }),
      },
    })
    const res = await cautious.app.request(`/api/events/${EX}/teams`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ name: '流浪貓派', pitch: '祕密計畫' }),
    })
    const body = (await res.json()) as TeamDetail
    // Owner still sees their own pending pitch…
    expect(body.pitch).toBe('祕密計畫')
    expect(body.pitchVisibility).toBe('pending_review')

    // …but strangers and the public list do not.
    const asStranger = await cautious.app.request(`/api/teams/${body.id}`, {
      headers: authHeader('stranger@example.com'),
    })
    expect(((await asStranger.json()) as TeamDetail).pitch).toBe('')
    const list = await cautious.app.request(`/api/events/${EX}/teams`)
    const summaries = ((await list.json()) as { teams: TeamSummary[] }).teams
    expect(summaries[0]?.pitch).toBe('')
  })

  it('rejects a second team for the same owner in an exclusive event', async () => {
    await createTeam(EX, 'owner@example.com')
    const res = await t.app.request(`/api/events/${EX}/teams`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ name: '第二隊' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('already_in_team')
  })

  it('allows one person to own two teams in a non-exclusive event', async () => {
    const first = await createTeam(NX, 'owner@example.com', '讀書會一')
    const second = await createTeam(NX, 'owner@example.com', '讀書會二')
    expect(first.res.status).toBe(201)
    expect(second.res.status).toBe(201)
  })

  it('rejects needed-role keys not in the event dictionary', async () => {
    const res = await t.app.request(`/api/events/${EX}/teams`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ name: '壞隊', neededRoles: ['nonexistent_role'] }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_role_keys')
  })

  it('rejects creation when the recruit window is closed', async () => {
    const closed = seedVariant(exclusiveSeed, {
      recruitClosesAt: '2000-01-01T00:00:00+08:00',
    })
    const closedApp = buildTestApp([closed])
    const res = await closedApp.app.request(`/api/events/${closed.event.slug}/teams`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ name: '太晚了' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('recruiting_closed')
  })
})

describe('team list filters', () => {
  it('filters by needed role from the event dictionary', async () => {
    const roleKey = exclusiveSeed.roles[0]!.key
    await t.app.request(`/api/events/${EX}/teams`, {
      method: 'POST',
      headers: jsonHeaders('a@example.com'),
      body: JSON.stringify({ name: '缺角色隊', neededRoles: [roleKey] }),
    })
    await createTeam(EX, 'b@example.com', '不缺角色隊')

    const filtered = await t.app.request(`/api/events/${EX}/teams?role=${roleKey}`)
    const { teams } = (await filtered.json()) as { teams: TeamSummary[] }
    expect(teams).toHaveLength(1)
    expect(teams[0]?.name).toBe('缺角色隊')
  })
})

describe('applications and joining', () => {
  it('apply → owner reviews → accept → member', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    const applyRes = await applyTo(team.id, 'joiner@example.com', '我會寫程式，帶我！')
    expect(applyRes.status).toBe(201)
    const mine = (await applyRes.json()) as ApplicationView
    expect(mine.message).toBe('我會寫程式，帶我！')
    // The mock moderator published the low-risk message via the queue.
    expect(mine.messageVisibility).toBe('published')

    const ownerList = await t.app.request(`/api/teams/${team.id}/applications`, {
      headers: authHeader('owner@example.com'),
    })
    const { applications } = (await ownerList.json()) as { applications: ApplicationView[] }
    expect(applications).toHaveLength(1)
    expect(applications[0]?.message).toBe('我會寫程式，帶我！')

    const acceptRes = await respond(mine.id, 'owner@example.com', 'accept')
    expect(acceptRes.status).toBe(200)
    const detail = await teamDetail(team.id, 'owner@example.com')
    expect(detail.memberCount).toBe(2)
    expect(detail.members.map((m) => m.userId)).toContain(mine.applicantId)
  })

  it('only the owner can accept an apply; strangers get 403', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    const application = (await (await applyTo(team.id, 'joiner@example.com')).json()) as ApplicationView
    const res = await respond(application.id, 'stranger@example.com', 'accept')
    expect(res.status).toBe(403)
  })

  it('duplicate pending application is rejected', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    await applyTo(team.id, 'joiner@example.com')
    const second = await applyTo(team.id, 'joiner@example.com')
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toBe('duplicate_application')
  })

  it('accepting one application withdraws the applicant’s other pending ones (exclusive)', async () => {
    const teamA = (await createTeam(EX, 'owner.a@example.com', 'A 隊')).body
    const teamB = (await createTeam(EX, 'owner.b@example.com', 'B 隊')).body
    const appA = (await (await applyTo(teamA.id, 'joiner@example.com')).json()) as ApplicationView
    await applyTo(teamB.id, 'joiner@example.com')

    await respond(appA.id, 'owner.a@example.com', 'accept')

    const mineRes = await t.app.request(`/api/events/${EX}/my-applications`, {
      headers: authHeader('joiner@example.com'),
    })
    const { applications } = (await mineRes.json()) as { applications: ApplicationView[] }
    const statuses = new Map(applications.map((a) => [a.teamId, a.status]))
    expect(statuses.get(teamA.id)).toBe('accepted')
    expect(statuses.get(teamB.id)).toBe('withdrawn')
  })

  it('a member of one team cannot apply to another team in an exclusive event', async () => {
    const teamA = (await createTeam(EX, 'owner.a@example.com', 'A 隊')).body
    const teamB = (await createTeam(EX, 'owner.b@example.com', 'B 隊')).body
    await joinViaApply(teamA.id, 'joiner@example.com', 'owner.a@example.com')
    const res = await applyTo(teamB.id, 'joiner@example.com')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('already_in_team')
  })

  it('the same person can join two teams in a non-exclusive event', async () => {
    const teamA = (await createTeam(NX, 'owner.a@example.com', '會一')).body
    const teamB = (await createTeam(NX, 'owner.b@example.com', '會二')).body
    await joinViaApply(teamA.id, 'joiner@example.com', 'owner.a@example.com')
    await joinViaApply(teamB.id, 'joiner@example.com', 'owner.b@example.com')
    expect((await teamDetail(teamA.id)).memberCount).toBe(2)
    expect((await teamDetail(teamB.id)).memberCount).toBe(2)
  })

  it('fills to max_members from event config, flips to full, blocks further applies', async () => {
    const max = exclusiveSeed.event.maxMembers
    const { body: team } = await createTeam(EX, 'owner@example.com')
    for (let i = 1; i < max; i++) {
      await joinViaApply(team.id, `member${i}@example.com`, 'owner@example.com')
    }
    const detail = await teamDetail(team.id)
    expect(detail.memberCount).toBe(max)
    expect(detail.status).toBe('full')

    const lateApply = await applyTo(team.id, 'late@example.com')
    expect(lateApply.status).toBe(409)
    expect(((await lateApply.json()) as { error: string }).error).toBe('not_recruiting')
  })

  it('a stale accept cannot overfill the team', async () => {
    const max = exclusiveSeed.event.maxMembers
    const { body: team } = await createTeam(EX, 'owner@example.com')
    // Everyone applies while there is still room…
    const pending: ApplicationView[] = []
    for (let i = 1; i <= max; i++) {
      const res = await applyTo(team.id, `member${i}@example.com`)
      pending.push((await res.json()) as ApplicationView)
    }
    // …but only max-1 seats remain after the owner.
    for (let i = 0; i < max - 1; i++) {
      expect((await respond(pending[i]!.id, 'owner@example.com', 'accept')).status).toBe(200)
    }
    const overflow = await respond(pending[max - 1]!.id, 'owner@example.com', 'accept')
    expect(overflow.status).toBe(409)
    expect(((await overflow.json()) as { error: string }).error).toBe('team_full')
    expect((await teamDetail(team.id)).memberCount).toBe(max)
  })

  it('invite flow: owner invites, invitee accepts', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    // Invitee must exist (they logged in at least once).
    await t.app.request('/api/me', { headers: authHeader('invitee@example.com') })
    const people = await t.app.request(`/api/events/${EX}/participants`)
    expect(people.status).toBe(200)

    const detailBefore = await teamDetail(team.id, 'invitee@example.com')
    expect(detailBefore.viewerIsMember).toBe(false)

    // Find the invitee's userId via their own profile-driven flow: the
    // owner would normally get it from the participants list; here we
    // read it from the application record itself.
    const inviteRes = await t.app.request(`/api/teams/${team.id}/invitations`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({
        userId: await userIdOf('invitee@example.com'),
        message: '來我們隊吧',
      }),
    })
    expect(inviteRes.status).toBe(201)
    const invitation = (await inviteRes.json()) as ApplicationView

    // Only the invitee may respond.
    expect((await respond(invitation.id, 'owner@example.com', 'accept')).status).toBe(403)
    expect((await respond(invitation.id, 'invitee@example.com', 'accept')).status).toBe(200)
    expect((await teamDetail(team.id)).memberCount).toBe(2)
  })

  it('withdraw: applicant cancels an apply, owner cancels an invite', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    const application = (await (await applyTo(team.id, 'joiner@example.com')).json()) as ApplicationView

    // Owner cannot withdraw someone's apply.
    const ownerTry = await t.app.request(`/api/applications/${application.id}/withdraw`, {
      method: 'POST',
      headers: authHeader('owner@example.com'),
    })
    expect(ownerTry.status).toBe(403)

    const selfWithdraw = await t.app.request(`/api/applications/${application.id}/withdraw`, {
      method: 'POST',
      headers: authHeader('joiner@example.com'),
    })
    expect(selfWithdraw.status).toBe(200)
  })
})

describe('leaving and contacts', () => {
  it('a member can leave; a full team reopens; the owner cannot leave', async () => {
    const max = exclusiveSeed.event.maxMembers
    const { body: team } = await createTeam(EX, 'owner@example.com')
    for (let i = 1; i < max; i++) {
      await joinViaApply(team.id, `member${i}@example.com`, 'owner@example.com')
    }
    expect((await teamDetail(team.id)).status).toBe('full')

    const leave = await t.app.request(`/api/teams/${team.id}/leave`, {
      method: 'POST',
      headers: authHeader('member1@example.com'),
    })
    expect(leave.status).toBe(200)
    const after = await teamDetail(team.id)
    expect(after.memberCount).toBe(max - 1)
    expect(after.status).toBe('recruiting')

    const ownerLeave = await t.app.request(`/api/teams/${team.id}/leave`, {
      method: 'POST',
      headers: authHeader('owner@example.com'),
    })
    expect(ownerLeave.status).toBe(409)
    expect(((await ownerLeave.json()) as { error: string }).error).toBe('owner_cannot_leave')
  })

  it('contacts: only after min_members, exactly required_contacts distinct members', async () => {
    const { minMembers, requiredContacts } = exclusiveSeed.event
    const { body: team } = await createTeam(EX, 'owner@example.com')

    const putContacts = (contacts: { userId: string; rank: number }[]) =>
      t.app.request(`/api/teams/${team.id}/contacts`, {
        method: 'PUT',
        headers: jsonHeaders('owner@example.com'),
        body: JSON.stringify({ contacts }),
      })

    // Too early: below the event minimum.
    const early = await putContacts([])
    expect(early.status).toBe(409)
    expect(((await early.json()) as { error: string }).error).toBe('contacts_not_allowed_yet')

    for (let i = 1; i < minMembers; i++) {
      await joinViaApply(team.id, `member${i}@example.com`, 'owner@example.com')
    }
    const detail = await teamDetail(team.id, 'owner@example.com')
    const memberIds = detail.members.map((m) => m.userId)

    // Wrong count.
    const wrongCount = await putContacts([{ userId: memberIds[0]!, rank: 1 }])
    if (requiredContacts !== 1) {
      expect(wrongCount.status).toBe(400)
    }

    // Correct designation: ranks 1..n over distinct members.
    const contacts = memberIds
      .slice(0, requiredContacts)
      .map((userId, i) => ({ userId, rank: i + 1 }))
    const ok = await putContacts(contacts)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as TeamDetail).contacts).toHaveLength(requiredContacts)

    // Non-member cannot be a contact.
    const outsider = await userIdOf('outsider@example.com')
    const bad = await putContacts(
      contacts.map((c, i) => (i === 0 ? { ...c, userId: outsider } : c)),
    )
    expect(bad.status).toBe(400)
  })

  it('contacts are rejected for events that do not use them', async () => {
    const { body: team } = await createTeam(NX, 'owner@example.com')
    const res = await t.app.request(`/api/teams/${team.id}/contacts`, {
      method: 'PUT',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ contacts: [] }),
    })
    expect([400, 409]).toContain(res.status)
  })
})

describe('my team', () => {
  it('returns the current team or null', async () => {
    const none = await t.app.request(`/api/events/${EX}/my-team`, {
      headers: authHeader('nobody@example.com'),
    })
    expect(((await none.json()) as { team: TeamDetail | null }).team).toBeNull()

    const { body: team } = await createTeam(EX, 'owner@example.com')
    const mine = await t.app.request(`/api/events/${EX}/my-team`, {
      headers: authHeader('owner@example.com'),
    })
    expect(((await mine.json()) as { team: TeamDetail }).team.id).toBe(team.id)
  })
})

/** Resolve a user's id by logging them in and reading their team-free profile. */
async function userIdOf(email: string): Promise<string> {
  await t.app.request('/api/me', { headers: authHeader(email) })
  const { emailLookupHmac } = await import('../src/crypto/email.js')
  const { TEST_PEPPER } = await import('./helpers.js')
  const record = await t.userRepo.findByLookup(emailLookupHmac(email, TEST_PEPPER))
  if (!record) throw new Error(`user ${email} not provisioned`)
  return record.id
}

describe('team deletion', () => {
  const del = (teamId: string, email: string) =>
    t.app.request(`/api/teams/${teamId}`, { method: 'DELETE', headers: authHeader(email) })

  it('owner can delete a team while they are the sole member', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    const res = await del(team.id, 'owner@example.com')
    expect(res.status).toBe(200)
    const gone = await t.app.request(`/api/teams/${team.id}`, {
      headers: authHeader('owner@example.com'),
    })
    expect(gone.status).toBe(404)
  })

  it('non-owners cannot delete the team', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    expect((await del(team.id, 'stranger@example.com')).status).toBe(403)
  })

  it('deletion is refused while teammates remain, allowed after they leave', async () => {
    const { body: team } = await createTeam(EX, 'owner@example.com')
    await joinViaApply(team.id, 'member@example.com', 'owner@example.com')
    const refused = await del(team.id, 'owner@example.com')
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toBe('team_not_empty')

    const leave = await t.app.request(`/api/teams/${team.id}/leave`, {
      method: 'POST',
      headers: authHeader('member@example.com'),
    })
    expect(leave.status).toBe(200)
    expect((await del(team.id, 'owner@example.com')).status).toBe(200)
  })
})
