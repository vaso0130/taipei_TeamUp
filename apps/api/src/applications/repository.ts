import type { ApplicationDirection, ApplicationStatus, ContentVisibility } from '@teamup/shared'

export interface ApplicationRecord {
  id: string
  teamId: string
  /** Always "the person who would join" — the invitee for invites. */
  applicantId: string
  direction: ApplicationDirection
  messageCiphertext: Buffer | null
  messageVisibility: ContentVisibility
  status: ApplicationStatus
  createdAt: string
}

export class DuplicatePendingError extends Error {
  constructor() {
    super('a pending application already exists for this team and user')
    this.name = 'DuplicatePendingError'
  }
}

export interface ApplicationRepository {
  /** Throws DuplicatePendingError when a pending row exists for (team, user). */
  create(record: ApplicationRecord): Promise<ApplicationRecord>
  getById(id: string): Promise<ApplicationRecord | null>
  listForTeam(teamId: string, status?: ApplicationStatus): Promise<ApplicationRecord[]>
  /** Applications where the user is the (would-be) joiner, within one event. */
  listForUser(eventSlug: string, userId: string): Promise<ApplicationRecord[]>
  updateStatus(id: string, status: ApplicationStatus): Promise<void>
  /** After an accept in an exclusive event: void the user's other pending applications. */
  withdrawPendingForUser(eventSlug: string, userId: string, exceptTeamId: string): Promise<void>
  /**
   * Whether a live application (pending or accepted) connects the two
   * users — one as applicant, the other as the team's owner. Grants
   * messaging permission (spec §2.1 item 7).
   */
  hasActiveRelationship(eventSlug: string, userA: string, userB: string): Promise<boolean>
  updateMessageVisibility(id: string, visibility: ContentVisibility): Promise<void>
  /** Applications whose message still awaits moderation (the review queue). */
  listPendingMessages(): Promise<ApplicationRecord[]>
}
