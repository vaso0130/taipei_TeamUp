import type { EventStatus } from '@teamup/shared'

/**
 * Platform copy for the event lifecycle (docs/design/admin-events.md §6).
 * "closed" means recruiting has stopped — the event itself may still lie
 * ahead — so public surfaces derive 已結束 vs 已停止招募 from `endsAt`
 * (see `publicClosedLabel`) instead of collapsing both into one word.
 */
export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  draft: '草稿',
  open: '招募中',
  closed: '已停止招募',
  archived: '已封存',
}

/** What participants currently see, per status (status card). */
export const EVENT_STATUS_DESCRIPTION: Record<EventStatus, string> = {
  draft: '草稿對外不可見。開放招募後會出現在活動列表，參加者可以填資料、開團。',
  open: '參加者可以開團、申請、傳訊息。',
  closed: '不能開團與申請；仍會出現在活動列表的摺疊區，資料依保存天數清除。',
  archived: '已從所有列表隱藏；直接連結仍可瀏覽。',
}

/** Badge colors: only "open" is a live state; the rest are muted/neutral. */
export const EVENT_STATUS_CLASS: Record<EventStatus, string> = {
  draft: 'bg-warn-mist text-warn',
  open: 'bg-ok-mist text-ok',
  closed: 'bg-mist text-dim',
  archived: 'bg-mist text-dim',
}

/** Signboard top-rule color per status (mirrors TeamCard). */
export const EVENT_STATUS_BAR: Record<EventStatus, string> = {
  draft: 'var(--color-warn)',
  open: 'var(--color-primary)',
  closed: 'var(--color-dim)',
  archived: 'var(--color-line)',
}

/** List ordering: live first, then work-in-progress, then history. */
export const EVENT_STATUS_ORDER: EventStatus[] = ['open', 'draft', 'closed', 'archived']

/** Forward transitions offered as the primary action (see §6 table). */
export const EVENT_STATUS_NEXT: Partial<Record<EventStatus, EventStatus>> = {
  draft: 'open',
  open: 'closed',
  closed: 'archived',
}

/** Button copy for that primary action, keyed by the *current* status. */
export const EVENT_STATUS_ACTION_LABEL: Partial<Record<EventStatus, string>> = {
  draft: '開放招募',
  open: '停止招募',
  closed: '封存（從列表隱藏）',
}

/** closed → open is the one backward step; offered as a secondary action. */
export const EVENT_REOPEN_LABEL = '重新開放招募'

export const EVENT_DELETE_LABEL = '刪除活動'

/** Button copy for a specific transition; null when the machine does not allow it. */
export function transitionLabel(from: EventStatus, to: EventStatus): string | null {
  if (from === 'closed' && to === 'open') return EVENT_REOPEN_LABEL
  if (EVENT_STATUS_NEXT[from] === to) return EVENT_STATUS_ACTION_LABEL[from] ?? null
  return null
}

export interface ConfirmCopy {
  title: string
  body: string
  confirm: string
  danger: boolean
}

/** Confirmation dialog for a transition; shared by the editor's status card and the list. */
export function statusDialogCopy(
  from: EventStatus,
  to: EventStatus,
  termTeam: string,
): ConfirmCopy | null {
  if (from === 'draft' && to === 'open') {
    return {
      title: '開放招募',
      body: '開放後會出現在活動列表，參加者可以填資料、開團。系統會先檢查：名稱、三個時間有效、招募截止在未來、人數規則、至少一個角色與一個技能。',
      confirm: '確認開放',
      danger: false,
    }
  }
  if (from === 'closed' && to === 'open') {
    return {
      title: '重新開放招募',
      body: `重新開放後參加者又可以開${termTeam}、申請與傳訊息；既有${termTeam}維持不變。`,
      confirm: '重新開放',
      danger: false,
    }
  }
  if (from === 'open' && to === 'closed') {
    return {
      title: '停止招募',
      body: `停止後不能再開${termTeam}與申請，既有${termTeam}與訊息仍可見；活動仍會出現在列表的摺疊區。可以重新開放招募。`,
      confirm: '確認停止招募',
      danger: false,
    }
  }
  if (from === 'closed' && to === 'archived') {
    return {
      title: '封存活動',
      body: '封存後從所有列表隱藏，直接連結仍可瀏覽。此動作不可逆。',
      confirm: '確認封存',
      danger: true,
    }
  }
  return null
}

/** Confirmation dialog for deleting an event (settings + dictionaries; only when empty). */
export const EVENT_DELETE_DIALOG: ConfirmCopy = {
  title: '刪除活動？',
  body: '會刪除這場活動的設定與字典。此動作不可逆。',
  confirm: '確認刪除',
  danger: true,
}

/** Why delete is unavailable (shown as tooltip / hint). */
export const cannotDeleteHint = (termTeam: string) => `已有參加者或${termTeam}，只能封存`

/** `role=status` announcement after a successful transition. */
export function statusChangeAnnouncement(from: EventStatus, to: EventStatus): string {
  if (from === 'closed' && to === 'open') return '已重新開放招募'
  if (to === 'open') return '已開放招募'
  return EVENT_STATUS_LABEL[to]
}

/** An event has ended once `endsAt` is in the past. */
export const hasEnded = (endsAt: string, now = Date.now()) => new Date(endsAt).getTime() <= now

/** Public wording for a closed event: 已結束 once the event is over, otherwise 已停止招募. */
export const publicClosedLabel = (endsAt: string, now = Date.now()) =>
  hasEnded(endsAt, now) ? '已結束' : EVENT_STATUS_LABEL.closed
