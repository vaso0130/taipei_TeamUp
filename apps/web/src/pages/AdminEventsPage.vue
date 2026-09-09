<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { AdminEventSummary, EventTemplate } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import AdminGate from '../components/admin/AdminGate.vue'
import EventStartOptions from '../components/admin/EventStartOptions.vue'
import EventStatusBadge from '../components/admin/EventStatusBadge.vue'
import LoadError from '../components/LoadError.vue'
import { classifyLoadError, describeApiError, isReadOnlyMode, type LoadFailure } from '../lib/errors.js'
import { EVENT_STATUS_BAR, EVENT_STATUS_ORDER } from '../lib/event-status.js'
import { formatDate, formatDateTime } from '../lib/format.js'
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
            選一個起點就能開始。存成草稿後隨時能回來補，最後按「開放」才會出現在首頁。
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
          <li v-for="e in visible" :key="e.slug" class="card overflow-hidden">
            <div class="h-1.5" :style="{ backgroundColor: EVENT_STATUS_BAR[e.status] }" aria-hidden="true"></div>
            <div class="p-5">
              <div class="flex flex-wrap items-center gap-2">
                <EventStatusBadge :status="e.status" />
                <h2 class="text-lg font-bold">{{ e.name || '未命名活動' }}</h2>
              </div>
              <p class="mt-1 font-mono text-xs text-dim">{{ e.slug }}</p>

              <dl class="mt-4 grid gap-x-8 gap-y-3 font-mono text-sm sm:grid-cols-3">
                <div>
                  <dt class="text-xs text-dim">活動日期</dt>
                  <dd class="mt-0.5 font-semibold">{{ formatDate(e.startsAt) }} – {{ formatDate(e.endsAt) }}</dd>
                </div>
                <div>
                  <dt class="text-xs text-dim">招募截止</dt>
                  <dd class="mt-0.5 font-semibold">{{ formatDateTime(e.recruitClosesAt) }}</dd>
                </div>
                <div>
                  <dt class="text-xs text-dim">規模</dt>
                  <dd class="mt-0.5 font-semibold">
                    {{ e.termTeam }} {{ e.counts.teams }}・參加者 {{ e.counts.participants }}
                  </dd>
                </div>
              </dl>

              <div class="mt-4 flex flex-wrap gap-2">
                <RouterLink
                  :to="{ name: 'admin-event-edit', params: { slug: e.slug } }"
                  class="btn btn-primary"
                >
                  編輯
                </RouterLink>
                <RouterLink
                  :to="{ name: 'admin-event-new', query: { start: 'copy', slug: e.slug } }"
                  class="btn btn-quiet"
                >
                  複製為新活動
                </RouterLink>
                <button
                  type="button"
                  class="btn btn-quiet"
                  :disabled="exporting === e.slug"
                  @click="exportJson(e)"
                >
                  {{ exporting === e.slug ? '匯出中⋯' : '匯出 JSON' }}
                </button>
              </div>
            </div>
          </li>
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
            <li v-for="e in archived" :key="e.slug" class="card overflow-hidden opacity-80">
              <div class="h-1.5" :style="{ backgroundColor: EVENT_STATUS_BAR[e.status] }" aria-hidden="true"></div>
              <div class="p-5">
                <div class="flex flex-wrap items-center gap-2">
                  <EventStatusBadge :status="e.status" />
                  <h2 class="text-lg font-bold">{{ e.name }}</h2>
                </div>
                <p class="mt-1 font-mono text-xs text-dim">{{ e.slug }}</p>
                <p class="mt-3 font-mono text-sm text-dim">
                  {{ formatDate(e.startsAt) }} – {{ formatDate(e.endsAt) }}・{{ e.termTeam }} {{ e.counts.teams }}・參加者 {{ e.counts.participants }}
                </p>
                <div class="mt-4 flex flex-wrap gap-2">
                  <RouterLink :to="{ name: 'admin-event-edit', params: { slug: e.slug } }" class="btn btn-quiet">
                    檢視
                  </RouterLink>
                  <RouterLink
                    :to="{ name: 'admin-event-new', query: { start: 'copy', slug: e.slug } }"
                    class="btn btn-quiet"
                  >
                    複製為新活動
                  </RouterLink>
                  <button type="button" class="btn btn-quiet" :disabled="exporting === e.slug" @click="exportJson(e)">
                    {{ exporting === e.slug ? '匯出中⋯' : '匯出 JSON' }}
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </template>
    </AdminGate>
  </div>
</template>
