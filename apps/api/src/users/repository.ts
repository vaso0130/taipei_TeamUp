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

export interface HardDeleteResult {
  /** Rows removed. */
  deleted: number
  /** Rows past the cutoff that could not be removed (e.g. a dangling FK). */
  failed: number
}

export interface UserRepository {
  findByLookup(lookup: Buffer): Promise<UserRecord | null>
  findById(id: string): Promise<UserRecord | null>
  /** Throws UniqueViolationError when email_lookup already exists. */
  create(record: UserRecord): Promise<UserRecord>
  updateDisplayName(id: string, displayName: string): Promise<void>
  /** Used by the moderation strike rule (spec §5.5) and account deletion. */
  updateStatus(id: string, status: UserStatus): Promise<void>
  /**
   * Replace the login lookup value (pepper rotation, canonicalization
   * re-hash, tombstoning a soft-deleted row). Throws UniqueViolationError
   * when another row already owns the new value.
   */
  updateEmailLookup(id: string, lookup: Buffer): Promise<void>
  /**
   * Hard-delete users soft-deleted before the cutoff, one row at a time
   * so a single failure (FK still pointing at the row) never blocks the
   * others.
   */
  hardDeleteBefore(cutoff: Date): Promise<HardDeleteResult>
  /** Admin dashboard: account counts keyed by status. */
  countByStatus(): Promise<Record<UserStatus, number>>
  /**
   * Admin member roster, newest first. Metadata only downstream — the
   * admin API must never expose emailCiphertext/emailLookup.
   */
  listAll(): Promise<(UserRecord & { createdAt: string | null })[]>
}
