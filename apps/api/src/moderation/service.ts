import { createHash } from 'node:crypto'
import { uuidv7 } from 'uuidv7'
import type { ContentVisibility } from '@teamup/shared'
import type { ApplicationRepository } from '../applications/repository.js'
import type { FieldCipher } from '../crypto/envelope.js'
import type { MessageRepository, ThreadRepository } from '../messaging/repository.js'
import type { ParticipantRepository } from '../participants/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { UserRepository } from '../users/repository.js'
import { visibilityFor, type ModerationContext, type ModerationVerdict, type Moderator } from './moderator.js'
import type { ModerationRecordRepository } from './records.js'
import { extractSignals } from './signals.js'

/** What a moderation task points at. */
export type ModerationTarget =
  | { type: 'participant_blurb'; eventSlug: string; userId: string }
  | { type: 'team_pitch'; teamId: string }
  | { type: 'application_message'; applicationId: string }
  | { type: 'message'; messageId: string }
  /** User-reported message: re-reviewed by the escalation moderator. */
  | { type: 'reported_message'; messageId: string }
  /** User-reported team: name + pitch re-reviewed by escalation. */
  | { type: 'reported_team_pitch'; teamId: string }
  /** User-reported participant: nickname + blurb + tags re-reviewed. */
  | { type: 'reported_blurb'; eventSlug: string; userId: string }

/** Reported targets take the stronger escalation moderator. */
const isReported = (target: ModerationTarget) => target.type.startsWith('reported_')

export const targetId = (target: ModerationTarget): string => {
  switch (target.type) {
    case 'participant_blurb':
    case 'reported_blurb':
      return `${target.eventSlug}/${target.userId}`
    case 'team_pitch':
    case 'reported_team_pitch':
      return target.teamId
    case 'application_message':
      return target.applicationId
    case 'message':
    case 'reported_message':
      return target.messageId
  }
}

export interface ModerationQueue {
  enqueue(target: ModerationTarget): Promise<void>
}

/**
 * Enqueue without letting a queue outage surface as a user-facing 500:
 * the content was already stored as pending_review (never published), so
 * the only consequence of a failed enqueue is a delayed review — which
 * the cleanup job repairs by re-queueing stale pending content. Returns
 * whether the enqueue succeeded.
 */
export async function safeEnqueue(queue: ModerationQueue, target: ModerationTarget): Promise<boolean> {
  try {
    await queue.enqueue(target)
    return true
  } catch (err) {
    console.error(
      `moderation enqueue failed (${target.type}/${targetId(target)}): ` +
        (err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'),
    )
    return false
  }
}

/**
 * Target types that share one piece of content (the reported variant
 * re-reviews the same text under a different type, and a human decision
 * may be recorded under either). Used wherever "the latest verdict for
 * this content" matters.
 */
export const targetFamily = (target: ModerationTarget): string[] => {
  switch (target.type) {
    case 'message':
    case 'reported_message':
      return ['message', 'reported_message']
    case 'team_pitch':
    case 'reported_team_pitch':
      return ['team_pitch', 'reported_team_pitch']
    case 'participant_blurb':
    case 'reported_blurb':
      return ['participant_blurb', 'reported_blurb']
    case 'application_message':
      return ['application_message']
  }
}

/** Recorded as model_id when no model produced the verdict (fail-closed). */
export const FAIL_CLOSED_MODEL_ID = 'unavailable'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

interface ResolvedContent {
  text: string
  context: ModerationContext
  subjectUserId: string | null
  /** Current stored visibility (what an idempotent no-op returns). */
  visibility: ContentVisibility
  apply(visibility: ContentVisibility): Promise<void>
}

export interface ModerationServiceOptions {
  /** Retries after the first failed attempt (spec §5.4: 2). */
  retries?: number
  backoffMs?: number
  /** Strike rule (spec §5.5): N high verdicts within windowDays → suspended. */
  highStrikeLimit?: number
  highStrikeWindowDays?: number
  modelId?: string
  promptVersion?: string
  /** Recorded on escalation (reported-content) verdicts. */
  escalationModelId?: string
  escalationPromptVersion?: string
  /**
   * Spot-check rule: an auto low verdict below this confidence, or one
   * carrying rule signals, is published anyway but flagged for an
   * after-the-fact admin look.
   */
  spotCheckConfidence?: number
}

/**
 * The moderation worker: resolve target content → moderate → persist a
 * moderation_record (verdict + SHA-256, never the content) → apply the
 * resulting visibility → enforce the suspension strike rule.
 */
export class ModerationService {
  private readonly opts: Required<ModerationServiceOptions>

  constructor(
    private readonly deps: {
      moderator: Moderator
      /**
       * Optional short-timeout moderator for the latency-sensitive
       * synchronous path (messages). Falls back to `moderator`.
       */
      syncModerator?: Moderator
      /**
       * Optional stronger model for user-reported content (async only).
       * Falls back to `moderator`.
       */
      escalationModerator?: Moderator
      /**
       * Optional lenient-timeout moderator for public names (team
       * names, nicknames): short inputs reviewed inline at write time.
       * Falls back to `syncModerator`, then `moderator`.
       */
      nameModerator?: Moderator
      /** Report bookkeeping; absent when the feature is not wired. */
      reports?: import('../reports/repository.js').ReportRepository
      /** Non-message content reports (teams, participants). */
      contentReports?: import('../reports/content-repository.js').ContentReportRepository
      /**
       * Accounts the automatic strike rule must never suspend (admin
       * accounts — a platform must not lock out its last moderator).
       * Their verdicts are still recorded and visible.
       */
      isStrikeExempt?: (userId: string) => Promise<boolean>
      records: ModerationRecordRepository
      users: UserRepository
      participants: ParticipantRepository
      teams: TeamRepository
      applications: ApplicationRepository
      threads: ThreadRepository
      messages: MessageRepository
      cipher: FieldCipher
      audit?: import('../audit/log.js').AuditLogger
    },
    options: ModerationServiceOptions = {},
  ) {
    this.opts = {
      retries: options.retries ?? 2,
      backoffMs: options.backoffMs ?? 500,
      highStrikeLimit: options.highStrikeLimit ?? 3,
      highStrikeWindowDays: options.highStrikeWindowDays ?? 7,
      modelId: options.modelId ?? 'mock',
      promptVersion: options.promptVersion ?? 'v1',
      escalationModelId: options.escalationModelId ?? options.modelId ?? 'mock',
      escalationPromptVersion: options.escalationPromptVersion ?? options.promptVersion ?? 'v1',
      spotCheckConfidence: options.spotCheckConfidence ?? 0.8,
    }
  }

  /**
   * Synchronous path (messages, spec §5.2): one attempt, throws on any
   * failure so the caller can fall back to the async queue.
   */
  async processSync(target: ModerationTarget): Promise<ContentVisibility> {
    const resolved = await this.resolve(target)
    if (!resolved) return 'pending_review'
    const moderator = this.deps.syncModerator ?? this.deps.moderator
    const verdict = await moderator.review(resolved.text, resolved.context)
    return this.applyVerdict(target, resolved, verdict, 'auto')
  }

  /**
   * Async worker path: retry with backoff; if the model stays
   * unavailable, fail closed to medium risk (content stays hidden and
   * lands in the human review queue) — never publish on failure.
   */
  async processAsync(target: ModerationTarget): Promise<ContentVisibility> {
    const resolved = await this.resolve(target)
    if (!resolved) return 'pending_review'

    // Idempotency (Cloud Tasks is at-least-once): a redelivered task must
    // neither undo a human decision nor stack a second identical verdict
    // (which would double-count strikes).
    const latest = await this.deps.records.latestFor(targetFamily(target), targetId(target))
    if (latest) {
      if (latest.decidedBy.startsWith('human:')) return resolved.visibility
      const sameContent =
        latest.targetType === target.type &&
        latest.contentSha256 === sha256(resolved.text) &&
        latest.modelId !== FAIL_CLOSED_MODEL_ID
      if (sameContent) return resolved.visibility
    }

    // Reported content gets the stronger escalation model when wired.
    const moderator = isReported(target)
      ? (this.deps.escalationModerator ?? this.deps.moderator)
      : this.deps.moderator

    let verdict: ModerationVerdict | null = null
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        verdict = await moderator.review(resolved.text, resolved.context)
        break
      } catch {
        if (attempt < this.opts.retries) {
          await sleep(this.opts.backoffMs * 2 ** attempt)
        }
      }
    }
    if (!verdict) {
      // Loud by design: a silent fail-closed pipeline looks like "the
      // moderator never ran" while content piles up in review.
      console.error(
        `moderation unavailable after ${this.opts.retries + 1} attempts, ` +
          `failing closed to pending review (${target.type}/${targetId(target)})`,
      )
    }
    if (verdict) return this.applyVerdict(target, resolved, verdict, 'auto')
    return this.applyVerdict(
      target,
      resolved,
      { riskLevel: 'medium', categories: ['none'], rationale: '審核服務暫時無法使用' },
      'auto',
      FAIL_CLOSED_MODEL_ID,
    )
  }

  /**
   * Inline screening for public names (team names, nicknames): unlike
   * body content, a name has no useful "hidden pending review" state —
   * so the write itself is accepted or refused on the spot. Fail-closed:
   * a moderator failure refuses the write ('unavailable') rather than
   * publishing an unscreened name. The verdict is recorded (metadata
   * only), so repeat offenders show up in the admin roster counters and
   * high name verdicts count toward the strike window like any other
   * high — repeatedly attempting scam names is itself a signal. The
   * refusal path here doesn't run the suspension check; the next high
   * on published content will.
   */
  async screenName(
    text: string,
    targetType: 'team_name' | 'display_name',
    targetId: string,
    subjectUserId: string,
  ): Promise<'ok' | 'rejected' | 'unavailable'> {
    const moderator =
      this.deps.nameModerator ?? this.deps.syncModerator ?? this.deps.moderator
    let verdict: ModerationVerdict
    try {
      verdict = await moderator.review(text, { contentType: 'name' })
    } catch {
      return 'unavailable'
    }
    await this.deps.records.create({
      id: uuidv7(),
      targetType,
      targetId,
      contentSha256: sha256(text),
      riskLevel: verdict.riskLevel,
      categories: verdict.categories,
      rationale: verdict.rationale ?? '',
      modelId: this.opts.modelId,
      promptVersion: this.opts.promptVersion,
      decidedBy: 'auto',
      subjectUserId,
      flagged: false,
      createdAt: new Date().toISOString(),
    })
    return verdict.riskLevel === 'low' ? 'ok' : 'rejected'
  }

  /** Human review decision from the admin backend. */
  async decide(
    target: ModerationTarget,
    action: 'approve' | 'block',
    adminUserId: string,
  ): Promise<void> {
    const resolved = await this.resolve(target)
    if (!resolved) return
    const verdict: ModerationVerdict = {
      riskLevel: action === 'approve' ? 'low' : 'high',
      categories: ['none'],
      rationale: '人工審核',
    }
    await this.applyVerdict(target, resolved, verdict, `human:${adminUserId}`)
    await this.deps.audit?.log('moderation_decide', {
      actorUserId: adminUserId,
      targetType: target.type,
      targetId: targetId(target),
      detail: action,
    })
  }

  private async applyVerdict(
    target: ModerationTarget,
    resolved: ResolvedContent,
    verdict: ModerationVerdict,
    decidedBy: string,
    modelIdOverride?: string,
  ): Promise<ContentVisibility> {
    const escalated = isReported(target) && decidedBy === 'auto'
    // Spot-check rule: published, but a human should glance at it later.
    const flagged =
      decidedBy === 'auto' &&
      verdict.riskLevel === 'low' &&
      (extractSignals(resolved.text).length > 0 ||
        (verdict.confidence ?? 1) < this.opts.spotCheckConfidence)
    await this.deps.records.create({
      id: uuidv7(),
      targetType: target.type,
      targetId: targetId(target),
      contentSha256: sha256(resolved.text),
      riskLevel: verdict.riskLevel,
      categories: verdict.categories,
      rationale: verdict.rationale ?? '',
      modelId:
        modelIdOverride ??
        (decidedBy === 'auto'
          ? escalated
            ? this.opts.escalationModelId
            : this.opts.modelId
          : 'human'),
      promptVersion: escalated ? this.opts.escalationPromptVersion : this.opts.promptVersion,
      decidedBy,
      subjectUserId: resolved.subjectUserId,
      flagged,
      createdAt: new Date().toISOString(),
    })

    const visibility = visibilityFor(verdict)
    await resolved.apply(visibility)

    // A verdict on a (reported) message settles its open reports.
    if (target.type === 'reported_message' || target.type === 'message') {
      await this.deps.reports?.resolveForMessage(target.messageId)
    }
    // Likewise for content reports: any verdict on the team or the
    // participant profile (reported or via the normal pipeline/human
    // decide) settles the open reports against it.
    if (target.type === 'reported_team_pitch' || target.type === 'team_pitch') {
      await this.deps.contentReports?.resolveForTarget('team', target.teamId)
    }
    if (target.type === 'reported_blurb' || target.type === 'participant_blurb') {
      await this.deps.contentReports?.resolveForTarget(
        'participant',
        `${target.eventSlug}/${target.userId}`,
      )
    }

    // Strike rule (spec §5.5): repeated high-risk content suspends the account.
    if (verdict.riskLevel === 'high' && resolved.subjectUserId) {
      const since = new Date(Date.now() - this.opts.highStrikeWindowDays * 24 * 60 * 60 * 1000)
      const strikes = await this.deps.records.countHighSince(resolved.subjectUserId, since)
      if (strikes >= this.opts.highStrikeLimit) {
        if (await this.deps.isStrikeExempt?.(resolved.subjectUserId)) {
          // Loud, not silent: an exempt (admin) account hitting the
          // strike limit deserves eyes on the logs.
          console.warn(
            `strike limit reached by exempt account ${resolved.subjectUserId} — not suspending`,
          )
        } else {
          await this.deps.users.updateStatus(resolved.subjectUserId, 'suspended')
        }
      }
    }
    return visibility
  }

  /**
   * Manual admin suspension — the counterpart of the automatic strike
   * rule, for cases a human catches first. Refuses strike-exempt
   * (admin) accounts so the platform can't lock out its moderators;
   * the action is audit-logged like every other admin power.
   */
  async suspend(
    userId: string,
    adminUserId: string,
  ): Promise<'suspended' | 'not_active' | 'exempt'> {
    const user = await this.deps.users.findById(userId)
    if (!user || user.status !== 'active') return 'not_active'
    if (await this.deps.isStrikeExempt?.(userId)) return 'exempt'
    await this.deps.users.updateStatus(userId, 'suspended')
    await this.deps.audit?.log('admin_suspend', {
      actorUserId: adminUserId,
      targetType: 'user',
      targetId: userId,
    })
    return 'suspended'
  }

  /**
   * Admin reactivation: lift a suspension and reset the strike counter
   * for the current window (otherwise the very next high verdict would
   * re-suspend immediately). The action itself is audit-logged; the
   * user's non-high verdict history stays intact.
   */
  async reactivate(userId: string, adminUserId: string): Promise<boolean> {
    const user = await this.deps.users.findById(userId)
    if (!user || user.status !== 'suspended') return false
    await this.deps.users.updateStatus(userId, 'active')
    const since = new Date(Date.now() - this.opts.highStrikeWindowDays * 24 * 60 * 60 * 1000)
    const cleared = await this.deps.records.deleteHighSince(userId, since)
    await this.deps.audit?.log('admin_reactivate', {
      actorUserId: adminUserId,
      targetType: 'user',
      targetId: userId,
      detail: `cleared_strikes=${cleared}`,
    })
    return true
  }

  /** Enum reasons only — never any reporter identity (spec §5.6). */
  private async contentReportReasons(
    targetType: 'team' | 'participant',
    id: string,
  ): Promise<{ reportReasons?: string[] }> {
    const reasons = [
      ...new Set(
        ((await this.deps.contentReports?.listByTarget(targetType, id)) ?? []).map(
          (r) => r.reason,
        ),
      ),
    ]
    return reasons.length > 0 ? { reportReasons: reasons } : {}
  }

  private async resolve(target: ModerationTarget): Promise<ResolvedContent | null> {
    switch (target.type) {
      case 'participant_blurb': {
        const record = await this.deps.participants.get(target.eventSlug, target.userId)
        if (!record || (record.blurb === '' && record.customTags.length === 0)) return null
        // Blurb and free-form tags are one review unit (one visibility).
        const text = [
          record.blurb,
          record.customTags.length > 0 ? `自訂標籤：${record.customTags.join('、')}` : '',
        ]
          .filter((s) => s !== '')
          .join('\n')
        return {
          text,
          context: { contentType: 'bio', relationship: 'strangers' },
          subjectUserId: record.userId,
          visibility: record.blurbVisibility,
          apply: (v) =>
            this.deps.participants.updateBlurbVisibility(target.eventSlug, target.userId, v),
        }
      }
      case 'team_pitch': {
        const team = await this.deps.teams.getById(target.teamId)
        if (!team || team.pitch === '') return null
        return {
          text: team.pitch,
          context: { contentType: 'pitch', relationship: 'strangers' },
          subjectUserId: team.ownerUserId,
          visibility: team.pitchVisibility,
          apply: (v) => this.deps.teams.update(team.id, { pitchVisibility: v }),
        }
      }
      case 'reported_team_pitch': {
        // Review unit = the team's whole public face (name + pitch);
        // the name may be the scam even when the pitch is clean.
        const team = await this.deps.teams.getById(target.teamId)
        if (!team) return null
        const reportReasons = await this.contentReportReasons('team', target.teamId)
        return {
          text: [`名稱：${team.name}`, team.pitch].filter((s) => s !== '').join('\n'),
          context: { contentType: 'pitch', relationship: 'strangers', ...reportReasons },
          subjectUserId: team.ownerUserId,
          visibility: team.pitchVisibility,
          apply: (v) => this.deps.teams.update(team.id, { pitchVisibility: v }),
        }
      }
      case 'reported_blurb': {
        const record = await this.deps.participants.get(target.eventSlug, target.userId)
        if (!record) return null
        const user = await this.deps.users.findById(target.userId)
        const reportReasons = await this.contentReportReasons(
          'participant',
          `${target.eventSlug}/${target.userId}`,
        )
        return {
          text: [
            `暱稱：${user?.displayName ?? ''}`,
            record.blurb,
            record.customTags.length > 0 ? `自訂標籤：${record.customTags.join('、')}` : '',
          ]
            .filter((s) => s !== '')
            .join('\n'),
          context: { contentType: 'bio', relationship: 'strangers', ...reportReasons },
          subjectUserId: record.userId,
          visibility: record.blurbVisibility,
          apply: (v) =>
            this.deps.participants.updateBlurbVisibility(target.eventSlug, target.userId, v),
        }
      }
      case 'application_message': {
        const application = await this.deps.applications.getById(target.applicationId)
        if (!application?.messageCiphertext) return null
        const team = await this.deps.teams.getById(application.teamId)
        const senderId =
          application.direction === 'apply'
            ? application.applicantId
            : (team?.ownerUserId ?? null)
        return {
          text: await this.deps.cipher.decrypt(application.messageCiphertext),
          context: { contentType: 'application_message', relationship: 'applicant_owner' },
          subjectUserId: senderId,
          visibility: application.messageVisibility,
          apply: async (v) => {
            await this.deps.applications.updateMessageVisibility(application.id, v)
            // Spec §5.5: a high-risk note voids the request itself — it
            // can no longer be accepted, and the pending-only messaging
            // relationship ends with it. A later human approve reopens
            // it (best effort: a fresh pending row may exist by then).
            if (v === 'blocked') {
              await this.deps.applications.updateStatus(application.id, 'blocked')
            } else if (v === 'published') {
              await this.deps.applications
                .updateStatus(application.id, 'pending', 'blocked')
                .catch(() => false)
            }
          },
        }
      }
      case 'message':
      case 'reported_message': {
        const message = await this.deps.messages.getById(target.messageId)
        if (!message) return null
        const thread = await this.deps.threads.getById(message.threadId)
        let relationship: ModerationContext['relationship'] = 'strangers'
        if (thread) {
          const [teamsA, teamsB] = await Promise.all([
            this.deps.teams.activeTeamIdsOf(thread.eventSlug, thread.userAId),
            this.deps.teams.activeTeamIdsOf(thread.eventSlug, thread.userBId),
          ])
          const setB = new Set(teamsB)
          relationship = teamsA.some((id) => setB.has(id)) ? 'teammates' : 'applicant_owner'
        }
        // The reviewer sees which enum reasons reporters chose — never
        // any reporter identity (spec §5.6 data minimization).
        const reportReasons =
          target.type === 'reported_message'
            ? [
                ...new Set(
                  (await this.deps.reports?.listByMessage(target.messageId))?.map(
                    (r) => r.reason,
                  ) ?? [],
                ),
              ]
            : []
        return {
          text: await this.deps.cipher.decrypt(message.bodyCiphertext),
          context: {
            contentType: 'message',
            relationship,
            ...(reportReasons.length > 0 ? { reportReasons } : {}),
          },
          subjectUserId: message.senderId,
          visibility: message.visibility,
          apply: (v) => this.deps.messages.updateVisibility(message.id, v),
        }
      }
    }
  }
}

/** Dev/test queue: runs the worker in-process, awaited. */
export class InProcessModerationQueue implements ModerationQueue {
  constructor(private readonly service: () => ModerationService) {}

  async enqueue(target: ModerationTarget): Promise<void> {
    await this.service().processAsync(target)
  }
}

const sleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
