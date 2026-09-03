export type UserStatus = 'active' | 'suspended' | 'deleted'

export interface UserRecord {
  id: string
  emailCiphertext: Buffer
  emailLookup: Buffer
  displayName: string
  status: UserStatus
}

export class UniqueViolationError extends Error {
  constructor(public readonly constraint: string) {
    super(`unique violation: ${constraint}`)
    this.name = 'UniqueViolationError'
  }
}

export interface UserRepository {
  findByLookup(lookup: Buffer): Promise<UserRecord | null>
  findById(id: string): Promise<UserRecord | null>
  /** Throws UniqueViolationError when email_lookup already exists. */
  create(record: UserRecord): Promise<UserRecord>
  updateDisplayName(id: string, displayName: string): Promise<void>
  /** Used by the moderation strike rule (spec §5.5) and account deletion. */
  updateStatus(id: string, status: UserStatus): Promise<void>
  /** Hard-delete users soft-deleted before the cutoff; returns how many. */
  hardDeleteBefore(cutoff: Date): Promise<number>
  /** Admin dashboard: account counts keyed by status. */
  countByStatus(): Promise<Record<UserStatus, number>>
  /**
   * Admin member roster, newest first. Metadata only downstream — the
   * admin API must never expose emailCiphertext/emailLookup.
   */
  listAll(): Promise<(UserRecord & { createdAt: string | null })[]>
}
