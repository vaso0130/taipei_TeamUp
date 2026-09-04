import { describe, expect, it } from 'vitest'
import type { ExpandUrlResult } from '@teamup/shared'
import { expandUrl, isPrivateIp, type HopFetcher } from '../src/tools/url-expander.js'
import { loadEventSeeds } from '../src/events/seed-loader.js'
import { buildTestApp } from './helpers.js'

/** Fake requester: a redirect map, everything else answers 200. */
const fakeFetcher =
  (redirects: Record<string, string>): HopFetcher =>
  (url) => {
    const to = redirects[url.href]
    return Promise.resolve(to ? { status: 302, location: to } : { status: 200, location: null })
  }

describe('isPrivateIp', () => {
  it('blocks loopback, RFC1918, link-local and cloud metadata', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.8.1',
      '192.168.1.1',
      '169.254.169.254', // GCP metadata server
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:192.168.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
  })

  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '199.36.158.100', '2001:4860:4860::8888']) {
      expect(isPrivateIp(ip), ip).toBe(false)
    }
  })
})

describe('expandUrl', () => {
  it('follows a redirect chain to its destination', async () => {
    const result = await expandUrl(
      'https://sho.rt/a',
      fakeFetcher({
        'https://sho.rt/a': 'https://mid.example/b',
        'https://mid.example/b': 'https://final.example/page',
      }),
    )
    expect(result.finalUrl).toBe('https://final.example/page')
    expect(result.hops.map((h) => h.status)).toEqual([302, 302, 200])
    expect(result.warnings).toEqual([])
  })

  it('accepts a bare domain the way people paste it', async () => {
    const result = await expandUrl('final.example/page', fakeFetcher({}))
    expect(result.finalUrl).toBe('https://final.example/page')
  })

  it('refuses literal private targets without ever connecting', async () => {
    const never: HopFetcher = () => Promise.reject(new Error('must not be called'))
    for (const bad of ['http://127.0.0.1/admin', 'http://169.254.169.254/computeMetadata']) {
      const result = await expandUrl(bad, never)
      expect(result.warnings).toContain('blocked_private')
      expect(result.finalUrl).toBeNull()
    }
  })

  it('refuses redirects into private space or odd schemes/ports', async () => {
    const toPrivate = await expandUrl(
      'https://sho.rt/a',
      fakeFetcher({ 'https://sho.rt/a': 'http://192.168.0.1/router' }),
    )
    expect(toPrivate.warnings).toContain('blocked_private')

    const toFtp = await expandUrl(
      'https://sho.rt/a',
      fakeFetcher({ 'https://sho.rt/a': 'ftp://files.example/x' }),
    )
    expect(toFtp.warnings).toContain('unsupported_scheme')

    const toPort = await expandUrl(
      'https://sho.rt/a',
      fakeFetcher({ 'https://sho.rt/a': 'http://internal.example:8080/x' }),
    )
    expect(toPort.warnings).toContain('blocked_private')
  })

  it('flags loops, plain-http finals, userinfo and IDN hosts', async () => {
    const loop = await expandUrl(
      'https://a.example/',
      fakeFetcher({ 'https://a.example/': 'https://b.example/', 'https://b.example/': 'https://a.example/' }),
    )
    expect(loop.warnings).toContain('redirect_loop')

    const plain = await expandUrl('http://plain.example/', fakeFetcher({}))
    expect(plain.warnings).toContain('not_https')

    const tricky = await expandUrl('https://bank.com:evil@scam.example/', fakeFetcher({}))
    expect(tricky.warnings).toContain('userinfo')

    const idn = await expandUrl('https://xn--ej4a.taipei/', fakeFetcher({}))
    expect(idn.warnings).toContain('idn_host')
  })

  it('gives up after the redirect budget', async () => {
    const redirects: Record<string, string> = {}
    for (let i = 0; i < 15; i++) redirects[`https://x.example/${i}`] = `https://x.example/${i + 1}`
    const result = await expandUrl('https://x.example/0', fakeFetcher(redirects))
    expect(result.warnings).toContain('too_many_redirects')
    expect(result.finalUrl).toBeNull()
  })
})

describe('POST /api/tools/expand-url', () => {
  it('is public and returns the chain', async () => {
    const seeds = loadEventSeeds()
    const t = buildTestApp(seeds, {
      hopFetcher: fakeFetcher({ 'https://sho.rt/x': 'https://real.example/landing' }),
    })
    const res = await t.app.request('/api/tools/expand-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://sho.rt/x' }),
    })
    expect(res.status).toBe(200)
    const parsed = (await res.json()) as ExpandUrlResult
    expect(parsed.finalUrl).toBe('https://real.example/landing')
    expect(parsed.hops).toHaveLength(2)
  })
})
