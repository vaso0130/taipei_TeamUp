import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emailHint, emailLookupHmac, lookupEquals, normalizeEmail } from '../src/crypto/email.js'
import { FieldCipher } from '../src/crypto/envelope.js'
import { LocalKek } from '../src/crypto/kek.js'

const kekKey = randomBytes(32).toString('base64')
const cipher = new FieldCipher(new LocalKek(kekKey))

describe('LocalKek', () => {
  it('rejects keys that are not 32 bytes', () => {
    expect(() => new LocalKek(Buffer.from('short').toString('base64'))).toThrowError(/32 bytes/)
  })

  it('wraps and unwraps a DEK', async () => {
    const kek = new LocalKek(kekKey)
    const dek = randomBytes(32)
    const wrapped = await kek.wrapDek(dek)
    expect(wrapped.equals(dek)).toBe(false)
    expect((await kek.unwrapDek(wrapped)).equals(dek)).toBe(true)
  })
})

describe('FieldCipher (envelope encryption)', () => {
  it('round-trips UTF-8 content', async () => {
    const plaintext = 'mei.hua@example.com — 中文也要正確 ✓'
    const blob = await cipher.encrypt(plaintext)
    expect(blob.includes(Buffer.from(plaintext, 'utf8'))).toBe(false)
    expect(await cipher.decrypt(blob)).toBe(plaintext)
  })

  it('uses a fresh DEK per record (same plaintext, different blobs)', async () => {
    const a = await cipher.encrypt('same@example.com')
    const b = await cipher.encrypt('same@example.com')
    expect(a.equals(b)).toBe(false)
  })

  it('fails on tampered ciphertext (GCM auth)', async () => {
    const blob = await cipher.encrypt('victim@example.com')
    const last = blob.length - 1
    blob.writeUInt8(blob.readUInt8(last) ^ 0xff, last)
    await expect(cipher.decrypt(blob)).rejects.toThrow()
  })

  it('fails when decrypted with a different KEK', async () => {
    const other = new FieldCipher(new LocalKek(randomBytes(32).toString('base64')))
    const blob = await cipher.encrypt('victim@example.com')
    await expect(other.decrypt(blob)).rejects.toThrow()
  })

  it('rejects unknown envelope versions', async () => {
    const blob = await cipher.encrypt('x@example.com')
    blob.writeUInt8(9, 0)
    await expect(cipher.decrypt(blob)).rejects.toThrowError(/version/)
  })
})

describe('email normalization and lookup HMAC', () => {
  const pepper = 'test-pepper-that-is-long-enough-0123456789'

  it('normalizes case and whitespace', () => {
    expect(normalizeEmail('  Mei.Hua@Example.com ')).toBe('mei.hua@example.com')
  })

  it('drops +tag sub-addresses for every domain', () => {
    expect(normalizeEmail('user+promo@example.com')).toBe('user@example.com')
    expect(normalizeEmail('user+a+b@example.com')).toBe('user@example.com')
    // A leading plus is not a tag separator.
    expect(normalizeEmail('+weird@example.com')).toBe('+weird@example.com')
    // Dots are significant outside Gmail.
    expect(normalizeEmail('first.last@example.com')).toBe('first.last@example.com')
  })

  it('collapses Gmail dot and domain aliases onto one canonical address', () => {
    const canonical = 'meihua@gmail.com'
    for (const variant of [
      'mei.hua@gmail.com',
      'm.e.i.h.u.a@gmail.com',
      'MeiHua@GMAIL.COM',
      'meihua+teamup@gmail.com',
      'mei.hua+x@googlemail.com',
      'meihua@googlemail.com',
    ]) {
      expect(normalizeEmail(variant), variant).toBe(canonical)
      expect(lookupEquals(emailLookupHmac(variant, pepper), emailLookupHmac(canonical, pepper))).toBe(true)
    }
    // Distinct mailboxes stay distinct.
    expect(normalizeEmail('meihua2@gmail.com')).not.toBe(canonical)
  })

  it('leaves malformed input harmless', () => {
    expect(normalizeEmail('no-at-sign')).toBe('no-at-sign')
    expect(normalizeEmail('@gmail.com')).toBe('@gmail.com')
  })

  it('same email (differently written) yields the same lookup value', () => {
    const a = emailLookupHmac('User@Example.com', pepper)
    const b = emailLookupHmac(' user@example.com', pepper)
    expect(lookupEquals(a, b)).toBe(true)
  })

  it('different pepper yields a different lookup value', () => {
    const a = emailLookupHmac('user@example.com', pepper)
    const b = emailLookupHmac('user@example.com', `${pepper}-other`)
    expect(lookupEquals(a, b)).toBe(false)
  })

  it('rejects a weak pepper', () => {
    expect(() => emailLookupHmac('user@example.com', 'short')).toThrowError(/32/)
  })

  it('lookup value does not reveal the email', () => {
    const a = emailLookupHmac('user@example.com', pepper)
    expect(a.toString('utf8')).not.toContain('example')
    expect(a.length).toBe(32)
  })
})

describe('emailHint', () => {
  it('masks the local part', () => {
    expect(emailHint('mei.hua@example.com')).toBe('m***@example.com')
  })

  it('never returns the input for malformed addresses', () => {
    expect(emailHint('not-an-email')).toBe('***')
  })
})
