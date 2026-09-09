import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emailLookupHmac, legacyEmailLookupHmac, lookupEquals } from '../src/crypto/email.js'
import { FieldCipher } from '../src/crypto/envelope.js'
import { LocalKek } from '../src/crypto/kek.js'
import { MemoryUserRepository } from '../src/users/memory-repository.js'
import { UserService } from '../src/users/service.js'

const OLD_PEPPER = 'old-pepper-that-is-long-enough-0123456789abc'
const NEW_PEPPER = 'new-pepper-that-is-long-enough-0123456789xyz'
const cipher = new FieldCipher(new LocalKek(randomBytes(32).toString('base64')))

describe('UserService.ensureUser', () => {
  it('re-hashes a lookup created under the previous pepper on the first login after rotation', async () => {
    const repo = new MemoryUserRepository()
    const before = new UserService(repo, cipher, OLD_PEPPER)
    const created = await before.ensureUser('rotate@example.com')

    const after = new UserService(repo, cipher, NEW_PEPPER, { previousPepper: OLD_PEPPER })
    const found = await after.ensureUser('rotate@example.com')
    expect(found.id).toBe(created.id)

    // The row now carries the current-pepper lookup…
    const stored = (await repo.findById(created.id))!
    expect(lookupEquals(stored.emailLookup, emailLookupHmac('rotate@example.com', NEW_PEPPER))).toBe(true)
    // …so a service WITHOUT the previous pepper resolves it too.
    const rotated = new UserService(repo, cipher, NEW_PEPPER)
    expect((await rotated.ensureUser('rotate@example.com')).id).toBe(created.id)
    expect(await repo.findByLookup(emailLookupHmac('rotate@example.com', OLD_PEPPER))).toBeNull()
  })

  it('without the previous pepper a rotated deployment would mint a new account (the documented failure mode)', async () => {
    const repo = new MemoryUserRepository()
    const created = await new UserService(repo, cipher, OLD_PEPPER).ensureUser('lost@example.com')
    const naive = await new UserService(repo, cipher, NEW_PEPPER).ensureUser('lost@example.com')
    expect(naive.id).not.toBe(created.id)
  })

  it('a soft-deleted row is tombstoned and the same address gets a brand-new account', async () => {
    const repo = new MemoryUserRepository()
    const service = new UserService(repo, cipher, NEW_PEPPER)
    const first = await service.ensureUser('again@example.com')
    await repo.updateDisplayName(first.id, '（已刪除的帳號）')
    await repo.updateStatus(first.id, 'deleted')

    const second = await service.ensureUser('again@example.com')
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('active')
    expect(second.displayName).not.toBe('（已刪除的帳號）')

    // Old row still exists (purged later by cleanup) but no longer owns the address.
    const old = (await repo.findById(first.id))!
    expect(old.status).toBe('deleted')
    expect(lookupEquals(old.emailLookup, emailLookupHmac('again@example.com', NEW_PEPPER))).toBe(false)
    // Stable from here on: the same login keeps resolving to the new row.
    expect((await service.ensureUser('again@example.com')).id).toBe(second.id)
  })

  it('a suspended row is returned as-is (never recreated)', async () => {
    const repo = new MemoryUserRepository()
    const service = new UserService(repo, cipher, NEW_PEPPER)
    const first = await service.ensureUser('banned@example.com')
    await repo.updateStatus(first.id, 'suspended')
    const again = await service.ensureUser('banned@example.com')
    expect(again.id).toBe(first.id)
    expect(again.status).toBe('suspended')
  })

  it('finds a row hashed under the pre-alias-collapsing form and re-hashes it on login', async () => {
    const repo = new MemoryUserRepository()
    const legacyRow = await repo.create({
      id: '01900000-0000-7000-8000-000000000001',
      emailCiphertext: await cipher.encrypt('wei.song@gmail.com'),
      emailLookup: legacyEmailLookupHmac('wei.song@gmail.com', NEW_PEPPER),
      displayName: '淞淞',
      status: 'active',
    })
    const service = new UserService(repo, cipher, NEW_PEPPER)
    const found = await service.ensureUser('Wei.Song@gmail.com')
    expect(found.id).toBe(legacyRow.id)
    const stored = (await repo.findById(legacyRow.id))!
    expect(lookupEquals(stored.emailLookup, emailLookupHmac('weisong@gmail.com', NEW_PEPPER))).toBe(true)
    // Once migrated, the legacy value no longer resolves and no new row was minted.
    expect(await repo.findByLookup(legacyEmailLookupHmac('wei.song@gmail.com', NEW_PEPPER))).toBeNull()
    expect((await repo.listAll()).length).toBe(1)
  })

  it('when a duplicate already owns the canonical lookup, the legacy row is left untouched and the duplicate wins', async () => {
    const repo = new MemoryUserRepository()
    const legacyRow = await repo.create({
      id: '01900000-0000-7000-8000-000000000002',
      emailCiphertext: await cipher.encrypt('a.b@gmail.com'),
      emailLookup: legacyEmailLookupHmac('a.b@gmail.com', NEW_PEPPER),
      displayName: 'legacy',
      status: 'active',
    })
    const service = new UserService(repo, cipher, NEW_PEPPER)
    const duplicate = await repo.create({
      id: '01900000-0000-7000-8000-000000000003',
      emailCiphertext: await cipher.encrypt('ab@gmail.com'),
      emailLookup: emailLookupHmac('ab@gmail.com', NEW_PEPPER),
      displayName: 'dup',
      status: 'active',
    })
    const found = await service.ensureUser('a.b@gmail.com')
    expect(found.id).toBe(duplicate.id)
    expect(lookupEquals((await repo.findById(legacyRow.id))!.emailLookup, legacyEmailLookupHmac('a.b@gmail.com', NEW_PEPPER))).toBe(true)
    expect((await repo.listAll()).length).toBe(2)
  })

  it('maps alias spellings of one Gmail address to one account', async () => {
    const repo = new MemoryUserRepository()
    const service = new UserService(repo, cipher, NEW_PEPPER)
    const a = await service.ensureUser('Mei.Hua@gmail.com')
    const b = await service.ensureUser('meihua+alt@googlemail.com')
    expect(b.id).toBe(a.id)
    expect(await cipher.decrypt(a.emailCiphertext)).toBe('meihua@gmail.com')
  })
})
