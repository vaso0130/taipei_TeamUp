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
    expect(normalizeEmail('  Mei.Hua@GMAIL.com ')).toBe('mei.hua@gmail.com')
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
