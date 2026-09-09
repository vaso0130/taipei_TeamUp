import { beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN_EVENT_ERRORS,
  EVENT_STATUSES,
  EventSeedSchema,
  type AdminEventDetail,
  type AdminEventSummary,
  type AdminEventUpdateResult,
  type EventSeed,
  type EventStatus,
  type EventSummary,
  type EventTemplate,
  type TeamDetail,
} from '@teamup/shared'
import { loadEventSeedFiles, loadEventSeeds } from '../src/events/seed-loader.js'
import {
  buildTestApp,
  joinEvent,
  jsonHeaders,
  openRecruitWindow,
  seedVariant,
  userIdOf,
} from './helpers.js'

// Every expectation derives from the seed files — no event rule literals.
const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)
const SLUG = seed.event.slug
const ADMIN = 'admin@example.gov'
const USER = 'user@example.com'

/** A complete, openable draft derived from the fixture under a new slug. */
const draftOf = (slug: string, overrides: Partial<EventSeed['event']> = {}): EventSeed => ({
  ...structuredClone(seedVariant(seed, { slug, status: 'draft', ...overrides })),
})

let t: ReturnType<typeof buildTestApp>

const adminReq = (path: string, init: { method?: string; body?: unknown } = {}) =>
  t.app.request(`/api/admin/events${path}`, {
    method: init.method ?? 'GET',
    headers: jsonHeaders(ADMIN),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

const createDraft = async (slug: string, overrides: Partial<EventSeed['event']> = {}) => {
  const res = await adminReq('', { method: 'POST', body: draftOf(slug, overrides) })
  expect(res.status).toBe(201)
  return ((await res.json()) as { seed: EventSeed }).seed
}

const setStatus = (slug: string, status: EventStatus) =>
  adminReq(`/${slug}/status`, { method: 'POST', body: { status } })

const putParticipation = (email: string, roles: string[], skills: string[]) =>
  t.app.request(`/api/events/${SLUG}/participation`, {
    method: 'PUT',
    headers: jsonHeaders(email),
    body: JSON.stringify({
      intent: 'looking_for_team',
      preferredRoles: roles,
      skills,
      blurb: '',
      isAdult: true,
    }),
  })

const createTeam = async (email: string, name: string, roles: string[] = [], skills: string[] = []) => {
  await joinEvent(t, SLUG, email)
  const res = await t.app.request(`/api/events/${SLUG}/teams`, {
    method: 'POST',
    headers: jsonHeaders(email),
    body: JSON.stringify({ name, neededRoles: roles, neededSkills: skills }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as TeamDetail
}

/** Grow a team to two members: applicant applies, owner accepts. */
const addMember = async (team: TeamDetail, ownerEmail: string, applicantEmail: string) => {
  await joinEvent(t, SLUG, applicantEmail, 'looking_for_team')
  const applied = await t.app.request(`/api/teams/${team.id}/applications`, {
    method: 'POST',
    headers: jsonHeaders(applicantEmail),
    body: JSON.stringify({ message: '' }),
  })
  expect(applied.status).toBe(201)
  const { id } = (await applied.json()) as { id: string }
  const accepted = await t.app.request(`/api/applications/${id}/respond`, {
    method: 'POST',
    headers: jsonHeaders(ownerEmail),
    body: JSON.stringify({ action: 'accept' }),
  })
  expect(accepted.status).toBe(200)
}

const auditActions = () => t.auditRepo.entries.map((e) => e.action)

beforeEach(() => {
  t = buildTestApp([seed], { adminEmails: [ADMIN] })
})

describe('access control', () => {
  it('is admin-only on every endpoint', async () => {
    for (const [method, path] of [
      ['GET', ''],
      ['GET', '/templates'],
      ['POST', ''],
      ['GET', `/${SLUG}`],
      ['PUT', `/${SLUG}`],
      ['POST', `/${SLUG}/status`],
      ['POST', `/${SLUG}/duplicate`],
      ['GET', `/${SLUG}/export`],
      ['DELETE', `/${SLUG}`],
    ] as const) {
      const res = await t.app.request(`/api/admin/events${path}`, {
        method,
        headers: jsonHeaders(USER),
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('returns 503 unavailable when the admin service is not wired', async () => {
    t = buildTestApp([seed], { adminEmails: [ADMIN], withoutEventAdmin: true })
    const res = await adminReq('')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('unavailable')
  })

  it('treats a malformed slug as not found', async () => {
    const res = await adminReq('/Not%20A%20Slug')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe(ADMIN_EVENT_ERRORS.eventNotFound)
  })
})

describe('templates', () => {
  it('turns every repo seed file into a draft template with an empty slug', async () => {
    const res = await adminReq('/templates')
    expect(res.status).toBe(200)
    const { templates } = (await res.json()) as { templates: EventTemplate[] }
    const files = loadEventSeedFiles()
    expect(templates.map((x) => x.key).sort()).toEqual(files.map((f) => f.key).sort())
    for (const template of templates) {
      const source = files.find((f) => f.key === template.key)!
      expect(template.name).toBe(source.seed.event.name)
      expect(Array.from(template.description).length).toBeLessThanOrEqual(80)
      expect(source.seed.event.description.startsWith(template.description)).toBe(true)
      expect(template.seed.event.slug).toBe('')
      expect(template.seed.event.status).toBe('draft')
      expect(template.seed.roles).toEqual(source.seed.roles)
      expect(template.seed.skills).toEqual(source.seed.skills)
    }
  })
})

describe('list and detail', () => {
  it('lists every status with counts, open first then draft/closed/archived', async () => {
    await createDraft('zz-draft')
    await createTeam('owner@example.com', '列表測試隊')
    await putParticipation('solo@example.com', [], [])
    const res = await adminReq('')
    expect(res.status).toBe(200)
    const { items } = (await res.json()) as { items: AdminEventSummary[] }
    expect(items.map((i) => i.slug)).toEqual([SLUG, 'zz-draft'])
    const open = items[0]!
    expect(open.status).toBe('open')
    expect(open.termTeam).toBe(seed.event.termTeam)
    expect(open.counts).toEqual({ teams: 1, participants: 2 })
    expect(items[1]!.counts).toEqual({ teams: 0, participants: 0 })
    expect(typeof open.updatedAt).toBe('string')
  })

  it('returns the seed with inactive options, usage and team-size stats', async () => {
    const role = seed.roles[0]!.key
    const skill = seed.skills[0]!.key
    // Deactivate one option through the editor first: it must still be returned.
    const body = draftOf(SLUG, { status: seed.event.status })
    body.roles = body.roles.map((r, i) => (i === body.roles.length - 1 ? { ...r, isActive: false } : r))
    expect((await adminReq(`/${SLUG}`, { method: 'PUT', body })).status).toBe(200)

    await putParticipation('alice@example.com', [role], [skill])
    const team = await createTeam('owner@example.com', '統計測試隊', [role], [])
    await addMember(team, 'owner@example.com', 'bob@example.com')
    await createTeam('solo@example.com', '單人隊')

    const res = await adminReq(`/${SLUG}`)
    expect(res.status).toBe(200)
    const detail = (await res.json()) as AdminEventDetail
    expect(detail.seed.roles.map((r) => r.key).sort()).toEqual(
      seed.roles.map((r) => r.key).sort(),
    )
    expect(detail.seed.roles.some((r) => !r.isActive)).toBe(true)
    // alice + team → 2 references to the role; alice → 1 to the skill.
    expect(detail.usage.roles[role]).toBe(2)
    expect(detail.usage.skills[skill]).toBe(1)
    // Every dictionary key is present, unused ones at 0.
    expect(Object.keys(detail.usage.roles).sort()).toEqual(seed.roles.map((r) => r.key).sort())
    expect(detail.stats).toEqual({
      teams: 2,
      participants: 4,
      largestTeam: 2,
      smallestTeam: 1,
    })
  })
})

describe('create', () => {
  it('creates a draft (201) and refuses a taken slug (409 slug_taken)', async () => {
    const created = await createDraft('new-event')
    expect(created.event.status).toBe('draft')
    expect(created.event.slug).toBe('new-event')
    const again = await adminReq('', { method: 'POST', body: draftOf('new-event') })
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: string }).error).toBe(ADMIN_EVENT_ERRORS.slugTaken)
    expect(auditActions()).toContain('admin_event_create')
  })

  it('rejects a non-draft status with a validation issue on event.status', async () => {
    const res = await adminReq('', { method: 'POST', body: draftOf('new-event', { status: 'open' }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: { path: unknown[] }[] }
    expect(body.error).toBe('validation_failed')
    expect(body.issues.some((i) => i.path.join('.') === 'event.status')).toBe(true)
  })

  it('reserves the API\'s own sub-path names as slugs', async () => {
    const res = await adminReq('', { method: 'POST', body: draftOf('templates') })
    expect(res.status).toBe(409)
  })
})

describe('update guardrails', () => {
  it('keeps the slug immutable', async () => {
    const res = await adminReq(`/${SLUG}`, { method: 'PUT', body: draftOf('other-slug') })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe(ADMIN_EVENT_ERRORS.slugImmutable)
  })

  it('ignores the status in the body', async () => {
    const res = await adminReq(`/${SLUG}`, { method: 'PUT', body: draftOf(SLUG, { status: 'archived' }) })
    expect(res.status).toBe(200)
    const { seed: saved, warnings } = (await res.json()) as AdminEventUpdateResult
    expect(saved.event.status).toBe('open')
    expect(Array.isArray(warnings)).toBe(true)
    expect(auditActions()).toContain('admin_event_update')
  })

  it('refuses member limits that conflict with existing teams, reporting the current size', async () => {
    const team = await createTeam('owner@example.com', '兩人隊')
    await addMember(team, 'owner@example.com', 'mate@example.com')

    const tooSmall = await adminReq(`/${SLUG}`, {
      method: 'PUT',
      body: draftOf(SLUG, { status: 'open', minMembers: 1, maxMembers: 1, requiredContacts: 0 }),
    })
    expect(tooSmall.status).toBe(409)
    expect(await tooSmall.json()).toEqual({
      error: ADMIN_EVENT_ERRORS.maxMembersBelowExisting,
      current: 2,
    })

    const tooDemanding = await adminReq(`/${SLUG}`, {
      method: 'PUT',
      body: draftOf(SLUG, {
        status: 'open',
        minMembers: 3,
        maxMembers: Math.max(3, seed.event.maxMembers),
      }),
    })
    expect(tooDemanding.status).toBe(409)
    expect(await tooDemanding.json()).toEqual({
      error: ADMIN_EVENT_ERRORS.minMembersAboveExisting,
      current: 2,
    })
  })

  it('deletes a vanished key nobody uses, refuses one in use, and allows deactivating it', async () => {
    const used = seed.roles[0]!
    const unused = seed.roles[1]!
    await putParticipation('alice@example.com', [used.key], [])

    // Unused key removed from the body → row deleted.
    const dropUnused = draftOf(SLUG, { status: 'open' })
    dropUnused.roles = dropUnused.roles.filter((r) => r.key !== unused.key)
    const ok = await adminReq(`/${SLUG}`, { method: 'PUT', body: dropUnused })
    expect(ok.status).toBe(200)
    const detail = (await (await adminReq(`/${SLUG}`)).json()) as AdminEventDetail
    expect(detail.seed.roles.map((r) => r.key)).not.toContain(unused.key)

    // Used key removed → 409 with the key and the count.
    const dropUsed = draftOf(SLUG, { status: 'open' })
    dropUsed.roles = dropUsed.roles.filter((r) => r.key !== used.key && r.key !== unused.key)
    const refused = await adminReq(`/${SLUG}`, { method: 'PUT', body: dropUsed })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: ADMIN_EVENT_ERRORS.dictionaryKeyInUse,
      key: used.key,
      count: 1,
    })

    // Deactivating instead is fine: row kept, a warning explains the effect.
    const deactivate = draftOf(SLUG, { status: 'open' })
    deactivate.roles = deactivate.roles
      .filter((r) => r.key !== unused.key)
      .map((r) => (r.key === used.key ? { ...r, isActive: false } : r))
    const saved = await adminReq(`/${SLUG}`, { method: 'PUT', body: deactivate })
    expect(saved.status).toBe(200)
    const result = (await saved.json()) as AdminEventUpdateResult
    expect(result.seed.roles.find((r) => r.key === used.key)?.isActive).toBe(false)
    expect(result.warnings.some((w) => w.includes(used.label))).toBe(true)
    // Public detail hides the deactivated option.
    const pub = (await (await t.app.request(`/api/events/${SLUG}`)).json()) as EventSeed
    expect(pub.roles.map((r) => r.key)).not.toContain(used.key)
  })

  it('returns 404 for an unknown event', async () => {
    const res = await adminReq('/no-such-event', { method: 'PUT', body: draftOf('no-such-event') })
    expect(res.status).toBe(404)
  })
})

describe('status transitions', () => {
  const allowed: [EventStatus, EventStatus][] = [
    ['draft', 'open'],
    ['open', 'closed'],
    ['closed', 'open'],
    ['closed', 'archived'],
  ]

  it('accepts exactly the documented transitions', async () => {
    for (const from of EVENT_STATUSES) {
      for (const to of EVENT_STATUSES) {
        const slug = `matrix-${from}-${to}`
        await createDraft(slug)
        // Reach `from` through the memory repository (the matrix is about the rule, not the path).
        await t.eventAdminRepo.setStatus(slug, from)
        const res = await setStatus(slug, to)
        const isAllowed = allowed.some(([f, tt]) => f === from && tt === to)
        expect(res.status, `${from} -> ${to}`).toBe(isAllowed ? 200 : 409)
        if (isAllowed) {
          expect(((await res.json()) as { seed: EventSeed }).seed.event.status).toBe(to)
        } else {
          expect(await res.json()).toEqual({
            error: ADMIN_EVENT_ERRORS.invalidStatusTransition,
            from,
            to,
          })
        }
      }
    }
    expect(auditActions().filter((a) => a === 'admin_event_status')).toHaveLength(allowed.length)
  })

  it('refuses to open an incomplete draft and lists what is missing', async () => {
    const body = draftOf('incomplete', { recruitClosesAt: '2000-01-01T00:00:00+08:00' })
    body.roles = body.roles.map((r) => ({ ...r, isActive: false }))
    body.skills = []
    expect((await adminReq('', { method: 'POST', body })).status).toBe(201)
    const res = await setStatus('incomplete', 'open')
    expect(res.status).toBe(409)
    const err = (await res.json()) as { error: string; details: string[] }
    expect(err.error).toBe(ADMIN_EVENT_ERRORS.cannotOpenIncomplete)
    expect(err.details).toHaveLength(3)
    for (const d of err.details) expect(d).toMatch(/[一-鿿]/)
    // Still a draft, and the public API still does not know it.
    expect((await t.app.request('/api/events/incomplete')).status).toBe(404)
  })

  it('makes an opened draft visible publicly', async () => {
    await createDraft('goes-live')
    expect((await t.app.request('/api/events/goes-live')).status).toBe(404)
    expect((await setStatus('goes-live', 'open')).status).toBe(200)
    expect((await t.app.request('/api/events/goes-live')).status).toBe(200)
  })
})

describe('duplicate', () => {
  it('clones as a draft under the new slug and name, dictionaries included', async () => {
    const res = await adminReq(`/${SLUG}/duplicate`, {
      method: 'POST',
      body: { slug: 'copy-of-event', name: '複本活動' },
    })
    expect(res.status).toBe(201)
    const { seed: copy } = (await res.json()) as { seed: EventSeed }
    expect(copy.event).toEqual({ ...seed.event, slug: 'copy-of-event', name: '複本活動', status: 'draft' })
    expect(copy.roles.map((r) => r.key).sort()).toEqual(seed.roles.map((r) => r.key).sort())
    expect(copy.skills.map((s) => s.key).sort()).toEqual(seed.skills.map((s) => s.key).sort())
    expect(t.auditRepo.entries.find((e) => e.action === 'admin_event_duplicate')?.targetId).toBe(
      'copy-of-event',
    )
    // The source is untouched.
    expect((await t.app.request(`/api/events/${SLUG}`)).status).toBe(200)
  })

  it('refuses a taken slug and validates the body', async () => {
    const taken = await adminReq(`/${SLUG}/duplicate`, {
      method: 'POST',
      body: { slug: SLUG, name: '複本' },
    })
    expect(taken.status).toBe(409)
    const bad = await adminReq(`/${SLUG}/duplicate`, {
      method: 'POST',
      body: { slug: 'Bad Slug', name: '' },
    })
    expect(bad.status).toBe(400)
  })
})

describe('delete', () => {
  it('removes an empty draft (204) and audits it', async () => {
    await createDraft('throwaway')
    const res = await adminReq('/throwaway', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect((await adminReq('/throwaway')).status).toBe(404)
    expect(auditActions()).toContain('admin_event_delete')
  })

  it('refuses non-drafts and drafts with data', async () => {
    const open = await adminReq(`/${SLUG}`, { method: 'DELETE' })
    expect(open.status).toBe(409)
    expect(((await open.json()) as { error: string }).error).toBe(
      ADMIN_EVENT_ERRORS.invalidStatusTransition,
    )

    // A draft that once had participants (data written while open, then reverted in the store).
    await createDraft('had-people')
    await t.eventAdminRepo.setStatus('had-people', 'open')
    const joined = await t.app.request('/api/events/had-people/participation', {
      method: 'PUT',
      headers: jsonHeaders(USER),
      body: JSON.stringify({ intent: 'browsing', preferredRoles: [], skills: [], blurb: '', isAdult: true }),
    })
    expect(joined.status).toBe(200)
    await t.eventAdminRepo.setStatus('had-people', 'draft')
    const notEmpty = await adminReq('/had-people', { method: 'DELETE' })
    expect(notEmpty.status).toBe(409)
    expect(((await notEmpty.json()) as { error: string }).error).toBe(ADMIN_EVENT_ERRORS.eventNotEmpty)
  })
})

describe('export', () => {
  it('downloads seed-compatible JSON that round-trips through EventSeedSchema', async () => {
    const res = await adminReq(`/${SLUG}/export`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${SLUG}.json"`)
    const body = await res.json()
    const parsed = EventSeedSchema.parse(body)
    expect(parsed.event).toEqual(seed.event)
    expect(parsed.roles.map((r) => r.key).sort()).toEqual(seed.roles.map((r) => r.key).sort())
    expect(parsed.skills.map((s) => s.key).sort()).toEqual(seed.skills.map((s) => s.key).sort())
  })
})

describe('public visibility', () => {
  it('lists only open/closed events; drafts 404 and archived stay readable by link', async () => {
    await createDraft('hidden-draft')
    await createDraft('to-archive')
    await t.eventAdminRepo.setStatus('to-archive', 'closed')
    expect((await setStatus('to-archive', 'archived')).status).toBe(200)
    await createDraft('closed-one')
    await t.eventAdminRepo.setStatus('closed-one', 'closed')

    const list = (await (await t.app.request('/api/events')).json()) as { events: EventSummary[] }
    expect(list.events.map((e) => e.slug).sort()).toEqual([SLUG, 'closed-one'].sort())
    expect((await t.app.request('/api/events/hidden-draft')).status).toBe(404)
    expect((await t.app.request('/api/events/to-archive')).status).toBe(200)

    const adminList = (await (await adminReq('')).json()) as { items: AdminEventSummary[] }
    expect(adminList.items.map((i) => i.slug)).toEqual([SLUG, 'hidden-draft', 'closed-one', 'to-archive'])
  })
})

describe('audit trail', () => {
  it('records every write with targetType event and the slug', async () => {
    await createDraft('audited')
    await adminReq('/audited', { method: 'PUT', body: draftOf('audited') })
    await setStatus('audited', 'open')
    await adminReq('/audited/duplicate', { method: 'POST', body: { slug: 'audited-copy', name: '副本' } })
    await adminReq('/audited-copy', { method: 'DELETE' })
    const adminId = await userIdOf(t, ADMIN)
    const entries = t.auditRepo.entries.filter((e) => e.action.startsWith('admin_event_'))
    expect(entries.map((e) => e.action)).toEqual([
      'admin_event_create',
      'admin_event_update',
      'admin_event_status',
      'admin_event_duplicate',
      'admin_event_delete',
    ])
    for (const e of entries) {
      expect(e.targetType).toBe('event')
      expect(e.actorUserId).toBe(adminId)
    }
    expect(entries.map((e) => e.targetId)).toEqual([
      'audited',
      'audited',
      'audited',
      'audited-copy',
      'audited-copy',
    ])
  })
})
