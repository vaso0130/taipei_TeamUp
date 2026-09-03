import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Email handling (spec §7.3): plaintext email is never stored.
 * - email_ciphertext: envelope-encrypted (FieldCipher)
 * - email_lookup: HMAC-SHA256(normalize(email), pepper) — unique index,
 *   used for dedup and login matching. The pepper lives in Secret
 *   Manager only, so the lookup value cannot be brute-forced offline
 *   from a DB dump alone.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().normalize('NFC')
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

/** Display-only hint, e.g. "w***@gmail.com". Never the full address. */
export function emailHint(email: string): string {
  const normalized = normalizeEmail(email)
  const at = normalized.indexOf('@')
  if (at <= 0) return '***'
  return `${normalized[0]}***${normalized.slice(at)}`
}
