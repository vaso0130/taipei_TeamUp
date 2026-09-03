import { randomInt } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import type { MeView } from '@teamup/shared'
import { emailHint, emailLookupHmac, normalizeEmail } from '../crypto/email.js'
import type { FieldCipher } from '../crypto/envelope.js'
import { UniqueViolationError, type UserRecord, type UserRepository } from './repository.js'

const defaultDisplayName = () => `新夥伴${randomInt(1000, 10000)}`

export class UserService {
  constructor(
    private readonly repo: UserRepository,
    private readonly cipher: FieldCipher,
    private readonly pepper: string,
  ) {}

  /**
   * Login == first use: provision the user row on first authenticated
   * request. Identity key is the HMAC of the verified email.
   */
  async ensureUser(email: string): Promise<UserRecord> {
    const lookup = emailLookupHmac(email, this.pepper)
    const existing = await this.repo.findByLookup(lookup)
    if (existing) return existing

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
