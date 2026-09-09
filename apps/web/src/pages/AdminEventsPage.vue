<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { AdminEventSummary, EventStatus, EventTemplate } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import AdminEventCard from '../components/admin/AdminEventCard.vue'
import AdminGate from '../components/admin/AdminGate.vue'
import EventStartOptions from '../components/admin/EventStartOptions.vue'
import LoadError from '../components/LoadError.vue'
import ModalShell from '../components/ModalShell.vue'
import { classifyLoadError, describeApiError, isReadOnlyMode, type LoadFailure } from '../lib/errors.js'
import {
  EVENT_DELETE_DIALOG,
  EVENT_STATUS_ORDER,
  statusChangeAnnouncement,
  statusDialogCopy,
  type ConfirmCopy,
} from '../lib/event-status.js'
import { downloadBlob } from '../lib/download.js'
import { useAuthStore } from '../stores/auth.js'

const auth = useAuthStore()
const router = useRouter()

const items = ref<AdminEventSummary[]>([])
const loading = ref(false)
const loadError = ref<LoadFailure | null>(null)
const forbidden = ref(false)
const showArchived = ref(false)
const feedback = ref('')
/** Polite confirmation after a lifecycle action ("「x」已停止招募"). */
const announcement = ref('')

const templates = ref<EventTemplate[] | null>(null)
const templatesError = ref<string | null>(null)
/** 503 from the API = seed read-only mode (no database), not an outage. */
const readOnly = ref(false)

const byStart = (a: AdminEventSummary, b: AdminEventSummary) =>
  Date.parse(a.startsAt) - Date.parse(b.startsAt)

/** open → draft → closed, each by start time; archived is folded separately. */
const visible = computed(() =>
  EVENT_STATUS_ORDER.filter((s) => s !== 'archived').flatMap((status) =>
    items.value.filter((e) => e.status === status).sort(byStart),
  ),
)
const archived = computed(() => items.value.filter((e) => e.status === 'archived').sort(byStart))

async function load() {
  if (!auth.me?.isAdmin) return
  loading.value = true
  loadError.value = null
  forbidden.value = false
  readOnly.value = false
  try {
    items.value = (await api.adminListEvents(auth.getToken)).items
    if (items.value.length === 0) void loadTemplates()
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 401)) forbidden.value = true
    else {
      readOnly.value = isReadOnlyMode(err)
      loadError.value = classifyLoadError(err)
    }
  } finally {
    loading.value = false
  }
}

async function loadTemplates() {
  templatesError.value = null
  try {
    templates.value = (await api.adminListEventTemplates(auth.getToken)).templates
  } catch (err) {
    templates.value = []
    templatesError.value = describeApiError(err, { termTeam: '隊伍' }, '範本載入失敗')
  }
}

onMounted(load)
watch(
  () => auth.me?.isAdmin,
  (isAdmin) => {
    if (isAdmin) void load()
  },
)

// ---- export ----
const exporting = ref<string | null>(null)
async function exportJson(e: AdminEventSummary) {
  exporting.value = e.slug
  feedback.value = ''
  try {
    const { blob, filename } = await api.adminExportEvent(auth.getToken, e.slug)
    downloadBlob(blob, filename ?? `${e.slug}.json`)
  } catch (err) {
    feedback.value = describeApiError(err, { termTeam: e.termTeam }, '匯出失敗，請稍後再試')
  } finally {
    exporting.value = null
  }
}

// ---- lifecycle actions (same copy as the editor's status card) ----
type PendingAction =
  | { kind: 'status'; event: AdminEventSummary; to: EventStatus }
  | { kind: 'delete'; event: AdminEventSummary }

const pending = ref<PendingAction | null>(null)
const actionBusy = ref(false)
const actionError = ref<string | null>(null)
/** Missing items from `cannot_open_incomplete`; null = nothing to show. */
const openChecklist = ref<string[] | null>(null)

const dialog = computed<ConfirmCopy | null>(() => {
  const p = pending.value
  if (!p) return null
  if (p.kind === 'delete') return EVENT_DELETE_DIALOG
  return statusDialogCopy(p.event.status, p.to, p.event.termTeam)
})
const blockedByChecklist = computed(
  () => pending.value?.kind === 'status' && pending.value.to === 'open' && (openChecklist.value?.length ?? 0) > 0,
)
/** The card whose request is in flight (disables just that card's buttons). */
const busySlug = computed(() => (actionBusy.value && pending.value ? pending.value.event.slug : null))

function requestStatus(event: AdminEventSummary, to: EventStatus) {
  actionError.value = null
  openChecklist.value = null
  pending.value = { kind: 'status', event, to }
}
function requestDelete(event: AdminEventSummary) {
  actionError.value = null
  openChecklist.value = null
  pending.value = { kind: 'delete', event }
}
function closeDialog() {
  if (actionBusy.value) return
  pending.value = null
  actionError.value = null
  openChecklist.value = null
}

async function confirmAction() {
  const p = pending.value
  if (!p || blockedByChecklist.value) return
  actionBusy.value = true
  actionError.value = null
  announcement.value = ''
  try {
    if (p.kind === 'delete') {
      await api.adminDeleteEvent(auth.getToken, p.event.slug)
      announcement.value = `「${p.event.name || p.event.slug}」已刪除`
    } else {
      await api.adminSetEventStatus(auth.getToken, p.event.slug, p.to)
      announcement.value = `「${p.event.name || p.event.slug}」${statusChangeAnnouncement(p.event.status, p.to)}`
    }
    pending.value = null
    await load()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'cannot_open_incomplete') {
      const details = Array.isArray(err.body.details) ? (err.body.details as string[]) : []
      openChecklist.value = details.length ? details : ['活動設定尚未完整']
    } else {
      actionError.value = describeApiError(err, { termTeam: p.event.termTeam }, '操作失敗，請稍後再試')
    }
  } finally {
    actionBusy.value = false
  }
}

function onChoose(start: { kind: 'template'; key: string } | { kind: 'copy'; slug: string } | { kind: 'blank' }) {
  const query: Record<string, string> = { start: start.kind }
  if (start.kind === 'template') query.key = start.key
  if (start.kind === 'copy') query.slug = start.slug
  void router.push({ name: 'admin-event-new', query })
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="eyebrow">後台</p>
        <h1 class="mt-1 text-2xl font-black">活動管理</h1>
        <p class="mt-1 text-sm text-dim">
          每場活動的規則、時程與角色／技能字典都在這裡設定；表單與 seed JSON 是同一份資料。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <RouterLink to="/admin" class="btn btn-quiet">回審核後台</RouterLink>
        <RouterLink :to="{ name: 'admin-event-new' }" class="btn btn-primary">建立活動</RouterLink>
      </div>
    </div>

    <AdminGate :forbidden="forbidden">
      <p v-if="feedback" class="mt-4 text-sm text-danger" role="alert">{{ feedback }}</p>
      <p v-if="announcement" class="mt-4 rounded-lg bg-ok-mist px-4 py-3 text-sm text-ok" role="status" aria-live="polite">
        {{ announcement }}
      </p>
      <p v-if="loading && items.length === 0" class="mt-6 text-dim">載入中⋯</p>

      <LoadError
        v-else-if="loadError"
        class="mt-6"
        :kind="loadError"
        :title="readOnly ? '目前為唯讀模式' : undefined"
        :hint="readOnly ? '此環境未連接資料庫，活動設定只能從 seed 檔載入，無法在後台檢視或修改。' : undefined"
        @retry="load"
      />

      <!-- empty state = the create page's content -->
      <section v-else-if="!loading && items.length === 0" class="mt-6" aria-labelledby="first-event-title">
        <div class="card p-6 sm:p-8">
          <p class="eyebrow">還沒有任何活動</p>
          <h2 id="first-event-title" class="mt-2 text-2xl font-black">建立第一場活動</h2>
          <p class="mt-2 max-w-xl text-dim">
            選一個起點就能開始。存成草稿後隨時能回來補，最後按「開放招募」才會出現在活動列表。
          </p>
          <EventStartOptions
            class="mt-6"
            :templates="templates"
            :templates-error="templatesError"
            :events="[]"
            @choose="onChoose"
          />
        </div>
      </section>

      <template v-else>
        <ul class="mt-6 space-y-3">
          <AdminEventCard
            v-for="e in visible"
            :key="e.slug"
            :event="e"
            :busy="busySlug === e.slug"
            :exporting="exporting === e.slug"
            @status="requestStatus(e, $event)"
            @delete="requestDelete(e)"
            @export="exportJson(e)"
          />
        </ul>

        <div v-if="archived.length" class="mt-6">
          <button
            type="button"
            class="btn btn-quiet text-sm"
            :aria-expanded="showArchived"
            aria-controls="archived-events"
            @click="showArchived = !showArchived"
          >
            {{ showArchived ? '隱藏已封存' : '顯示已封存' }}（{{ archived.length }}）
          </button>
          <ul v-if="showArchived" id="archived-events" class="mt-3 space-y-3">
            <AdminEventCard
              v-for="e in archived"
              :key="e.slug"
              :event="e"
              :busy="busySlug === e.slug"
              :exporting="exporting === e.slug"
              @status="requestStatus(e, $event)"
              @delete="requestDelete(e)"
              @export="exportJson(e)"
            />
          </ul>
        </div>
      </template>
    </AdminGate>

    <!-- one confirmation dialog for every lifecycle action -->
    <ModalShell :open="pending !== null && dialog !== null" labelledby="list-action-title" @close="closeDialog">
      <template v-if="pending && dialog">
        <h2 id="list-action-title" class="text-lg font-bold">{{ dialog.title }}</h2>
        <p class="mt-1 font-mono text-xs text-dim">{{ pending.event.name || pending.event.slug }}</p>
        <p class="mt-2 text-sm text-dim">{{ dialog.body }}</p>

        <div
          v-if="blockedByChecklist"
          class="mt-3 rounded-lg bg-danger-mist px-4 py-3 text-sm text-danger"
          role="alert"
        >
          <p class="font-medium">開放前還缺：</p>
          <ul class="mt-1 list-disc space-y-0.5 pl-5">
            <li v-for="(item, i) in openChecklist" :key="i">{{ item }}</li>
          </ul>
          <p class="mt-2">
            <RouterLink
              :to="{ name: 'admin-event-edit', params: { slug: pending.event.slug } }"
              class="underline underline-offset-2"
            >
              到編輯器補齊
            </RouterLink>
            後再開放。
          </p>
        </div>
        <p v-else-if="actionError" class="mt-3 rounded-lg bg-danger-mist px-4 py-3 text-sm text-danger" role="alert">
          {{ actionError }}
        </p>

        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" class="btn btn-quiet" data-autofocus :disabled="actionBusy" @click="closeDialog">
            取消
          </button>
          <button
            type="button"
            class="btn"
            :class="dialog.danger ? 'btn-danger' : 'btn-primary'"
            :disabled="actionBusy || blockedByChecklist"
            @click="confirmAction"
          >
            {{ actionBusy ? '處理中⋯' : dialog.confirm }}
          </button>
        </div>
      </template>
    </ModalShell>
  </div>
</template>
