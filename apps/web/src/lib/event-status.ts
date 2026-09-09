import type { EventStatus } from '@teamup/shared'

/** Platform copy for the event lifecycle (docs/design/admin-events.md §6). */
export const EVENT_STATUS_LABEL: Record<EventStatus, string> = {
  draft: '草稿',
  open: '開放中',
  closed: '已關閉',
  archived: '已封存',
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
  draft: '開放活動',
  open: '關閉招募與活動',
  closed: '封存',
}
