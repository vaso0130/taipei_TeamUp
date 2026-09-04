import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { ExpandHop, ExpandUrlResult, ExpandWarning } from '@teamup/shared'

/**
 * Anti-scam URL expander (public tool): follow a short URL's redirect
 * chain server-side — no JS execution, no cookies — and report every
 * hop. Security posture:
 *
 * - SSRF: every hop must resolve to a public address. The check runs
 *   inside the socket's own DNS lookup, so the vetted IP is the one
 *   actually connected to (no resolve-then-connect TOCTOU, which on
 *   Cloud Run would otherwise expose the metadata server).
 * - Only http/https, only default ports 80/443.
 * - Responses are never read past the headers; bodies are discarded.
 */

const MAX_HOPS = 10
const HOP_TIMEOUT_MS = 5000

/** RFC1918 + loopback + link-local (incl. cloud metadata) + reserved. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 169 && b === 254) return true // link-local & metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && parts[1] === 0 && parts[2] === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
    if (a >= 224) return true // multicast + reserved
    return false
  }
  const lower = ip.toLowerCase()
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — judge the embedded IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return isPrivateIp(mapped[1]!)
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA fc00::/7
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
    return true // link-local fe80::/10
  return false
}

/** One redirect-chain step: status + Location, body discarded. */
export interface HopFetcher {
  (url: URL): Promise<{ status: number; location: string | null }>
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void

/**
 * DNS lookup that refuses private results. Node's dns.lookup overloads
 * don't line up with net.LookupFunction, hence the narrow cast.
 */
const rawLookup = dnsLookup as unknown as (
  hostname: string,
  options: unknown,
  callback: LookupCallback,
) => void

const guardedLookup: import('node:net').LookupFunction = (hostname, options, callback) => {
  rawLookup(hostname, options, (err, address, family) => {
    if (err) return (callback as LookupCallback)(err, address, family)
    const entries =
      typeof address === 'string' ? [{ address, family: family ?? 0 }] : address
    if (entries.some((e) => isPrivateIp(e.address))) {
      return (callback as LookupCallback)(
        Object.assign(new Error('private address blocked'), { code: 'EPRIVATE' }),
        address,
        family,
      )
    }
    ;(callback as LookupCallback)(null, address, family)
  })
}

export const httpHopFetcher: HopFetcher = (url) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        timeout: HOP_TIMEOUT_MS,
        headers: {
          'user-agent': 'taipei-pei-linkcheck/1.0 (+https://xn--ej4a.taipei/check)',
          accept: '*/*',
        },
      },
      (res) => {
        const location = res.headers.location ?? null
        res.destroy() // headers only — never download the body
        resolve({ status: res.statusCode ?? 0, location })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

function parseHop(raw: string, base?: URL): { url?: URL; problem?: ExpandWarning } {
  let url: URL
  try {
    url = base ? new URL(raw, base) : new URL(raw)
  } catch {
    return {}
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: 'unsupported_scheme' }
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return { problem: 'blocked_private' }
  }
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(url.hostname.replace(/^\[|\]$/g, ''))) {
    return { problem: 'blocked_private' }
  }
  return { url }
}

export async function expandUrl(
  input: string,
  fetchHop: HopFetcher = httpHopFetcher,
): Promise<ExpandUrlResult> {
  // Bare "example.com/x" is accepted the way a citizen would paste it.
  const raw = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input.trim())
    ? input.trim()
    : `https://${input.trim()}`
  const first = parseHop(raw)
  if (first.problem) return { hops: [], finalUrl: null, warnings: [first.problem] }
  if (!first.url) return { hops: [], finalUrl: null, warnings: [], error: 'invalid_url' }

  const warnings = new Set<ExpandWarning>()
  const hops: ExpandHop[] = []
  const seen = new Set<string>()
  let current: URL = first.url

  for (let i = 0; i < MAX_HOPS; i++) {
    if (current.username !== '' || current.password !== '') warnings.add('userinfo')
    if (net.isIP(current.hostname.replace(/^\[|\]$/g, ''))) warnings.add('ip_host')
    if (current.hostname.includes('xn--')) warnings.add('idn_host')
    if (seen.has(current.href)) {
      warnings.add('redirect_loop')
      return { hops, finalUrl: null, warnings: [...warnings] }
    }
    seen.add(current.href)

    let status: number
    let location: string | null
    try {
      ;({ status, location } = await fetchHop(current))
    } catch (err) {
      hops.push({ url: current.href, status: null })
      warnings.add(
        (err as { code?: string }).code === 'EPRIVATE' ? 'blocked_private' : 'unreachable',
      )
      return { hops, finalUrl: null, warnings: [...warnings] }
    }
    hops.push({ url: current.href, status })

    if (!REDIRECT_STATUS.has(status) || !location) {
      if (current.protocol !== 'https:') warnings.add('not_https')
      if (hops.length >= 4) warnings.add('many_hops')
      return { hops, finalUrl: current.href, warnings: [...warnings] }
    }
    const next = parseHop(location, current)
    if (next.problem) {
      warnings.add(next.problem)
      return { hops, finalUrl: null, warnings: [...warnings] }
    }
    if (!next.url) {
      warnings.add('unreachable')
      return { hops, finalUrl: null, warnings: [...warnings] }
    }
    current = next.url
  }
  warnings.add('too_many_redirects')
  return { hops, finalUrl: null, warnings: [...warnings] }
}
