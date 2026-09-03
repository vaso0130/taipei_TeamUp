import { UniqueViolationError, type UserRecord, type UserRepository } from './repository.js'

/** In-memory implementation for unit tests. */
export class MemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, UserRecord>()
  private readonly deletedAt = new Map<string, string>()
  private readonly createdAt = new Map<string, string>()

  findByLookup(lookup: Buffer): Promise<UserRecord | null> {
    for (const record of this.byId.values()) {
      if (record.emailLookup.equals(lookup)) return Promise.resolve({ ...record })
    }
    return Promise.resolve(null)
  }

  findById(id: string): Promise<UserRecord | null> {
    const record = this.byId.get(id)
    return Promise.resolve(record ? { ...record } : null)
  }

  async create(record: UserRecord): Promise<UserRecord> {
    if (await this.findByLookup(record.emailLookup)) {
      throw new UniqueViolationError('users_email_lookup_idx')
    }
    this.byId.set(record.id, { ...record })
    this.createdAt.set(record.id, new Date().toISOString())
    return { ...record }
  }

  listAll(): Promise<(UserRecord & { createdAt: string | null })[]> {
    return Promise.resolve(
      [...this.byId.values()]
        .map((r) => ({ ...r, createdAt: this.createdAt.get(r.id) ?? null }))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    )
  }

  updateDisplayName(id: string, displayName: string): Promise<void> {
    const record = this.byId.get(id)
    if (record) record.displayName = displayName
    return Promise.resolve()
  }

  updateStatus(id: string, status: UserRecord['status']): Promise<void> {
    const record = this.byId.get(id)
    if (record) record.status = status
    if (status === 'deleted') this.deletedAt.set(id, new Date().toISOString())
    return Promise.resolve()
  }

  countByStatus(): Promise<Record<UserRecord['status'], number>> {
    const counts = { active: 0, suspended: 0, deleted: 0 }
    for (const record of this.byId.values()) counts[record.status]++
    return Promise.resolve(counts)
  }

  hardDeleteBefore(cutoff: Date): Promise<number> {
    let count = 0
    for (const [id, at] of this.deletedAt) {
      if (new Date(at) <= cutoff && this.byId.get(id)?.status === 'deleted') {
        this.byId.delete(id)
        this.deletedAt.delete(id)
        count++
      }
    }
    return Promise.resolve(count)
  }
}
