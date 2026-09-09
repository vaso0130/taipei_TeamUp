import { computed, reactive, ref, watch } from 'vue'
import {
  EventSeedSchema,
  type AdminEventStats,
  type AdminEventUsage,
  type DictionaryOption,
  type EventSeed,
  type EventStatus,
} from '@teamup/shared'
import { api, ApiError, type TokenSource } from '../api/client.js'
import { describeApiError } from '../lib/errors.js'
import { EVENT_STATUS_LABEL } from '../lib/event-status.js'
import { isoToTaipeiLocal, taipeiLocalToIso, taipeiYearMonth } from '../lib/taipei-time.js'

/**
 * Form state, validation and persistence for the event editor. The form is
 * a thin editing view over `EventSeed`: `candidate` rebuilds the seed on
 * every change, shared's `EventSeedSchema` validates it, and issue paths are
 * mapped back onto field ids — the same rules the seed importer applies,
 * so the form can never produce a seed the API rejects.
 */

export interface DictionaryRow {
  /** Local identity for v-for; not sent to the API. */
  id: string
  key: string
  label: string
  /** '' = no category (skills only carry one). */
  category: string
  isActive: boolean
  /** Saved on the server: its key is frozen and deletion is usage-gated. */
  persisted: boolean
  /** Participants currently selecting this option. */
  usage: number
}

export interface EventForm {
  name: string
  slug: string
  description: string
  /** Taipei wall-clock values (`YYYY-MM-DDTHH:mm`) for datetime-local inputs. */
  startsAt: string
  endsAt: string
  recruitClosesAt: string
  minMembers: number | null
  maxMembers: number | null
  exclusiveMembership: boolean
  requiredContacts: number | null
  requiresAdultCheck: boolean
  termTeam: string
  termMember: string
  status: EventStatus
  retentionDays: number | null
  maxCustomTags: number | null
  customTagMaxLength: number | null
  roles: DictionaryRow[]
  skills: DictionaryRow[]
}

/** Starting point chosen on /admin/events/new (carried in the query string). */
export type EditorStart =
  | { kind: 'blank' }
  | { kind: 'template'; key: string }
  | { kind: 'copy'; slug: string }

export const SECTIONS = [
  { id: 'basics', label: '基本資料' },
  { id: 'schedule', label: '時程' },
  { id: 'rules', label: '組隊規則' },
  { id: 'terms', label: '用語' },
  { id: 'roles', label: '角色字典' },
  { id: 'skills', label: '技能字典' },
  { id: 'tags', label: '自訂標籤與資料保存' },
  { id: 'status', label: '狀態與發布' },
] as const
export type SectionId = (typeof SECTIONS)[number]['id']

export interface FieldError {
  /** Dot path into the seed, e.g. `event.name`, `roles.2.label`. */
  path: string
  message: string
  section: SectionId
  source: 'client' | 'server'
}

/** Field id used for `id` / `aria-describedby` / summary links. */
export const fieldId = (path: string) => `f-${path.replace(/\./g, '-')}`
export const sectionElementId = (section: SectionId) => `section-${section}`

const EVENT_FIELD_SECTION: Record<string, SectionId> = {
  name: 'basics',
  slug: 'basics',
  description: 'basics',
  startsAt: 'schedule',
  endsAt: 'schedule',
  recruitClosesAt: 'schedule',
  minMembers: 'rules',
  maxMembers: 'rules',
  exclusiveMembership: 'rules',
  requiredContacts: 'rules',
  requiresAdultCheck: 'rules',
  termTeam: 'terms',
  termMember: 'terms',
  maxCustomTags: 'tags',
  customTagMaxLength: 'tags',
  retentionDays: 'tags',
  status: 'status',
}

const EVENT_FIELD_LABEL: Record<string, string> = {
  name: '活動名稱',
  slug: '網址代號',
  description: '活動說明',
  startsAt: '活動開始',
  endsAt: '活動結束',
  recruitClosesAt: '招募截止',
  minMembers: '最少人數',
  maxMembers: '最多人數',
  exclusiveMembership: '一人限加入一個',
  requiredContacts: '聯絡人數',
  requiresAdultCheck: '年齡確認',
  termTeam: '團體稱呼',
  termMember: '成員稱呼',
  maxCustomTags: '自訂標籤數',
  customTagMaxLength: '標籤最長字數',
  retentionDays: '資料保存天數',
  status: '狀態',
}

export function sectionOf(path: string): SectionId {
  const [head, second] = path.split('.')
  if (head === 'roles') return 'roles'
  if (head === 'skills') return 'skills'
  if (head === 'event' && second) return EVENT_FIELD_SECTION[second] ?? 'basics'
  return 'basics'
}

const DATE_FIELDS = new Set(['startsAt', 'endsAt', 'recruitClosesAt'])

/** Slugs that collide with sibling API routes (`/api/admin/events/templates`). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(['templates', 'new'])

type SeedParse = ReturnType<typeof EventSeedSchema.safeParse>
type SeedIssue = Extract<SeedParse, { success: false }>['error']['issues'][number]

/** Translate a zod issue into user copy for its field. */
function describeIssue(path: string, issue: SeedIssue): string {
  const leaf = path.split('.').pop() ?? ''
  const isDate = DATE_FIELDS.has(leaf)
  switch (issue.code) {
    case 'invalid_type':
      if (isDate) return '請填寫日期與時間'
      // zod reports a non-integer number as invalid_type expected "integer".
      if (issue.expected === 'integer') return '請填整數'
      return issue.expected === 'number' ? '請填寫數字' : '必填'
    case 'too_small': {
      const min = Number(issue.minimum)
      if (issue.type === 'string') return min <= 1 ? '必填' : `至少 ${min} 個字`
      if (issue.type === 'number') return `不能小於 ${issue.inclusive ? min : min + 1}`
      return `至少 ${min} 項`
    }
    case 'too_big': {
      const max = Number(issue.maximum)
      if (issue.type === 'string') return `最多 ${max} 個字`
      if (issue.type === 'number') return `不能大於 ${issue.inclusive ? max : max - 1}`
      return `最多 ${max} 項`
    }
    case 'invalid_string':
      if (isDate) return '請填寫日期與時間'
      if (leaf === 'slug') return '只能用小寫英文、數字與連字號（-），且以英文或數字開頭'
      if (leaf === 'key') return '代號格式錯誤，請調整名稱後重新新增'
      return '格式不正確'
    case 'custom': {
      const m = issue.message
      if (m.includes('maxMembers must be')) return '最多人數不能低於最少人數'
      if (m.includes('requiredContacts cannot exceed')) return '聯絡人數不能超過最多人數'
      if (m.includes('endsAt must be after')) return '活動結束須晚於活動開始'
      if (m.startsWith('duplicate key')) return '與另一列產生相同代號，請改用不同名稱'
      return m
    }
    default:
      return issue.message
  }
}

let rowSeq = 0
const newRowId = () => `row-${Date.now().toString(36)}-${(rowSeq++).toString(36)}`

function rowsFromOptions(
  options: DictionaryOption[],
  usage: Record<string, number> | undefined,
  persisted: boolean,
): DictionaryRow[] {
  return [...options]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((o) => ({
      id: newRowId(),
      key: o.key,
      label: o.label,
      category: o.category ?? '',
      isActive: o.isActive,
      persisted,
      usage: usage?.[o.key] ?? 0,
    }))
}

export function formFromSeed(
  seed: EventSeed,
  usage: AdminEventUsage | undefined,
  persisted: boolean,
): EventForm {
  const e = seed.event
  return {
    name: e.name,
    slug: e.slug,
    description: e.description,
    startsAt: isoToTaipeiLocal(e.startsAt),
    endsAt: isoToTaipeiLocal(e.endsAt),
    recruitClosesAt: isoToTaipeiLocal(e.recruitClosesAt),
    // A starting point (blank/template) may be incomplete: keep nulls, not NaN.
    minMembers: e.minMembers ?? null,
    maxMembers: e.maxMembers ?? null,
    exclusiveMembership: e.exclusiveMembership ?? true,
    requiredContacts: e.requiredContacts ?? null,
    requiresAdultCheck: e.requiresAdultCheck ?? false,
    termTeam: e.termTeam ?? '',
    termMember: e.termMember ?? '',
    status: e.status ?? 'draft',
    retentionDays: e.retentionDays ?? null,
    maxCustomTags: e.maxCustomTags ?? null,
    customTagMaxLength: e.customTagMaxLength ?? null,
    roles: rowsFromOptions(seed.roles, usage?.roles, persisted),
    skills: rowsFromOptions(seed.skills, usage?.skills, persisted),
  }
}

/** The "blank" starting point: schema defaults only, one-person teams. */
export function blankSeed(): EventSeed {
  return {
    event: {
      slug: '',
      name: '',
      description: '',
      startsAt: '',
      endsAt: '',
      recruitClosesAt: '',
      minMembers: 1,
      maxMembers: 1,
      exclusiveMembership: true,
      requiredContacts: 0,
      requiresAdultCheck: false,
      termTeam: '隊伍',
      termMember: '成員',
      status: 'draft',
      retentionDays: 90,
      maxCustomTags: 0,
      customTagMaxLength: 16,
    },
    roles: [],
    skills: [],
  }
}

export function defaultSlug(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `event-${taipeiYearMonth(now)}-${rand}`
}

const optionFromRow = (row: DictionaryRow, index: number) => {
  const option: Record<string, unknown> = {
    key: row.key,
    label: row.label.trim(),
    sortOrder: index + 1,
    isActive: row.isActive,
  }
  if (row.category.trim()) option.category = row.category.trim()
  return option
}

const num = (v: number | null) => (v === null || Number.isNaN(v) ? undefined : v)

/** Seed candidate for validation; `unknown` because it may be incomplete. */
export function candidateFromForm(form: EventForm): unknown {
  return {
    event: {
      slug: form.slug.trim(),
      name: form.name.trim(),
      description: form.description.trim(),
      startsAt: taipeiLocalToIso(form.startsAt),
      endsAt: taipeiLocalToIso(form.endsAt),
      recruitClosesAt: taipeiLocalToIso(form.recruitClosesAt),
      minMembers: num(form.minMembers),
      maxMembers: num(form.maxMembers),
      exclusiveMembership: form.exclusiveMembership,
      requiredContacts: num(form.requiredContacts),
      requiresAdultCheck: form.requiresAdultCheck,
      termTeam: form.termTeam.trim(),
      termMember: form.termMember.trim(),
      status: form.status,
      retentionDays: num(form.retentionDays),
      maxCustomTags: num(form.maxCustomTags),
      customTagMaxLength: num(form.customTagMaxLength),
    },
    roles: form.roles.map(optionFromRow),
    skills: form.skills.map(optionFromRow),
  }
}

export interface EditorOptions {
  mode: 'create' | 'edit'
  token: TokenSource
}

export function useEventEditor(options: EditorOptions) {
  const form = reactive<EventForm>(formFromSeed(blankSeed(), undefined, false))
  const usage = ref<AdminEventUsage>({ roles: {}, skills: {} })
  const stats = ref<AdminEventStats | null>(null)
  /** Slug the record is stored under (edit mode); fixed once created. */
  const savedSlug = ref<string | null>(null)
  const baseline = ref('')
  const loaded = ref(false)

  const termTeam = computed(() => form.termTeam.trim() || '隊伍')

  const candidate = computed(() => candidateFromForm(form))
  const candidateJson = computed(() => JSON.stringify(candidate.value))
  const dirty = computed(() => loaded.value && candidateJson.value !== baseline.value)

  // ---- validation ----
  const parse = computed(() => EventSeedSchema.safeParse(candidate.value))

  const clientErrors = computed<FieldError[]>(() => {
    const list: FieldError[] = []
    const seen = new Set<string>()
    const push = (path: string, message: string) => {
      if (seen.has(path)) return // first issue per field wins
      seen.add(path)
      list.push({ path, message, section: sectionOf(path), source: 'client' })
    }
    const result = parse.value
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path.join('.')
        push(path || 'event', describeIssue(path, issue))
      }
    }
    // Cross-field rule the shared schema does not carry (§3 ②).
    const end = Date.parse(taipeiLocalToIso(form.endsAt))
    const recruit = Date.parse(taipeiLocalToIso(form.recruitClosesAt))
    if (!Number.isNaN(end) && !Number.isNaN(recruit) && recruit > end) {
      push('event.recruitClosesAt', '招募截止不得晚於活動結束')
    }
    // `templates` is a route segment under /api/admin/events — the server refuses it too.
    if (RESERVED_SLUGS.has(form.slug.trim())) {
      push('event.slug', `「${form.slug.trim()}」是系統保留字，請換一個`)
    }
    return list
  })

  const serverErrors = ref<FieldError[]>([])
  /** Server messages with no field to attach to; shown in the summary only. */
  const summaryOnly = ref<string[]>([])
  const saveError = ref<string | null>(null)

  const errors = computed<FieldError[]>(() => [...serverErrors.value, ...clientErrors.value])

  const touched = reactive(new Set<string>())
  const submitted = ref(false)
  const touch = (path: string) => {
    touched.add(path)
  }

  /** Errors the UI may show now: after a submit attempt, or on touched/server fields. */
  const visibleErrors = computed(() => {
    const seen = new Set<string>()
    return errors.value.filter((e) => {
      if (seen.has(e.path)) return false
      seen.add(e.path)
      return submitted.value || e.source === 'server' || touched.has(e.path)
    })
  })
  const errorFor = (path: string): string | undefined =>
    visibleErrors.value.find((e) => e.path === path)?.message
  const errorCounts = computed<Record<SectionId, number>>(() => {
    const counts = Object.fromEntries(SECTIONS.map((s) => [s.id, 0])) as Record<SectionId, number>
    for (const e of visibleErrors.value) counts[e.section]++
    return counts
  })

  /** Human label for a field, for summary links. */
  function labelFor(path: string): string {
    const [head, second, third] = path.split('.')
    if (head === 'event' && second) return EVENT_FIELD_LABEL[second] ?? second
    if ((head === 'roles' || head === 'skills') && second !== undefined) {
      const kind = head === 'roles' ? '角色' : '技能'
      const idx = Number(second)
      const row = form[head][idx]
      const what = third === 'category' ? '分類' : third === 'key' ? '代號' : '名稱'
      if (Number.isNaN(idx)) return `${kind}字典`
      return `${kind}第 ${idx + 1} 列${row?.label.trim() ? `「${row.label.trim()}」` : ''}${what}`
    }
    if (head === 'roles') return '角色字典'
    if (head === 'skills') return '技能字典'
    return path
  }

  const warnings = computed(() => {
    const recruit = Date.parse(taipeiLocalToIso(form.recruitClosesAt))
    return {
      recruitClosed: !Number.isNaN(recruit) && recruit < Date.now(),
    }
  })

  // Any edit invalidates server feedback for the previous payload.
  watch(candidateJson, () => {
    serverErrors.value = []
    summaryOnly.value = []
    saveError.value = null
  })

  // ---- loading ----
  function applySeed(seed: EventSeed, nextUsage: AdminEventUsage | undefined, persisted: boolean) {
    Object.assign(form, formFromSeed(seed, nextUsage, persisted))
    if (nextUsage) usage.value = nextUsage
  }

  /** Install the starting point; `persisted` = rows already exist server-side. */
  function load(seed: EventSeed, extra?: { usage?: AdminEventUsage; stats?: AdminEventStats }) {
    const persisted = options.mode === 'edit'
    applySeed(seed, extra?.usage, persisted)
    // A new event is always created as a draft (CreateEventInputSchema).
    if (options.mode === 'create') form.status = 'draft'
    stats.value = extra?.stats ?? null
    savedSlug.value = options.mode === 'edit' ? seed.event.slug : null
    baseline.value = candidateJson.value
    touched.clear()
    submitted.value = false
    serverErrors.value = []
    summaryOnly.value = []
    saveError.value = null
    loaded.value = true
  }

  // ---- saving ----
  const saving = ref(false)
  const savedAt = ref<Date | null>(null)
  const justSaved = ref(false)
  let savedTimer: ReturnType<typeof setTimeout> | undefined
  const serverWarnings = ref<string[]>([])

  function pushServerError(path: string, message: string) {
    serverErrors.value = [
      ...serverErrors.value,
      { path, message, section: sectionOf(path), source: 'server' },
    ]
  }

  function mapServerError(err: unknown) {
    if (!(err instanceof ApiError)) {
      saveError.value = '儲存失敗，請稍後再試'
      return
    }
    const body = err.body
    switch (err.code) {
      case 'slug_taken':
        pushServerError('event.slug', '這個代號已被使用')
        return
      case 'slug_immutable':
        pushServerError('event.slug', '建立後不可更改')
        return
      case 'max_members_below_existing': {
        const n = Number(body.current)
        pushServerError('event.maxMembers', `已有${termTeam.value}有 ${n} 人，上限不能低於 ${n}`)
        return
      }
      case 'min_members_above_existing': {
        const n = Number(body.current)
        pushServerError('event.minMembers', `已有${termTeam.value}只有 ${n} 人，下限不能高於 ${n}`)
        return
      }
      case 'dictionary_key_in_use': {
        const key = String(body.key ?? '')
        const count = Number(body.count ?? 0)
        const message = `已有 ${count} 人選用，只能停用不能刪除`
        for (const list of ['roles', 'skills'] as const) {
          const i = form[list].findIndex((r) => r.key === key)
          if (i >= 0) {
            pushServerError(`${list}.${i}.label`, message)
            return
          }
        }
        summaryOnly.value = [
          ...summaryOnly.value,
          `選項「${key}」已有 ${count} 人選用，無法刪除；請重新載入後改為停用。`,
        ]
        return
      }
      case 'validation_failed': {
        const issues = Array.isArray(body.issues) ? (body.issues as SeedIssue[]) : []
        if (issues.length === 0) {
          saveError.value = describeApiError(err, { termTeam: termTeam.value }, '儲存失敗')
          return
        }
        for (const issue of issues) {
          const path = Array.isArray(issue.path) ? issue.path.join('.') : ''
          const [head] = path.split('.')
          if (head === 'event' || head === 'roles' || head === 'skills') {
            pushServerError(path, describeIssue(path, issue))
          } else {
            summaryOnly.value = [...summaryOnly.value, issue.message]
          }
        }
        return
      }
      default:
        saveError.value = describeApiError(err, { termTeam: termTeam.value }, '儲存失敗，請稍後再試')
    }
  }

  /**
   * Validate then persist. Resolves to `saved`, `invalid` (client errors —
   * the page focuses the summary) or `failed` (server rejected; errors are
   * mapped onto fields / summary).
   */
  async function save(): Promise<'saved' | 'invalid' | 'failed'> {
    submitted.value = true
    serverErrors.value = []
    summaryOnly.value = []
    saveError.value = null
    const result = parse.value
    if (!result.success || clientErrors.value.length > 0) return 'invalid'
    saving.value = true
    try {
      // Status only changes through its own endpoint; the PUT ignores it.
      const seed: EventSeed = result.data
      let saved: EventSeed
      if (options.mode === 'create' || savedSlug.value === null) {
        const draft: EventSeed = { ...seed, event: { ...seed.event, status: 'draft' } }
        saved = (await api.adminCreateEvent(options.token, draft)).seed
      } else {
        const res = await api.adminUpdateEvent(options.token, savedSlug.value, seed)
        saved = res.seed
        serverWarnings.value = res.warnings ?? []
      }
      applySeed(saved, usage.value, true)
      savedSlug.value = saved.event.slug
      baseline.value = candidateJson.value
      savedAt.value = new Date()
      justSaved.value = true
      clearTimeout(savedTimer)
      savedTimer = setTimeout(() => (justSaved.value = false), 3000)
      return 'saved'
    } catch (err) {
      mapServerError(err)
      return 'failed'
    } finally {
      saving.value = false
    }
  }

  /** Restore the last saved state (or the starting point) — caller confirms. */
  function discard() {
    if (!baseline.value) return
    // The baseline is the candidate JSON: seed-shaped, possibly incomplete
    // (blank/template starting point) — formFromSeed tolerates missing values.
    applySeed(JSON.parse(baseline.value) as EventSeed, usage.value, options.mode === 'edit')
    touched.clear()
    submitted.value = false
    serverErrors.value = []
    summaryOnly.value = []
    saveError.value = null
  }

  // ---- status lifecycle (§6) ----
  const statusBusy = ref(false)
  const statusError = ref<string | null>(null)
  /** Missing items from `cannot_open_incomplete`; null = no checklist shown. */
  const openChecklist = ref<string[] | null>(null)

  async function changeStatus(to: EventStatus): Promise<boolean> {
    if (!savedSlug.value) return false
    statusBusy.value = true
    statusError.value = null
    openChecklist.value = null
    try {
      const { seed } = await api.adminSetEventStatus(options.token, savedSlug.value, to)
      applySeed(seed, usage.value, true)
      baseline.value = candidateJson.value
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cannot_open_incomplete') {
        const details = Array.isArray(err.body.details) ? (err.body.details as string[]) : []
        openChecklist.value = details.length ? details : ['活動設定尚未完整']
      } else if (err instanceof ApiError && err.code === 'invalid_status_transition') {
        statusError.value = `目前狀態不能直接變成${EVENT_STATUS_LABEL[to]}`
      } else {
        statusError.value = describeApiError(err, { termTeam: termTeam.value }, '狀態變更失敗，請稍後再試')
      }
      return false
    } finally {
      statusBusy.value = false
    }
  }

  async function deleteEvent(): Promise<boolean> {
    if (!savedSlug.value) return false
    statusBusy.value = true
    statusError.value = null
    try {
      await api.adminDeleteEvent(options.token, savedSlug.value)
      baseline.value = candidateJson.value // nothing left to protect with the leave guard
      return true
    } catch (err) {
      statusError.value = describeApiError(err, { termTeam: termTeam.value }, '刪除失敗，請稍後再試', {
        // DELETE on a non-draft comes back as a transition to "deleted".
        invalid_status_transition: '只有草稿可以刪除；其他狀態請改走關閉與封存。',
      })
      return false
    } finally {
      statusBusy.value = false
    }
  }

  return {
    form,
    usage,
    stats,
    savedSlug,
    loaded,
    termTeam,
    dirty,
    errors,
    visibleErrors,
    summaryOnly,
    errorFor,
    errorCounts,
    labelFor,
    touch,
    touched,
    submitted,
    warnings,
    load,
    save,
    saving,
    savedAt,
    justSaved,
    saveError,
    serverWarnings,
    discard,
    changeStatus,
    deleteEvent,
    statusBusy,
    statusError,
    openChecklist,
  }
}

export type EventEditor = ReturnType<typeof useEventEditor>
