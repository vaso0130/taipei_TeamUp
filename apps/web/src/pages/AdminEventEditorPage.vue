<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { SCHEMA_LIMITS, type EventSeed, type EventStatus } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import AdminGate from '../components/admin/AdminGate.vue'
import DictionaryEditor from '../components/admin/DictionaryEditor.vue'
import ErrorSummary from '../components/admin/ErrorSummary.vue'
import EventEditorNav from '../components/admin/EventEditorNav.vue'
import EventPreview from '../components/admin/EventPreview.vue'
import EventStatusBadge from '../components/admin/EventStatusBadge.vue'
import EventStatusCard from '../components/admin/EventStatusCard.vue'
import FormField from '../components/admin/FormField.vue'
import SwitchField from '../components/admin/SwitchField.vue'
import LoadError from '../components/LoadError.vue'
import ModalShell from '../components/ModalShell.vue'
import {
  SECTIONS,
  blankSeed,
  defaultSlug,
  fieldId,
  sectionElementId,
  useEventEditor,
  type EditorStart,
  type SectionId,
} from '../composables/useEventEditor.js'
import { downloadBlob } from '../lib/download.js'
import { classifyLoadError, describeApiError, isReadOnlyMode, type LoadFailure } from '../lib/errors.js'
import { EVENT_STATUS_ACTION_LABEL, EVENT_STATUS_NEXT, statusChangeAnnouncement } from '../lib/event-status.js'
import { daysBetween, formatTaipeiShort, taipeiLocalToIso, weekdayLabel } from '../lib/taipei-time.js'
import { useAuthStore } from '../stores/auth.js'

/**
 * Event editor (docs/design/admin-events.md §3–§7). One component for
 * create and edit: `mode="create"` starts from a template / copy / blank
 * (see AdminEventNewPage) and POSTs; `mode="edit"` loads by route slug
 * and PUTs. Layout: sticky header, section nav | form | live preview,
 * sticky action bar; on narrow screens the nav becomes chips and the
 * preview a bottom drawer.
 */
const props = defineProps<{ mode: 'create' | 'edit'; start?: EditorStart }>()

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const editor = useEventEditor({ mode: props.mode, token: () => auth.getToken() })
const { form } = editor

// ---- loading ----
const loadState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const loadError = ref<LoadFailure | null>(null)
const readOnly = ref(false)
const forbidden = ref(false)
/** Copied events keep the source dates; the schedule section flags them. */
const copiedDates = ref(false)

const routeSlug = computed(() => (typeof route.params.slug === 'string' ? route.params.slug : ''))

async function startingSeed(start: EditorStart): Promise<EventSeed> {
  if (start.kind === 'blank') {
    const seed = blankSeed()
    seed.event.slug = defaultSlug()
    return seed
  }
  if (start.kind === 'template') {
    const { templates } = await api.adminListEventTemplates(auth.getToken)
    const template = templates.find((t) => t.key === start.key)
    if (!template) throw new ApiError(404, 'template_not_found')
    const seed = template.seed
    return {
      ...seed,
      event: { ...seed.event, slug: seed.event.slug || defaultSlug(), status: 'draft' },
    }
  }
  const { seed } = await api.adminGetEvent(auth.getToken, start.slug)
  copiedDates.value = true
  return {
    ...seed,
    event: { ...seed.event, name: `${seed.event.name}（複本）`, slug: '', status: 'draft' },
  }
}

async function load() {
  if (!auth.me?.isAdmin) return
  loadState.value = 'loading'
  loadError.value = null
  readOnly.value = false
  forbidden.value = false
  copiedDates.value = false
  try {
    if (props.mode === 'edit') {
      const detail = await api.adminGetEvent(auth.getToken, routeSlug.value)
      editor.load(detail.seed, { usage: detail.usage, stats: detail.stats })
    } else if (props.start) {
      editor.load(await startingSeed(props.start))
    }
    loadState.value = 'ready'
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
      forbidden.value = true
    } else {
      readOnly.value = isReadOnlyMode(err)
      loadError.value = classifyLoadError(err)
    }
    loadState.value = 'error'
  }
}

onMounted(load)
watch(
  () => auth.me?.isAdmin,
  (isAdmin) => {
    if (isAdmin && loadState.value === 'idle') void load()
  },
)
watch([routeSlug, () => props.start], () => {
  loadState.value = 'idle'
  void load()
})

// ---- section tracking ----
const activeSection = ref<SectionId>('basics')
let scrollFrame = 0
function updateActiveSection() {
  scrollFrame = 0
  let current: SectionId = SECTIONS[0].id
  for (const s of SECTIONS) {
    const el = document.getElementById(sectionElementId(s.id))
    if (el && el.getBoundingClientRect().top <= 160) current = s.id
  }
  activeSection.value = current
}
function onScroll() {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updateActiveSection)
}

// ---- leave guards (§7) ----
const LEAVE_MESSAGE = '有未儲存的變更，確定要離開嗎？'
let leavingIntentionally = false
onBeforeRouteLeave(() => {
  if (!editor.dirty.value || leavingIntentionally) return true
  return window.confirm(LEAVE_MESSAGE)
})
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!editor.dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('beforeunload', onBeforeUnload)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
})

// ---- saving ----
const summary = ref<InstanceType<typeof ErrorSummary> | null>(null)
const summaryItems = computed(() =>
  editor.visibleErrors.value.map((e) => ({
    fieldId: fieldId(e.path),
    label: editor.labelFor(e.path),
    message: e.message,
  })),
)
const showSummary = computed(
  () =>
    (editor.submitted.value || editor.visibleErrors.value.some((e) => e.source === 'server')) &&
    (summaryItems.value.length > 0 || editor.summaryOnly.value.length > 0),
)

async function onSave() {
  // A stale "狀態已變更為…" must not outlive the next save (ADR-035 known gap).
  announcement.value = ''
  const result = await editor.save()
  if (result === 'saved') {
    if (props.mode === 'create' && editor.savedSlug.value) {
      leavingIntentionally = true
      await router.replace({ name: 'admin-event-edit', params: { slug: editor.savedSlug.value } })
    }
    return
  }
  await nextTick()
  if (showSummary.value) summary.value?.focus()
}

function onDiscard() {
  if (!window.confirm('放棄所有未儲存的變更？')) return
  editor.discard()
}

const savedTime = computed(() =>
  editor.savedAt.value
    ? editor.savedAt.value.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })
    : '',
)
const saveStatusText = computed(() => {
  if (editor.saving.value) return '儲存中⋯'
  if (editor.justSaved.value) return `已儲存 ${savedTime.value}`
  if (editor.dirty.value) return '有未儲存的變更'
  if (props.mode === 'create') return '尚未建立'
  return '已儲存'
})

// ---- status / delete / export ----
const statusCard = ref<InstanceType<typeof EventStatusCard> | null>(null)
const nextStatus = computed(() => EVENT_STATUS_NEXT[form.status])
const nextStatusLabel = computed(() => EVENT_STATUS_ACTION_LABEL[form.status])
const announcement = ref('')

async function onStatusChange(to: EventStatus) {
  const from = form.status
  announcement.value = ''
  const ok = await editor.changeStatus(to)
  if (ok) announcement.value = `狀態已變更：${statusChangeAnnouncement(from, to)}`
}

async function onDelete() {
  const ok = await editor.deleteEvent()
  if (ok) {
    leavingIntentionally = true
    await router.replace({ name: 'admin-events' })
  }
}

const exporting = ref(false)
const exportError = ref('')
async function exportJson() {
  if (!editor.savedSlug.value) return
  exporting.value = true
  exportError.value = ''
  try {
    const { blob, filename } = await api.adminExportEvent(auth.getToken, editor.savedSlug.value)
    downloadBlob(blob, filename ?? `${editor.savedSlug.value}.json`)
  } catch (err) {
    exportError.value = describeApiError(err, { termTeam: editor.termTeam.value }, '匯出失敗，請稍後再試')
  } finally {
    exporting.value = false
  }
}

/** Any status may be deleted as long as nobody has joined or formed a team (ADR-035). */
const canDelete = computed(() => {
  const s = editor.stats.value
  return s !== null && s.teams === 0 && s.participants === 0
})

// ---- field helpers ----
const previewOpen = ref(false)

function numInput(e: Event): number | null {
  const v = (e.target as HTMLInputElement).value.trim()
  if (v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

const memberSentence = computed(() => {
  const min = form.minMembers
  const max = form.maxMembers
  if (min === null || max === null) return `每${editor.termTeam.value}人數尚未填寫`
  return `每${editor.termTeam.value} ${min === max ? min : `${min}–${max}`} 人`
})

const contactsHint = computed(() => {
  const n = form.requiredContacts
  if (n === 0) return '不需要聯絡人。'
  if (n === null) return `0 表示不需要聯絡人，最多不超過每${editor.termTeam.value}的最多人數。`
  return `成${editor.termTeam.value}後，${editor.termTeam.value}必須指定 ${n} 位聯絡人才算完成。`
})

const scheduleSummary = computed(() => {
  if (!taipeiLocalToIso(form.recruitClosesAt)) return ''
  let text = `招募期到 ${formatTaipeiShort(form.recruitClosesAt)}`
  const d = daysBetween(form.recruitClosesAt, form.startsAt)
  if (d !== null) text += d >= 0 ? `，距活動開始 ${d} 天` : `，在活動開始後 ${-d} 天才截止`
  return text
})

const termSentences = computed(() => {
  const t = editor.termTeam.value
  const contacts = form.requiredContacts ?? 0
  return [
    form.exclusiveMembership ? `每人限加入一個${t}` : `可同時加入多個${t}`,
    contacts > 0 ? `成${t}後需指定 ${contacts} 位聯絡人` : `成${t}後不需指定聯絡人`,
    `找${t}／找人`,
  ]
})

const descriptionCount = computed(() => `${form.description.length} / 2000`)
</script>

<template>
  <div>
    <AdminGate :forbidden="forbidden">
      <p v-if="loadState === 'loading' || loadState === 'idle'" class="text-dim">載入中⋯</p>

      <LoadError
        v-else-if="loadState === 'error' && loadError"
        :kind="loadError"
        :title="readOnly ? '目前為唯讀模式' : loadError === 'not_found' ? '找不到這場活動' : undefined"
        :hint="readOnly ? '此環境未連接資料庫，活動設定只能從 seed 檔載入，無法在後台編輯。' : undefined"
        @retry="load"
      >
        <template #action>
          <RouterLink :to="{ name: 'admin-events' }" class="btn btn-quiet">返回活動列表</RouterLink>
        </template>
      </LoadError>

      <template v-else-if="loadState === 'ready'">
        <!-- sticky header -->
        <header class="sticky top-0 z-20 -mx-4 border-b border-line bg-paper/95 px-4 py-2 backdrop-blur">
          <!-- One row that never wraps: the title truncates; the save state is repeated in the action bar, so it hides on phones. -->
          <div class="flex items-center gap-x-2 sm:gap-x-3">
            <RouterLink
              :to="{ name: 'admin-events' }"
              class="inline-flex min-h-[44px] shrink-0 items-center gap-1 text-sm text-dim hover:text-ink"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
              <span class="hidden sm:inline">活動列表</span>
              <span class="sr-only sm:hidden">返回活動列表</span>
            </RouterLink>
            <h1 class="min-w-0 flex-1 truncate text-base font-black sm:text-lg">
              {{ form.name.trim() || '未命名活動' }}
            </h1>
            <EventStatusBadge :status="form.status" class="shrink-0" />
            <p
              class="hidden shrink-0 text-sm sm:block"
              :class="editor.dirty.value ? 'text-warn' : 'text-dim'"
              role="status"
              aria-live="polite"
            >
              {{ saveStatusText }}
            </p>
          </div>
        </header>

        <p v-if="announcement" class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

        <div class="mt-6 lg:grid lg:grid-cols-[176px_minmax(0,1fr)_280px] lg:items-start lg:gap-6 xl:grid-cols-[200px_minmax(0,1fr)_320px] xl:gap-8">
          <!-- section nav -->
          <div class="lg:sticky lg:top-20">
            <EventEditorNav :active="activeSection" :error-counts="editor.errorCounts.value" @select="activeSection = $event" />
          </div>

          <!-- form -->
          <form
            id="event-form"
            class="mt-4 w-full max-w-[720px] space-y-10 lg:mx-auto lg:mt-0"
            novalidate
            @submit.prevent="onSave"
          >
            <ErrorSummary
              v-if="showSummary"
              ref="summary"
              :items="summaryItems"
              :extra="editor.summaryOnly.value"
            />
            <p v-if="editor.saveError.value" class="rounded-lg bg-danger-mist px-4 py-3 text-sm text-danger" role="alert">
              {{ editor.saveError.value }}
            </p>
            <ul v-if="editor.serverWarnings.value.length" class="rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn" role="status">
              <li v-for="(w, i) in editor.serverWarnings.value" :key="i">{{ w }}</li>
            </ul>

            <!-- ① 基本資料 -->
            <section :id="sectionElementId('basics')" class="scroll-mt-24 space-y-5" aria-labelledby="h-basics">
              <div>
                <p class="eyebrow">① 基本資料</p>
                <h2 id="h-basics" class="mt-1 text-xl font-bold outline-none" tabindex="-1">基本資料</h2>
              </div>

              <FormField
                :id="fieldId('event.name')"
                label="活動名稱"
                required
                hint="會出現在首頁標題與登入信。"
                :error="editor.errorFor('event.name')"
              >
                <template #default="{ describedby, invalid }">
                  <input
                    :id="fieldId('event.name')"
                    v-model="form.name"
                    type="text"
                    maxlength="100"
                    class="field-input"
                    :class="{ '!border-danger': invalid }"
                    :aria-describedby="describedby"
                    :aria-invalid="invalid || undefined"
                    autocomplete="off"
                    @blur="editor.touch('event.name')"
                  />
                </template>
              </FormField>

              <FormField
                :id="fieldId('event.slug')"
                label="網址代號（slug）"
                required
                :hint="
                  mode === 'edit'
                    ? '建立後不可更改，因為它是分享連結的一部分。'
                    : '小寫英文、數字與連字號（-），建議 3–60 字。建立後就不能改。'
                "
                :error="editor.errorFor('event.slug')"
              >
                <template #default="{ describedby, invalid }">
                  <div class="relative">
                    <input
                      :id="fieldId('event.slug')"
                      :value="form.slug"
                      type="text"
                      class="field-input font-mono"
                      :class="{ '!border-danger': invalid, 'bg-mist text-dim pr-10': mode === 'edit' }"
                      :readonly="mode === 'edit'"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      autocomplete="off"
                      spellcheck="false"
                      @input="form.slug = ($event.target as HTMLInputElement).value.toLowerCase()"
                      @blur="editor.touch('event.slug')"
                    />
                    <svg
                      v-if="mode === 'edit'"
                      class="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-dim"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                    >
                      <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                    </svg>
                  </div>
                  <p class="mt-1.5 text-xs text-dim break-all">
                    API 路徑：<span class="font-mono">/api/events/{{ form.slug.trim() || '…' }}</span>；多活動頁面上線後也會成為分享連結的一部分。
                  </p>
                </template>
              </FormField>

              <FormField
                :id="fieldId('event.description')"
                label="活動說明"
                hint="首頁第一段文字。放報名連結、注意事項；未滿 18 歲的規定也寫在這。"
                :meta="descriptionCount"
                :error="editor.errorFor('event.description')"
              >
                <template #default="{ describedby, invalid }">
                  <textarea
                    :id="fieldId('event.description')"
                    v-model="form.description"
                    rows="5"
                    maxlength="2000"
                    class="field-input min-h-[120px] resize-y"
                    :class="{ '!border-danger': invalid }"
                    :aria-describedby="describedby"
                    :aria-invalid="invalid || undefined"
                    @blur="editor.touch('event.description')"
                  ></textarea>
                </template>
              </FormField>
            </section>

            <!-- ② 時程 -->
            <section :id="sectionElementId('schedule')" class="scroll-mt-24 space-y-5" aria-labelledby="h-schedule">
              <div>
                <p class="eyebrow">② 時程</p>
                <h2 id="h-schedule" class="mt-1 text-xl font-bold outline-none" tabindex="-1">時程</h2>
                <p class="mt-1 text-sm text-dim">以台北時間（UTC+8）輸入，格式為日期加時間（例：2026-11-07 09:00）。</p>
              </div>
              <p v-if="copiedDates" class="rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn" role="note">
                這是複製來的日期，請確認。
              </p>

              <div class="grid gap-5 sm:grid-cols-3">
                <FormField
                  v-for="f in ([
                    { key: 'startsAt', label: '活動開始' },
                    { key: 'endsAt', label: '活動結束' },
                    { key: 'recruitClosesAt', label: '招募截止' },
                  ] as const)"
                  :id="fieldId(`event.${f.key}`)"
                  :key="f.key"
                  :label="f.label"
                  required
                  :meta="weekdayLabel(form[f.key])"
                  :error="editor.errorFor(`event.${f.key}`)"
                >
                  <template #default="{ describedby, invalid }">
                    <input
                      :id="fieldId(`event.${f.key}`)"
                      v-model="form[f.key]"
                      type="datetime-local"
                      class="field-input font-mono text-sm"
                      :class="{ '!border-danger': invalid }"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      @blur="editor.touch(`event.${f.key}`)"
                    />
                  </template>
                </FormField>
              </div>

              <p v-if="scheduleSummary" class="font-mono text-sm text-primary-deep">{{ scheduleSummary }}</p>
              <p v-if="editor.warnings.value.recruitClosed" class="rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn" role="note">
                招募已截止，開放後參加者無法開團。
              </p>
            </section>

            <!-- ③ 組隊規則 -->
            <section :id="sectionElementId('rules')" class="scroll-mt-24 space-y-5" aria-labelledby="h-rules">
              <div>
                <p class="eyebrow">③ 組隊規則</p>
                <h2 id="h-rules" class="mt-1 text-xl font-bold outline-none" tabindex="-1">組隊規則</h2>
              </div>

              <div class="flex flex-wrap items-end gap-4">
                <FormField :id="fieldId('event.minMembers')" label="最少人數" required class="w-32" :error="editor.errorFor('event.minMembers')">
                  <template #default="{ describedby, invalid }">
                    <input
                      :id="fieldId('event.minMembers')"
                      :value="form.minMembers ?? ''"
                      type="number"
                      inputmode="numeric"
                      min="1"
                      step="1"
                      class="field-input font-mono"
                      :class="{ '!border-danger': invalid }"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      @input="form.minMembers = numInput($event)"
                      @blur="editor.touch('event.minMembers'); editor.touch('event.maxMembers')"
                    />
                  </template>
                </FormField>
                <FormField :id="fieldId('event.maxMembers')" label="最多人數" required class="w-32" :error="editor.errorFor('event.maxMembers')">
                  <template #default="{ describedby, invalid }">
                    <input
                      :id="fieldId('event.maxMembers')"
                      :value="form.maxMembers ?? ''"
                      type="number"
                      inputmode="numeric"
                      min="1"
                      step="1"
                      class="field-input font-mono"
                      :class="{ '!border-danger': invalid }"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      @input="form.maxMembers = numInput($event)"
                      @blur="editor.touch('event.maxMembers'); editor.touch('event.minMembers'); editor.touch('event.requiredContacts')"
                    />
                  </template>
                </FormField>
                <p class="min-h-[44px] flex-1 self-end pb-2.5 text-sm font-medium text-primary-deep" aria-live="polite">
                  {{ memberSentence }}
                </p>
              </div>
              <p v-if="editor.stats.value && editor.stats.value.teams > 0" class="text-xs text-dim">
                目前最大的{{ editor.termTeam.value }} {{ editor.stats.value.largestTeam }} 人、最小 {{ editor.stats.value.smallestTeam }} 人；上下限不能與現況衝突。
              </p>

              <SwitchField
                :id="fieldId('event.exclusiveMembership')"
                v-model="form.exclusiveMembership"
                :label="`一人限加入一個${editor.termTeam.value}`"
                :hint="
                  form.exclusiveMembership
                    ? `開啟：每人同時只能在一個${editor.termTeam.value}，被接受時會自動撤回其他申請。`
                    : `關閉：同一人可以加入多個${editor.termTeam.value}（例如讀書會）。`
                "
              />

              <FormField
                :id="fieldId('event.requiredContacts')"
                label="成隊後需指定聯絡人數"
                required
                class="sm:w-64"
                :hint="contactsHint"
                :error="editor.errorFor('event.requiredContacts')"
              >
                <template #default="{ describedby, invalid }">
                  <input
                    :id="fieldId('event.requiredContacts')"
                    :value="form.requiredContacts ?? ''"
                    type="number"
                    inputmode="numeric"
                    min="0"
                    :max="form.maxMembers ?? SCHEMA_LIMITS.maxContacts"
                    step="1"
                    class="field-input font-mono"
                    :class="{ '!border-danger': invalid }"
                    :aria-describedby="describedby"
                    :aria-invalid="invalid || undefined"
                    @input="form.requiredContacts = numInput($event)"
                    @blur="editor.touch('event.requiredContacts')"
                  />
                </template>
              </FormField>

              <SwitchField
                :id="fieldId('event.requiresAdultCheck')"
                v-model="form.requiresAdultCheck"
                label="需要年齡確認"
                hint="開啟後參加者填資料時必須回答是否年滿 18 歲；平台不收同意書。"
              />
            </section>

            <!-- ④ 用語 -->
            <section :id="sectionElementId('terms')" class="scroll-mt-24 space-y-5" aria-labelledby="h-terms">
              <div>
                <p class="eyebrow">④ 用語</p>
                <h2 id="h-terms" class="mt-1 text-xl font-bold outline-none" tabindex="-1">用語</h2>
                <p class="mt-1 text-sm text-dim">整個前台都會照這兩個詞稱呼，例如「讀書會／書友」。</p>
              </div>
              <div class="grid gap-5 sm:grid-cols-2">
                <FormField :id="fieldId('event.termTeam')" label="團體的稱呼" required hint="預設「隊伍」，1–20 字。" :error="editor.errorFor('event.termTeam')">
                  <template #default="{ describedby, invalid }">
                    <input
                      :id="fieldId('event.termTeam')"
                      v-model="form.termTeam"
                      type="text"
                      maxlength="20"
                      class="field-input"
                      :class="{ '!border-danger': invalid }"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      @blur="editor.touch('event.termTeam')"
                    />
                  </template>
                </FormField>
                <FormField :id="fieldId('event.termMember')" label="成員的稱呼" required hint="預設「成員」，1–20 字。" :error="editor.errorFor('event.termMember')">
                  <template #default="{ describedby, invalid }">
                    <input
                      :id="fieldId('event.termMember')"
                      v-model="form.termMember"
                      type="text"
                      maxlength="20"
                      class="field-input"
                      :class="{ '!border-danger': invalid }"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      @blur="editor.touch('event.termMember')"
                    />
                  </template>
                </FormField>
              </div>
              <div class="rounded-lg bg-mist p-4">
                <p class="text-xs font-medium text-dim">前台文案會變成</p>
                <ul class="mt-2 flex flex-wrap gap-2">
                  <li v-for="s in termSentences" :key="s" class="chip">{{ s }}</li>
                </ul>
              </div>
            </section>

            <!-- ⑤ 角色字典 -->
            <section :id="sectionElementId('roles')" class="scroll-mt-24 space-y-4" aria-labelledby="h-roles">
              <div>
                <p class="eyebrow">⑤ 角色字典</p>
                <h2 id="h-roles" class="mt-1 text-xl font-bold outline-none" tabindex="-1">角色字典</h2>
                <p class="mt-1 text-sm text-dim">
                  參加者可以選的角色（例如「前端」「導讀人」）。已有人選用的角色只能停用、不能刪除。
                </p>
              </div>
              <DictionaryEditor
                v-model="form.roles"
                kind="role"
                path-prefix="roles"
                :error-for="editor.errorFor"
                @touch="editor.touch"
              />
            </section>

            <!-- ⑥ 技能字典 -->
            <section :id="sectionElementId('skills')" class="scroll-mt-24 space-y-4" aria-labelledby="h-skills">
              <div>
                <p class="eyebrow">⑥ 技能字典</p>
                <h2 id="h-skills" class="mt-1 text-xl font-bold outline-none" tabindex="-1">技能字典</h2>
                <p class="mt-1 text-sm text-dim">
                  技能可以填分類，前台會依分類分組並配色。新增時分類預設沿用上一列。
                </p>
              </div>
              <DictionaryEditor
                v-model="form.skills"
                kind="skill"
                path-prefix="skills"
                :error-for="editor.errorFor"
                @touch="editor.touch"
              />
            </section>

            <!-- ⑦ 自訂標籤與資料保存 -->
            <section :id="sectionElementId('tags')" class="scroll-mt-24 space-y-5" aria-labelledby="h-tags">
              <div>
                <p class="eyebrow">⑦ 自訂標籤與資料保存</p>
                <h2 id="h-tags" class="mt-1 text-xl font-bold outline-none" tabindex="-1">自訂標籤與資料保存</h2>
              </div>
              <div class="grid gap-5 sm:grid-cols-2">
                <FormField
                  :id="fieldId('event.maxCustomTags')"
                  label="每人可加自訂技能標籤數"
                  required
                  :hint="`0 表示關閉；最多 ${SCHEMA_LIMITS.maxCustomTags}。自訂標籤和自我介紹一起送審核。`"
                  :error="editor.errorFor('event.maxCustomTags')"
                >
                  <template #default="{ describedby, invalid }">
                    <input
                      :id="fieldId('event.maxCustomTags')"
                      :value="form.maxCustomTags ?? ''"
                      type="number"
                      inputmode="numeric"
                      min="0"
                      :max="SCHEMA_LIMITS.maxCustomTags"
                      step="1"
                      class="field-input font-mono"
                      :class="{ '!border-danger': invalid }"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      @input="form.maxCustomTags = numInput($event)"
                      @blur="editor.touch('event.maxCustomTags')"
                    />
                  </template>
                </FormField>
                <FormField
                  :id="fieldId('event.customTagMaxLength')"
                  label="每個標籤最長字數"
                  required
                  :hint="`1–${SCHEMA_LIMITS.maxCustomTagLength} 字。`"
                  :error="editor.errorFor('event.customTagMaxLength')"
                >
                  <template #default="{ describedby, invalid }">
                    <input
                      :id="fieldId('event.customTagMaxLength')"
                      :value="form.customTagMaxLength ?? ''"
                      type="number"
                      inputmode="numeric"
                      min="1"
                      :max="SCHEMA_LIMITS.maxCustomTagLength"
                      step="1"
                      class="field-input font-mono"
                      :class="{ '!border-danger': invalid }"
                      :aria-describedby="describedby"
                      :aria-invalid="invalid || undefined"
                      @input="form.customTagMaxLength = numInput($event)"
                      @blur="editor.touch('event.customTagMaxLength')"
                    />
                  </template>
                </FormField>
              </div>
              <FormField
                :id="fieldId('event.retentionDays')"
                label="資料保存天數"
                required
                class="sm:w-64"
                hint="活動結束後幾天自動刪除隊伍、參加資料與訊息（1–3650，預設 90）。"
                :error="editor.errorFor('event.retentionDays')"
              >
                <template #default="{ describedby, invalid }">
                  <input
                    :id="fieldId('event.retentionDays')"
                    :value="form.retentionDays ?? ''"
                    type="number"
                    inputmode="numeric"
                    min="1"
                    max="3650"
                    step="1"
                    class="field-input font-mono"
                    :class="{ '!border-danger': invalid }"
                    :aria-describedby="describedby"
                    :aria-invalid="invalid || undefined"
                    @input="form.retentionDays = numInput($event)"
                    @blur="editor.touch('event.retentionDays')"
                  />
                </template>
              </FormField>
            </section>

            <!-- ⑧ 狀態與發布 -->
            <section :id="sectionElementId('status')" class="scroll-mt-24 space-y-4" aria-labelledby="h-status">
              <div>
                <p class="eyebrow">⑧ 狀態與發布</p>
                <h2 id="h-status" class="mt-1 text-xl font-bold outline-none" tabindex="-1">狀態與發布</h2>
              </div>
              <div v-if="mode === 'create'" class="card p-5">
                <div class="flex items-center gap-3">
                  <EventStatusBadge status="draft" size="md" />
                  <p class="text-sm text-dim">建立後即為草稿，對外不可見。</p>
                </div>
                <p class="mt-3 text-sm">先按下方「建立活動」儲存；建立後回到這裡就能開放。</p>
              </div>
              <template v-else>
                <EventStatusCard
                  ref="statusCard"
                  :status="form.status"
                  :term-team="editor.termTeam.value"
                  :slug="editor.savedSlug.value"
                  :dirty="editor.dirty.value"
                  :busy="editor.statusBusy.value"
                  :error="editor.statusError.value"
                  :open-checklist="editor.openChecklist.value"
                  :stats="editor.stats.value"
                  :can-delete="canDelete"
                  @change="onStatusChange"
                  @delete="onDelete"
                />
                <div class="flex flex-wrap items-center gap-3">
                  <button type="button" class="btn btn-quiet" :disabled="exporting" @click="exportJson">
                    {{ exporting ? '匯出中⋯' : '匯出 JSON' }}
                  </button>
                  <p class="text-xs text-dim">與 <code class="font-mono">apps/api/seeds/events/*.json</code> 同格式，可直接用 <code class="font-mono">pnpm seed</code> 匯入。</p>
                  <p v-if="exportError" class="w-full text-sm text-danger" role="alert">{{ exportError }}</p>
                </div>
              </template>
            </section>
          </form>

          <!-- live preview (desktop) -->
          <aside class="hidden lg:sticky lg:top-20 lg:block" aria-label="即時預覽">
            <EventPreview :form="form" compact />
          </aside>
        </div>

        <!-- sticky action bar -->
        <div class="sticky bottom-0 z-20 -mx-4 mt-10 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur">
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              form="event-form"
              class="btn btn-primary"
              :disabled="!editor.dirty.value || editor.saving.value"
            >
              {{ editor.saving.value ? '儲存中⋯' : mode === 'create' ? '建立活動' : '儲存' }}
            </button>
            <button v-if="editor.dirty.value" type="button" class="btn btn-quiet" :disabled="editor.saving.value" @click="onDiscard">
              放棄變更
            </button>
            <p class="text-sm" :class="editor.dirty.value ? 'text-warn' : 'text-ok'" role="status" aria-live="polite">
              {{ saveStatusText }}
            </p>
            <span class="grow"></span>
            <button type="button" class="btn btn-quiet lg:hidden" :aria-expanded="previewOpen" @click="previewOpen = true">
              預覽前台顯示
            </button>
            <span
              v-if="mode === 'edit' && nextStatus && nextStatusLabel"
              class="inline-block"
              :title="editor.dirty.value ? '先儲存變更' : undefined"
            >
              <button
                type="button"
                class="btn"
                :class="nextStatus === 'archived' ? 'btn-danger' : 'btn-cta'"
                :disabled="editor.dirty.value || editor.statusBusy.value"
                @click="statusCard?.request(nextStatus)"
              >
                {{ nextStatusLabel }}
              </button>
            </span>
          </div>
        </div>

        <!-- preview drawer (narrow screens) -->
        <ModalShell
          :open="previewOpen"
          label="預覽前台顯示"
          panel-class="!max-w-none max-h-[85vh] self-end overflow-y-auto !p-4"
          @close="previewOpen = false"
        >
          <div class="flex items-center justify-between gap-3">
            <p class="font-bold">預覽前台顯示</p>
            <button type="button" class="btn btn-quiet text-sm" data-autofocus @click="previewOpen = false">關閉</button>
          </div>
          <EventPreview class="mt-3" :form="form" compact />
        </ModalShell>
      </template>
    </AdminGate>
  </div>
</template>
