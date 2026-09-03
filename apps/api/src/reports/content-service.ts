import { uuidv7 } from 'uuidv7'
import type { ReportReason } from '@teamup/shared'
import type { AuditLogger } from '../audit/log.js'
import type { ModerationQueue } from '../moderation/service.js'
import type { ParticipantRepository } from '../participants/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { ContentReportRepository } from './content-repository.js'

export type ContentReportErrorCode =
  | 'team_not_found'
  | 'participant_not_found'
  | 'cannot_report_own'
  | 'already_reported'

export class ContentReportError extends Error {
  constructor(public readonly code: ContentReportErrorCode) {
    super(code)
    this.name = 'ContentReportError'
  }
}

/**
 * User reports against public content that is not a message: a team
 * (name + pitch) or a participant profile (nickname + blurb + tags).
 * Same shape as message reports (spec §5.6): hide immediately, queue
 * an escalation re-review, audit the enum reason only.
 */
export class ContentReportService {
  constructor(
    private readonly deps: {
      teams: TeamRepository
      participants: ParticipantRepository
      contentReports: ContentReportRepository
      moderationQueue: ModerationQueue
      audit?: AuditLogger
    },
  ) {}

  async reportTeam(teamId: string, reporterId: string, reason: ReportReason): Promise<void> {
    const team = await this.deps.teams.getById(teamId)
    if (!team) throw new ContentReportError('team_not_found')
    if (team.ownerUserId === reporterId) throw new ContentReportError('cannot_report_own')

    await this.createReport('team', teamId, reporterId, reason)
    if (team.pitchVisibility === 'published' && team.pitch !== '') {
      await this.deps.teams.update(teamId, { pitchVisibility: 'pending_review' })
    }
    await this.deps.moderationQueue.enqueue({ type: 'reported_team_pitch', teamId })
    await this.deps.audit?.log('content_report', {
      actorUserId: reporterId,
      targetType: 'team',
      targetId: teamId,
      detail: reason,
    })
  }

  async reportParticipant(
    eventSlug: string,
    userId: string,
    reporterId: string,
    reason: ReportReason,
  ): Promise<void> {
    const participation = await this.deps.participants.get(eventSlug, userId)
    if (!participation) throw new ContentReportError('participant_not_found')
    if (userId === reporterId) throw new ContentReportError('cannot_report_own')

    const targetId = `${eventSlug}/${userId}`
    await this.createReport('participant', targetId, reporterId, reason)
    if (participation.blurbVisibility === 'published') {
      await this.deps.participants.updateBlurbVisibility(eventSlug, userId, 'pending_review')
    }
    await this.deps.moderationQueue.enqueue({ type: 'reported_blurb', eventSlug, userId })
    await this.deps.audit?.log('content_report', {
      actorUserId: reporterId,
      targetType: 'participant',
      targetId,
      detail: reason,
    })
  }

  private async createReport(
    targetType: 'team' | 'participant',
    targetId: string,
    reporterId: string,
    reason: ReportReason,
  ): Promise<void> {
    const created = await this.deps.contentReports.create({
      id: uuidv7(),
      targetType,
      targetId,
      reporterUserId: reporterId,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    })
    if (!created) throw new ContentReportError('already_reported')
  }
}
