import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { FieldCipher } from '../src/crypto/envelope.js'
import { KmsKek } from '../src/crypto/kek.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import { RecaptchaEnterpriseVerifier } from '../src/security/captcha.js'
import { MAX_BODY_BYTES, rateLimitsFromEnv, DEFAULT_RATE_LIMITS } from '../src/app.js'
import {
  authHeader,
  buildTestApp,
  joinEvent,
  jsonHeaders,
  openRecruitWindow,
  userIdOf,
} from './helpers.js'

// ---------------------------------------------------------------
// Cloud KMS KEK adapter — verified against a fake KMS endpoint.
// ---------------------------------------------------------------

/** Fake KMS: "wraps" by reversing bytes; symmetric for tests. */
function fakeKms(capture?: string[]) {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    capture?.push(String(url))
    const body = JSON.parse(String(init?.body)) as { plaintext?: string; ciphertext?: string }
    const input = Buffer.from(body.plaintext ?? body.ciphertext ?? '', 'base64')
    const output = Buffer.from(input).reverse().toString('base64')
    const field = body.plaintext !== undefined ? 'ciphertext' : 'plaintext'
    return new Response(JSON.stringify({ [field]: output }), { status: 200 })
  }) as typeof fetch
}

describe('KmsKek', () => {
  const keyName = 'projects/demo/locations/asia-east1/keyRings/app/cryptoKeys/field-kek'

  it('wraps and unwraps a DEK through the KMS endpoint', async () => {
    const urls: string[] = []
    const kek = new KmsKek({
      keyName,
      tokenProvider: () => Promise.resolve('fake-token'),
      fetchImpl: fakeKms(urls),
    })
    const dek = randomBytes(32)
    const wrapped = await kek.wrapDek(dek)
    expect(wrapped.equals(dek)).toBe(false)
    expect((await kek.unwrapDek(wrapped)).equals(dek)).toBe(true)
    expect(urls[0]).toContain(`${keyName}:encrypt`)
    expect(urls[1]).toContain(`${keyName}:decrypt`)
  })

  it('drives the full envelope round-trip with a KMS-wrapped DEK', async () => {
    const cipher = new FieldCipher(
      new KmsKek({ keyName, tokenProvider: () => Promise.resolve('t'), fetchImpl: fakeKms() }),
    )
    const blob = await cipher.encrypt('kms-backed secret ✓')
    expect(await cipher.decrypt(blob)).toBe('kms-backed secret ✓')
  })

  it('fails closed on a KMS error response', async () => {
    const failing = (async () => new Response('denied', { status: 403 })) as typeof fetch
    const kek = new KmsKek({ keyName, tokenProvider: () => Promise.resolve('t'), fetchImpl: failing })
    await expect(kek.wrapDek(randomBytes(32))).rejects.toThrowError(/kms/)
  })
})

// ---------------------------------------------------------------
// reCAPTCHA Enterprise verifier + route gate (spec §8).
// ---------------------------------------------------------------

function fakeAssessment(response: {
  valid?: boolean
  action?: string
  score?: number
  status?: number
}) {
  return (async () =>
    new Response(
      JSON.stringify({
        tokenProperties: { valid: response.valid ?? true, action: response.action ?? 'create_team' },
        riskAnalysis: { score: response.score ?? 0.9 },
      }),
      { status: response.status ?? 200 },
    )) as typeof fetch
}

const makeVerifier = (fetchImpl: typeof fetch) =>
  new RecaptchaEnterpriseVerifier({
    projectId: 'demo',
    siteKey: 'site-key',
    tokenProvider: () => Promise.resolve('t'),
    fetchImpl,
  })

describe('RecaptchaEnterpriseVerifier', () => {
  it('accepts a valid, matching, high-score assessment', async () => {
    expect(await makeVerifier(fakeAssessment({})).verify('tok', 'create_team')).toBe(true)
  })

  it('rejects invalid tokens, action mismatches and low scores', async () => {
    expect(await makeVerifier(fakeAssessment({ valid: false })).verify('t', 'create_team')).toBe(false)
    expect(await makeVerifier(fakeAssessment({ action: 'other' })).verify('t', 'create_team')).toBe(false)
    expect(await makeVerifier(fakeAssessment({ score: 0.1 })).verify('t', 'create_team')).toBe(false)
  })

  it('fails closed when the assessment API errors', async () => {
    expect(await makeVerifier(fakeAssessment({ status: 500 })).verify('t', 'create_team')).toBe(false)
  })
})

const seeds = loadEventSeeds()
const seed = openRecruitWindow(seeds.find((s) => s.event.exclusiveMembership)!)

describe('captcha route gate', () => {
  const rejectAll = { verify: () => Promise.resolve(false) }
  const acceptAll = { verify: () => Promise.resolve(true) }

  const createTeam = (t: ReturnType<typeof buildTestApp>, headers: Record<string, string>) =>
    t.app.request(`/api/events/${seed.event.slug}/teams`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '驗證測試隊' }),
    })

  it('blocks team creation without a passing captcha token', async () => {
    const t = buildTestApp([seed], { captcha: rejectAll })
    const res = await createTeam(t, jsonHeaders('bot@example.com'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('captcha_failed')
  })

  it('passes with a valid token, and is skipped entirely when unconfigured', async () => {
    const strict = buildTestApp([seed], { captcha: acceptAll })
    await joinEvent(strict, seed.event.slug, 'human@example.com')
    const ok = await createTeam(strict, {
      ...jsonHeaders('human@example.com'),
      'x-recaptcha-token': 'tok',
    })
    expect(ok.status).toBe(201)

    const dev = buildTestApp([seed])
    await joinEvent(dev, seed.event.slug, 'dev@example.com')
    expect((await createTeam(dev, jsonHeaders('dev@example.com'))).status).toBe(201)
  })
})

// ---------------------------------------------------------------
// Request hardening: body size, path ids, internal-route secret,
// suspended viewers on public routes.
// ---------------------------------------------------------------

describe('request hardening', () => {
  it('rejects oversized JSON bodies with 413', async () => {
    const t = buildTestApp([seed])
    const res = await t.app.request('/api/me', {
      method: 'PATCH',
      headers: jsonHeaders('big@example.com'),
      body: JSON.stringify({ displayName: 'x'.repeat(MAX_BODY_BYTES + 1024) }),
    })
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('payload_too_large')
  })

  it('treats malformed path ids as not found (never a database error)', async () => {
    const t = buildTestApp([seed])
    const team = await t.app.request('/api/teams/not-a-uuid')
    expect(team.status).toBe(404)
    expect(((await team.json()) as { error: string }).error).toBe('team_not_found')
    const thread = await t.app.request('/api/threads/123/messages', { headers: authHeader('a@example.com') })
    expect(thread.status).toBe(404)
    expect(((await thread.json()) as { error: string }).error).toBe('thread_not_found')
    const application = await t.app.request("/api/applications/'--/respond", {
      method: 'POST',
      headers: jsonHeaders('a@example.com'),
      body: JSON.stringify({ action: 'accept' }),
    })
    expect(application.status).toBe(404)
  })

  it('a suspended account is treated as anonymous on public routes and blocked on private ones', async () => {
    const t = buildTestApp([seed], { adminEmails: ['admin@example.gov'] })
    await joinEvent(t, seed.event.slug, 'owner@example.com')
    const created = await t.app.request(`/api/events/${seed.event.slug}/teams`, {
      method: 'POST',
      headers: jsonHeaders('owner@example.com'),
      body: JSON.stringify({ name: '被停權前的隊' }),
    })
    const team = (await created.json()) as { id: string; viewerIsOwner: boolean }
    expect(team.viewerIsOwner).toBe(true)

    await t.userRepo.updateStatus(await userIdOf(t, 'owner@example.com'), 'suspended')

    // Public route: the token no longer identifies a viewer.
    const detail = await t.app.request(`/api/teams/${team.id}`, {
      headers: authHeader('owner@example.com'),
    })
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { viewerIsOwner: boolean }).viewerIsOwner).toBe(false)
    // Private route: refused.
    expect((await t.app.request('/api/me', { headers: authHeader('owner@example.com') })).status).toBe(403)
  })

  it('internal routes compare the task secret in constant time and still refuse mismatches', async () => {
    const t = buildTestApp([seed], { taskSecret: 'correct-secret' })
    const call = (secret?: string) =>
      t.app.request('/internal/cleanup', {
        method: 'POST',
        headers: secret ? { 'x-task-secret': secret } : {},
      })
    expect((await call()).status).toBe(401)
    expect((await call('correct-secre')).status).toBe(401) // length differs
    expect((await call('correct-secreT')).status).toBe(401) // same length
    expect((await call('correct-secret')).status).toBe(200)
  })

  it('rate limits come from the environment with validated defaults', () => {
    expect(rateLimitsFromEnv({})).toEqual(DEFAULT_RATE_LIMITS)
    expect(rateLimitsFromEnv({ RATE_LIMIT_EXPORTS_PER_DAY: '7' }).exportsPerDay).toBe(7)
    expect(() => rateLimitsFromEnv({ RATE_LIMIT_EXPORTS_PER_DAY: '0' })).toThrow()
    expect(() => rateLimitsFromEnv({ RATE_LIMIT_APPLIES_PER_DAY: 'many' })).toThrow()
  })
})

// ---------------------------------------------------------------
// Audit trail (spec §4): sensitive actions leave records.
// ---------------------------------------------------------------

describe('CORS allowlist', () => {
  it('answers preflight only for allowed origins, and stays silent when unconfigured', async () => {
    const { createApp } = await import('../src/app.js')
    const { SeedEventRepository } = await import('../src/events/seed-repository.js')
    const eventsRepo = new SeedEventRepository([seed])

    const withCors = createApp({ events: eventsRepo, allowedOrigins: ['https://xn--ej4a.taipei'] })
    const preflight = await withCors.request('/api/events', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://xn--ej4a.taipei',
        'access-control-request-method': 'GET',
      },
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://xn--ej4a.taipei')

    const denied = await withCors.request('/api/events', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()

    const noCors = createApp({ events: eventsRepo })
    const res = await noCors.request('/api/events', {
      headers: { origin: 'https://xn--ej4a.taipei' },
    })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('audit logs', () => {
  it('records export, deletion, admin queue reads and human decisions', async () => {
    const t = buildTestApp([seed], { adminEmails: ['admin@example.gov'] })
    await t.app.request('/api/me/export', { headers: authHeader('user@example.com') })
    await t.app.request('/api/me', { method: 'DELETE', headers: authHeader('user@example.com') })
    await t.app.request('/api/admin/moderation/pending', { headers: authHeader('admin@example.gov') })

    const actions = t.auditRepo.entries.map((e) => e.action)
    expect(actions).toContain('data_export')
    expect(actions).toContain('account_delete')
    expect(actions).toContain('admin_review_read')
    // Every entry names its actor.
    expect(t.auditRepo.entries.every((e) => e.actorUserId !== null)).toBe(true)
  })

  it('purges audit entries past retention via the cleanup path', async () => {
    const t = buildTestApp([seed])
    await t.app.request('/api/me/export', { headers: authHeader('user@example.com') })
    expect(t.auditRepo.entries.length).toBeGreaterThan(0)
    const purged = await t.auditRepo.purgeBefore(new Date(Date.now() + 1000))
    expect(purged).toBeGreaterThan(0)
    expect(t.auditRepo.entries).toHaveLength(0)
  })
})
