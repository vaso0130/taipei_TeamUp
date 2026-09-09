import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Email handling (spec §7.3): plaintext email is never stored.
 * - email_ciphertext: envelope-encrypted (FieldCipher)
 * - email_lookup: HMAC-SHA256(normalize(email), pepper) — unique index,
 *   used for dedup and login matching. The pepper lives in Secret
 *   Manager only, so the lookup value cannot be brute-forced offline
 *   from a DB dump alone.
 */

/** Providers whose local part ignores dots and that share one mailbox namespace. */
const DOT_INSENSITIVE_DOMAINS = new Map<string, string>([
  ['gmail.com', 'gmail.com'],
  ['googlemail.com', 'gmail.com'],
])

/**
 * Canonical identity form of an address. One person must map to one
 * account, so provider-level aliases collapse (spec §8 abuse limits are
 * per account):
 * - case / surrounding whitespace / Unicode normalization (NFC)
 * - `+tag` sub-addresses are dropped for every domain
 * - gmail.com / googlemail.com: dots in the local part are ignored and
 *   the domain is unified to gmail.com
 */
export function normalizeEmail(email: string): string {
  const base = email.trim().toLowerCase().normalize('NFC')
  const at = base.lastIndexOf('@')
  if (at <= 0) return base
  let local = base.slice(0, at)
  let domain = base.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  const unifiedDomain = DOT_INSENSITIVE_DOMAINS.get(domain)
  if (unifiedDomain) {
    local = local.replaceAll('.', '')
    domain = unifiedDomain
  }
  return `${local}@${domain}`
}

export function emailLookupHmac(email: string, pepper: string): Buffer {
  if (pepper.length < 32) {
    throw new Error('EMAIL_HMAC_PEPPER must be at least 32 characters')
  }
  return createHmac('sha256', pepper).update(normalizeEmail(email), 'utf8').digest()
}

export function lookupEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Constant-time comparison for shared secrets carried in headers. */
export function secretEquals(a: string | undefined, b: string): boolean {
  if (a === undefined) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/** Display-only hint, e.g. "w***@gmail.com". Never the full address. */
export function emailHint(email: string): string {
  const normalized = normalizeEmail(email)
  const at = normalized.indexOf('@')
  if (at <= 0) return '***'
  return `${normalized[0]}***${normalized.slice(at)}`
}
