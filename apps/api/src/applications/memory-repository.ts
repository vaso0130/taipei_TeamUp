import type { ApplicationStatus } from '@teamup/shared'
import type { TeamRepository } from '../teams/repository.js'
import {
  DuplicatePendingError,
  type ApplicationRecord,
  type ApplicationRepository,
} from './repository.js'

/** In-memory implementation for unit tests. */
export class MemoryApplicationRepository implements ApplicationRepository {
  private readonly records = new Map<string, ApplicationRecord>()

  constructor(private readonly teams: TeamRepository) {}

  create(record: ApplicationRecord): Promise<ApplicationRecord> {
    for (const existing of this.records.values()) {
      if (
        existing.teamId === record.teamId &&
        existing.applicantId === record.applicantId &&
        existing.status === 'pending'
      ) {
        return Promise.reject(new DuplicatePendingError())
      }
    }
    this.records.set(record.id, { ...record })
    return Promise.resolve({ ...record })
  }

  getById(id: string): Promise<ApplicationRecord | null> {
    const record = this.records.get(id)
    return Promise.resolve(record ? { ...record } : null)
  }

  listForTeam(teamId: string, status?: ApplicationStatus): Promise<ApplicationRecord[]> {
    const result = [...this.records.values()]
      .filter((r) => r.teamId === teamId && (!status || r.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ ...r }))
    return Promise.resolve(result)
  }

  async listForUser(eventSlug: string, userId: string): Promise<ApplicationRecord[]> {
    const result: ApplicationRecord[] = []
    for (const record of this.records.values()) {
      if (record.applicantId !== userId) continue
      const team = await this.teams.getById(record.teamId)
      if (team?.eventSlug === eventSlug) result.push({ ...record })
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async hasActiveRelationship(eventSlug: string, userA: string, userB: string): Promise<boolean> {
    for (const record of this.records.values()) {
      if (record.status !== 'pending') continue
      const team = await this.teams.getById(record.teamId)
      if (team?.eventSlug !== eventSlug) continue
      const pair =
        (record.applicantId === userA && team.ownerUserId === userB) ||
        (record.applicantId === userB && team.ownerUserId === userA)
      if (pair) return true
    }
    return false
  }

  updateStatus(
    id: string,
    status: ApplicationStatus,
    from: ApplicationStatus = 'pending',
  ): Promise<boolean> {
    const record = this.records.get(id)
    if (!record || record.status !== from) return Promise.resolve(false)
    record.status = status
    return Promise.resolve(true)
  }

  updateMessageVisibility(id: string, visibility: ApplicationRecord['messageVisibility']) {
    const record = this.records.get(id)
    if (record) record.messageVisibility = visibility
    return Promise.resolve()
  }

  listPendingMessages(): Promise<ApplicationRecord[]> {
    const result = [...this.records.values()]
      .filter((r) => r.messageCiphertext !== null && r.messageVisibility === 'pending_review')
      .map((r) => ({ ...r }))
    return Promise.resolve(result)
  }

  async withdrawPendingForUser(
    eventSlug: string,
    userId: string,
    exceptTeamId: string,
  ): Promise<void> {
    for (const record of this.records.values()) {
      if (record.applicantId !== userId || record.status !== 'pending') continue
      if (record.teamId === exceptTeamId) continue
      const team = await this.teams.getById(record.teamId)
      if (team?.eventSlug === eventSlug) record.status = 'withdrawn'
    }
  }
}
