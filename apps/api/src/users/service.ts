import { randomBytes, randomInt } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import type { MeView } from '@teamup/shared'
import {
  emailHint,
  emailLookupHmac,
  legacyEmailLookupHmac,
  lookupEquals,
  normalizeEmail,
} from '../crypto/email.js'
import type { FieldCipher } from '../crypto/envelope.js'
import { UniqueViolationError, type UserRecord, type UserRepository } from './repository.js'

const defaultDisplayName = () => `新夥伴${randomInt(1000, 10000)}`

export interface UserServiceOptions {
  /**
   * The pepper that was in force before the current one. During a
   * rotation, a lookup miss is retried with it and a hit is re-hashed
   * to the current pepper on the spot (lazy migration on login).
   */
  previousPepper?: string
}

export class UserService {
  constructor(
    private readonly repo: UserRepository,
    private readonly cipher: FieldCipher,
    private readonly pepper: string,
    private readonly options: UserServiceOptions = {},
  ) {}

  /**
   * Login == first use: provision the user row on first authenticated
   * request. Identity key is the HMAC of the canonical email.
   *
   * A soft-deleted row is NOT revived: the person asked for deletion, so
   * their old row stays dead (hidden, purged after the grace period) and
   * a brand-new empty account is created for the same address. The old
   * row's lookup is replaced with a random tombstone so the unique index
   * frees the address.
   */
  async ensureUser(email: string): Promise<UserRecord> {
    const lookup = emailLookupHmac(email, this.pepper)
    const existing = (await this.repo.findByLookup(lookup)) ?? (await this.findByLegacyLookup(email, lookup))
    if (existing && existing.status !== 'deleted') return existing
    if (existing) {
      await this.repo.updateEmailLookup(existing.id, randomBytes(lookup.length))
    }

    const record: UserRecord = {
      id: uuidv7(),
      emailCiphertext: await this.cipher.encrypt(normalizeEmail(email)),
      emailLookup: lookup,
      displayName: defaultDisplayName(),
      status: 'active',
    }
    try {
      return await this.repo.create(record)
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        // Lost a provisioning race — the winner's row is ours.
        const raced = await this.repo.findByLookup(lookup)
        if (raced) return raced
      }
      throw err
    }
  }

  /**
   * Lookup values a row for this address may still carry from before a
   * migration: the pre-alias-collapsing form (ADR-028) and, during a
   * pepper rotation, both forms under the previous pepper.
   */
  private legacyLookups(email: string, currentLookup: Buffer): Buffer[] {
    const candidates: Buffer[] = []
    const push = (b: Buffer) => {
      if (!lookupEquals(b, currentLookup) && !candidates.some((c) => lookupEquals(c, b))) {
        candidates.push(b)
      }
    }
    push(legacyEmailLookupHmac(email, this.pepper))
    if (this.options.previousPepper) {
      push(emailLookupHmac(email, this.options.previousPepper))
      push(legacyEmailLookupHmac(email, this.options.previousPepper))
    }
    return candidates
  }

  /** Lazy migration on login: find under a legacy lookup and re-hash to the current one. */
  private async findByLegacyLookup(
    email: string,
    currentLookup: Buffer,
  ): Promise<UserRecord | null> {
    for (const candidate of this.legacyLookups(email, currentLookup)) {
      const old = await this.repo.findByLookup(candidate)
      if (!old) continue
      try {
        await this.repo.updateEmailLookup(old.id, currentLookup)
      } catch (err) {
        // Someone already owns the new value (a second row for the same
        // address, e.g. minted between deploy and re-hash) — leave the
        // old row untouched and let the current-form row win; the
        // rehash script's --absorb-empty-duplicates cleans this up.
        if (err instanceof UniqueViolationError) return this.repo.findByLookup(currentLookup)
        throw err
      }
      return { ...old, emailLookup: currentLookup }
    }
    return null
  }

  async toMeView(record: UserRecord): Promise<MeView> {
    const email = await this.cipher.decrypt(record.emailCiphertext)
    return {
      userId: record.id,
      displayName: record.displayName,
      emailHint: emailHint(email),
      status: record.status,
    }
  }

  async updateDisplayName(id: string, displayName: string): Promise<void> {
    await this.repo.updateDisplayName(id, displayName)
  }
}
