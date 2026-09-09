import type {
  AdminTeamItem,
  AdminThreadDetail,
  AdminUserItem,
  PendingModerationItem,
  RiskMessageItem,
  UserModerationHistory,
} from '@teamup/shared'
import { targetId, type ModerationTarget } from '../moderation/service.js'
import type { ApplicationRepository } from '../applications/repository.js'
import type { AuditLogger } from '../audit/log.js'
import type { FieldCipher } from '../crypto/envelope.js'
import type { MessageRepository, ThreadRepository } from '../messaging/repository.js'
import type { ModerationRecord, ModerationRecordRepository } from '../moderation/records.js'
import type { ParticipantRepository } from '../participants/repository.js'
import type { ReportRepository } from '../reports/repository.js'
import type { TeamRepository } from '../teams/repository.js'
import type { UserRepository } from '../users/repository.js'

export type AdminErrorCode = 'forbidden' | 'thread_not_found'

export class AdminError extends Error {
  constructor(public readonly code: AdminErrorCode) {
    super(code)
    this.name = 'AdminError'
  }
}

/**
 * Human review backend (spec §5.7). Admin access is enforced at the
 * route layer (ADMIN_EMAILS allowlist); this service aggregates the
 * pending queue across all moderated content types and decrypts
 * encrypted bodies for the reviewing admin. Every decrypting read is
 * audit-logged FIRST and fails closed: no trail, no content (L-5).
 */
export class AdminService {
  constructor(
    private readonly deps: {
      participants: ParticipantRepository
      teams: TeamRepository
      applications: ApplicationRepository
      messages: MessageRepository
      users: UserRepository
      cipher: FieldCipher
      audit: AuditLogger
      threads?: ThreadRepository
      records?: ModerationRecordRepository
      reports?: ReportRepository
    },
  ) {}

  /** Latest auto verdict for a queue item, so the reviewer isn't blind. */
  private async verdictFor(
    target: ModerationTarget,
  ): Promise<PendingModerationItem['verdict']> {
    if (!this.deps.records) return null
    // Reported variants share the base target's id; the latest verdict
    // may live under either type.
    const types =
      target.type === 'message' || target.type === 'reported_message'
        ? ['message', 'reported_message']
        : target.type === 'team_pitch' || target.type === 'reported_team_pitch'
          ? ['team_pitch', 'reported_team_pitch']
          : target.type === 'participant_blurb' || target.type === 'reported_blurb'
            ? ['participant_blurb', 'reported_blurb']
            : [target.type]
    const id =
      target.type === 'participant_blurb' || target.type === 'reported_blurb'
        ? `${target.eventSlug}/${target.userId}`
        : target.type === 'team_pitch' || target.type === 'reported_team_pitch'
          ? target.teamId
          : target.type === 'application_message'
            ? target.applicationId
            : target.messageId
    const record = await this.deps.records.latestFor(types, id)
    if (!record) return null
    return {
      riskLevel: record.riskLevel,
      categories: [...record.categories],
      rationale: record.rationale,
      decidedAt: record.createdAt,
    }
  }

  async listPending(adminUserId: string): Promise<PendingModerationItem[]> {
    const nameOf = async (userId: string | null) =>
      userId ? ((await this.deps.users.findById(userId))?.displayName ?? '（未知）') : '（未知）'

    // Gather first, decrypt last: the audit trail (one entry per item
    // the admin is about to read) is written before any content leaves
    // storage, and a failed trail write aborts the whole read.
    const pending: { item: Omit<PendingModerationItem, 'content'>; content: () => Promise<string> }[] = []

    for (const p of await this.deps.participants.listPendingBlurbs()) {
      const target = {
        type: 'participant_blurb',
        eventSlug: p.eventSlug,
        userId: p.userId,
      } as const
      const content = [
        p.blurb,
        p.customTags.length > 0 ? `自訂標籤：${p.customTags.join('、')}` : '',
      ]
        .filter((s) => s !== '')
        .join('\n')
      pending.push({
        item: {
          target,
          authorDisplayName: await nameOf(p.userId),
          visibility: p.blurbVisibility,
          verdict: await this.verdictFor(target),
          threadId: null,
        },
        content: () => Promise.resolve(content),
      })
    }
    for (const t of await this.deps.teams.listPendingPitches()) {
      const target = { type: 'team_pitch', teamId: t.id } as const
      pending.push({
        item: {
          target,
          authorDisplayName: await nameOf(t.ownerUserId),
          visibility: t.pitchVisibility,
          verdict: await this.verdictFor(target),
          threadId: null,
        },
        content: () => Promise.resolve(t.pitch),
      })
    }
    for (const a of await this.deps.applications.listPendingMessages()) {
      const ciphertext = a.messageCiphertext
      if (!ciphertext) continue
      const team = await this.deps.teams.getById(a.teamId)
      const senderId = a.direction === 'apply' ? a.applicantId : (team?.ownerUserId ?? null)
      const target = { type: 'application_message', applicationId: a.id } as const
      pending.push({
        item: {
          target,
          authorDisplayName: await nameOf(senderId),
          visibility: a.messageVisibility,
          verdict: await this.verdictFor(target),
          threadId: null,
        },
        content: () => this.deps.cipher.decrypt(ciphertext),
      })
    }
    for (const m of await this.deps.messages.listPending()) {
      const target = { type: 'message', messageId: m.id } as const
      pending.push({
        item: {
          target,
          authorDisplayName: await nameOf(m.senderId),
          visibility: m.visibility,
          verdict: await this.verdictFor(target),
          threadId: m.threadId,
        },
        content: () => this.deps.cipher.decrypt(m.bodyCiphertext),
      })
    }

    await this.deps.audit.logOrThrow('admin_review_read', {
      actorUserId: adminUserId,
      targetType: 'moderation_queue',
      detail: `items=${pending.length}`,
    })
    for (const { item } of pending) {
      await this.deps.audit.logOrThrow('admin_review_read', {
        actorUserId: adminUserId,
        targetType: item.target.type,
        targetId: targetId(item.target),
      })
    }

    const items: PendingModerationItem[] = []
    for (const { item, content } of pending) {
      items.push({ ...item, content: await content() })
    }
    return items
  }

  /**
   * Risk overview: every message whose latest verdict is high/medium,
   * was reported, or was published-but-flagged for spot-checking.
   * Metadata only — content decrypts in the thread view, where each
   * read is audited. Full mailbox browsing is deliberately not offered
   * (data minimization: only risk-relevant conversations are visible).
   */
  async listRiskMessages(): Promise<RiskMessageItem[]> {
    if (!this.deps.records) return []
    const nameOf = async (userId: string | null) =>
      userId ? ((await this.deps.users.findById(userId))?.displayName ?? '（未知）') : '（未知）'

    const reportsByMessage = new Map<string, { count: number; reasons: Set<string> }>()
    for (const r of (await this.deps.reports?.listAll()) ?? []) {
      const entry = reportsByMessage.get(r.messageId) ?? { count: 0, reasons: new Set() }
      entry.count += 1
      entry.reasons.add(r.reason)
      reportsByMessage.set(r.messageId, entry)
    }

    const items: RiskMessageItem[] = []
    for (const record of await this.deps.records.listLatestMessageRecords()) {
      const reported = reportsByMessage.get(record.targetId)
      if (record.riskLevel === 'low' && !record.flagged && !reported) continue
      const message = await this.deps.messages.getById(record.targetId)
      if (!message) continue
      items.push({
        messageId: message.id,
        threadId: message.threadId,
        senderId: message.senderId,
        senderDisplayName: await nameOf(message.senderId),
        visibility: message.visibility,
        riskLevel: record.riskLevel,
        categories: [...record.categories],
        rationale: record.rationale,
        decidedBy: record.decidedBy,
        modelId: record.modelId,
        flagged: record.flagged,
        reportCount: reported?.count ?? 0,
        reportReasons: [...(reported?.reasons ?? [])],
        messageCreatedAt: message.createdAt,
        decidedAt: record.createdAt,
      })
    }
    items.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
    return items.slice(0, 200)
  }

  /**
   * Full decrypted conversation for review — every read is audited
   * (fail-closed) and only risk-relevant threads open at all (ADR-019:
   * ordinary conversations are never browsed). A thread qualifies when
   * at least one message's latest verdict is high/medium, is flagged for
   * spot-check, or has been reported; otherwise → forbidden.
   */
  async getThreadForReview(threadId: string, adminUserId: string): Promise<AdminThreadDetail> {
    const thread = await this.deps.threads?.getById(threadId)
    if (!thread) throw new AdminError('thread_not_found')

    const latestByMessage = new Map<string, ModerationRecord>()
    for (const r of (await this.deps.records?.listLatestMessageRecords()) ?? []) {
      latestByMessage.set(r.targetId, r)
    }
    const reportCount = new Map<string, number>()
    for (const r of (await this.deps.reports?.listAll()) ?? []) {
      reportCount.set(r.messageId, (reportCount.get(r.messageId) ?? 0) + 1)
    }

    const records = await this.deps.messages.listForThread(threadId)
    const riskRelevant = records.some((m) => {
      const record = latestByMessage.get(m.id)
      return (
        (record !== undefined && (record.riskLevel !== 'low' || record.flagged)) ||
        (reportCount.get(m.id) ?? 0) > 0
      )
    })
    if (!riskRelevant) throw new AdminError('forbidden')

    await this.deps.audit.logOrThrow('admin_review_read', {
      actorUserId: adminUserId,
      targetType: 'thread',
      targetId: threadId,
    })

    const participants = await Promise.all(
      [thread.userAId, thread.userBId].map(async (userId) => {
        const user = await this.deps.users.findById(userId)
        return {
          userId,
          displayName: user?.displayName ?? '（帳號已刪除）',
          status: user?.status ?? 'deleted',
        }
      }),
    )
    const nameByUser = new Map(participants.map((p) => [p.userId, p.displayName]))

    const messages = await Promise.all(
      records.map(async (m) => {
        const record = latestByMessage.get(m.id)
        return {
          id: m.id,
          senderId: m.senderId,
          senderDisplayName: nameByUser.get(m.senderId) ?? '（未知）',
          body: await this.deps.cipher.decrypt(m.bodyCiphertext),
          visibility: m.visibility,
          createdAt: m.createdAt,
          riskLevel: record?.riskLevel ?? null,
          flagged: record?.flagged ?? false,
          reportCount: reportCount.get(m.id) ?? 0,
        }
      }),
    )
    return { id: thread.id, eventSlug: thread.eventSlug, participants, messages }
  }

  /**
   * Member roster for one event — metadata only, by design: display
   * name, status, intent, team and verdict counters. Emails and content
   * never leave this layer (data minimization); content is only ever
   * shown through the audited queue/thread views.
   */
  async listUsers(eventSlug: string): Promise<AdminUserItem[]> {
    const [users, participations, teams, riskCounts] = await Promise.all([
      this.deps.users.listAll(),
      this.deps.participants.listByEvent(eventSlug),
      this.deps.teams.listByEvent(eventSlug),
      this.deps.records?.countRiskBySubject() ?? new Map<string, { high: number; medium: number }>(),
    ])
    const intentByUser = new Map(participations.map((p) => [p.userId, p.intent]))
    const teamByUser = new Map<string, { teamId: string; teamName: string }>()
    for (const team of teams) {
      for (const member of await this.deps.teams.listMembers(team.id)) {
        teamByUser.set(member.userId, { teamId: team.id, teamName: team.name })
      }
    }
    return users
      .filter((u) => u.status !== 'deleted')
      .map((u) => ({
        userId: u.id,
        displayName: u.displayName,
        status: u.status,
        createdAt: u.createdAt,
        intent: intentByUser.get(u.id) ?? null,
        teamId: teamByUser.get(u.id)?.teamId ?? null,
        teamName: teamByUser.get(u.id)?.teamName ?? null,
        highCount: riskCounts.get(u.id)?.high ?? 0,
        mediumCount: riskCounts.get(u.id)?.medium ?? 0,
      }))
  }

  /** Team roster for one event (public team fields + owner name). */
  async listTeams(eventSlug: string): Promise<AdminTeamItem[]> {
    const teams = await this.deps.teams.listByEvent(eventSlug)
    return Promise.all(
      teams.map(async (t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        memberCount: t.memberCount,
        ownerUserId: t.ownerUserId,
        ownerDisplayName: (await this.deps.users.findById(t.ownerUserId))?.displayName ?? '（未知）',
        createdAt: t.createdAt,
      })),
    )
  }

  /**
   * Admin force-disband: unlike the owner's self-delete (sole member
   * only), this removes a team with members aboard — for fake or
   * malicious teams. Memberships cascade away, freeing members to join
   * other teams. Audit-logged.
   */
  async deleteTeam(teamId: string, adminUserId: string): Promise<boolean> {
    const team = await this.deps.teams.getById(teamId)
    if (!team) return false
    await this.deps.teams.delete(teamId)
    await this.deps.audit.log('admin_team_delete', {
      actorUserId: adminUserId,
      targetType: 'team',
      targetId: teamId,
      detail: `members=${team.memberCount}`,
    })
    return true
  }

  /** Platform overview numbers — counts only, no user content. */
  async getStats(eventSlug: string): Promise<import('@teamup/shared').AdminStats> {
    const users = await this.deps.users.countByStatus()
    const byIntent = await this.deps.participants.countByIntent(eventSlug)
    const participantsTotal = Object.values(byIntent).reduce((a, b) => a + b, 0)
    const teams = await this.deps.teams.listByEvent(eventSlug)
    const byStatus: Record<string, number> = {}
    let membersInTeams = 0
    for (const team of teams) {
      byStatus[team.status] = (byStatus[team.status] ?? 0) + 1
      membersInTeams += team.memberCount
    }
    const usersTotal = users.active + users.suspended + users.deleted
    return {
      users: { total: usersTotal, ...users },
      participants: { total: participantsTotal, byIntent },
      registeredWithoutParticipation: Math.max(0, usersTotal - users.deleted - participantsTotal),
      teams: { total: teams.length, byStatus, membersInTeams },
      messages: { total: await this.deps.messages.count() },
    }
  }

  /** Verdict history for one user (metadata only, no content). */
  async getUserModeration(userId: string): Promise<UserModerationHistory | null> {
    const user = await this.deps.users.findById(userId)
    if (!user) return null
    const records = (await this.deps.records?.listBySubject(userId, 50)) ?? []
    return {
      userId,
      displayName: user.displayName,
      status: user.status,
      records: records.map((r) => ({
        targetType: r.targetType,
        riskLevel: r.riskLevel,
        categories: [...r.categories],
        rationale: r.rationale,
        decidedBy: r.decidedBy,
        flagged: r.flagged,
        createdAt: r.createdAt,
      })),
    }
  }
}
