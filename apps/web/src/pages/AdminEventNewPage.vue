<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { AdminEventSummary, EventTemplate } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import AdminGate from '../components/admin/AdminGate.vue'
import EventStartOptions from '../components/admin/EventStartOptions.vue'
import type { EditorStart } from '../composables/useEventEditor.js'
import { describeApiError } from '../lib/errors.js'
import { useAuthStore } from '../stores/auth.js'
import AdminEventEditorPage from './AdminEventEditorPage.vue'

/**
 * `/admin/events/new`: pick a starting point (template / copy / blank),
 * then the same editor as `/admin/events/:slug` opens in create mode with
 * the choice carried in the query string — so a reload keeps the start.
 */
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const start = computed<EditorStart | null>(() => {
  const kind = route.query.start
  if (kind === 'blank') return { kind: 'blank' }
  if (kind === 'template' && typeof route.query.key === 'string') return { kind: 'template', key: route.query.key }
  if (kind === 'copy' && typeof route.query.slug === 'string') return { kind: 'copy', slug: route.query.slug }
  return null
})

const templates = ref<EventTemplate[] | null>(null)
const templatesError = ref<string | null>(null)
const events = ref<AdminEventSummary[]>([])
const forbidden = ref(false)

async function load() {
  if (!auth.me?.isAdmin || start.value) return
  forbidden.value = false
  const [t, e] = await Promise.allSettled([
    api.adminListEventTemplates(auth.getToken),
    api.adminListEvents(auth.getToken),
  ])
  if (t.status === 'fulfilled') templates.value = t.value.templates
  else {
    templates.value = []
    templatesError.value = describeApiError(t.reason, { termTeam: '隊伍' }, '範本載入失敗')
    if (t.reason instanceof ApiError && t.reason.status === 403) forbidden.value = true
  }
  if (e.status === 'fulfilled') events.value = e.value.items
}

onMounted(load)
watch(
  () => auth.me?.isAdmin,
  (isAdmin) => {
    if (isAdmin) void load()
  },
)
watch(start, (s) => {
  if (!s) void load()
})

function onChoose(chosen: EditorStart) {
  const query: Record<string, string> = { start: chosen.kind }
  if (chosen.kind === 'template') query.key = chosen.key
  if (chosen.kind === 'copy') query.slug = chosen.slug
  void router.push({ name: 'admin-event-new', query })
}
</script>

<template>
  <AdminEventEditorPage v-if="start" mode="create" :start="start" />
  <div v-else>
    <RouterLink
      :to="{ name: 'admin-events' }"
      class="inline-flex min-h-[44px] items-center gap-1 text-sm text-dim hover:text-ink"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      返回活動列表
    </RouterLink>
    <p class="eyebrow mt-2">建立活動</p>
    <h1 class="mt-1 text-2xl font-black">先選一個起點</h1>
    <p class="mt-1 max-w-xl text-sm text-dim">
      選了就進編輯器並預填；之後每個欄位都能改。存成草稿前不會對外顯示。
    </p>

    <AdminGate :forbidden="forbidden">
      <EventStartOptions
        class="mt-6"
        :templates="templates"
        :templates-error="templatesError"
        :events="events"
        @choose="onChoose"
      />
    </AdminGate>
  </div>
</template>
