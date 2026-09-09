<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { MessageView, ThreadView } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import { describeApiError } from '../lib/errors.js'
import { formatDateTime } from '../lib/format.js'
import ReportDialog from '../components/ReportDialog.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const threads = ref<ThreadView[]>([])
const messages = ref<MessageView[]>([])
const loadingThreads = ref(true)
const sendError = ref('')
const draftBody = ref('')
const sending = ref(false)

/**
 * Display name of a recipient who has no thread yet. Never taken from the
 * URL (anyone could type a name there); resolved from the team the link
 * came from (?team=<id>) — the recipient must be one of its members.
 */
const recipientName = ref<string | null>(null)
async function resolveRecipientName() {
  recipientName.value = null
  const to = route.query.to as string | undefined
  const teamId = route.query.team as string | undefined
  if (!to || !teamId || !auth.token) return
  try {
    const team = await api.getTeam(teamId, auth.getToken)
    recipientName.value = team.members.find((m) => m.userId === to)?.displayName ?? null
  } catch {
    recipientName.value = null
  }
}

/** A conversation target that has no thread yet (came from a 傳訊息 button). */
const draftRecipient = computed(() => {
  const to = route.query.to as string | undefined
  if (!to) return null
  if (threads.value.some((t) => t.otherUserId === to)) return null
  return { userId: to, displayName: recipientName.value ?? '對方' }
})

const selectedThreadId = computed(() => {
  const explicit = route.query.thread as string | undefined
  if (explicit) return explicit
  const to = route.query.to as string | undefined
  if (to) return threads.value.find((t) => t.otherUserId === to)?.id ?? null
  return null
})
const selectedThread = computed(
  () => threads.value.find((t) => t.id === selectedThreadId.value) ?? null,
)
const conversationOpen = computed(() => !!selectedThread.value || !!draftRecipient.value)

const loadError = ref('')

async function loadThreads() {
  const slug = eventStore.event?.slug
  if (!slug || !auth.token || !auth.isLoggedIn) {
    loadingThreads.value = false
    return
  }
  loadingThreads.value = true
  loadError.value = ''
  try {
    threads.value = (await api.listThreads(auth.getToken, slug)).threads
  } catch (err) {
    loadError.value = describeApiError(err, errorCtx(), '對話列表載入失敗，請重試')
  } finally {
    loadingThreads.value = false
  }
}

async function loadMessages() {
  const id = selectedThreadId.value
  if (!id || !auth.token) {
    messages.value = []
    return
  }
  try {
    messages.value = (await api.listMessages(auth.getToken, id)).messages
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      messages.value = []
    } else if (err instanceof ApiError && err.status === 401) {
      // Session gone — the shell shows the re-login banner; stop hammering the API.
      stopPolling()
    }
  }
}

// No websockets by design (spec §2.2) — plain polling while open.
let pollTimer: ReturnType<typeof setInterval> | undefined
function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => void loadMessages(), 10_000)
}
function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = undefined
}

onMounted(async () => {
  await eventStore.ensureLoaded()
  await Promise.all([loadThreads(), resolveRecipientName()])
  await loadMessages()
  if (auth.isLoggedIn) startPolling()
})
onUnmounted(stopPolling)
watch(selectedThreadId, () => void loadMessages())
watch(
  () => route.query.team,
  () => void resolveRecipientName(),
)
watch(
  () => auth.isLoggedIn,
  async (loggedIn) => {
    await Promise.all([loadThreads(), resolveRecipientName()])
    await loadMessages()
    if (loggedIn) startPolling()
    else stopPolling()
  },
)

function openThread(thread: ThreadView) {
  void router.replace({ query: { thread: thread.id } })
}
function backToList() {
  void router.replace({ query: {} })
}

const errorCtx = () => ({ termTeam: eventStore.termTeam, termMember: eventStore.termMember })

async function send() {
  const body = draftBody.value.trim()
  const slug = eventStore.event?.slug
  if (!body || !auth.token || !slug) return
  sending.value = true
  sendError.value = ''
  try {
    if (selectedThread.value) {
      await api.sendMessage(auth.getToken, selectedThread.value.id, body)
    } else if (draftRecipient.value) {
      const { thread } = await api.startThread(auth.getToken, slug, draftRecipient.value.userId, body)
      await loadThreads()
      await router.replace({ query: { thread: thread.id } })
    } else {
      return
    }
    draftBody.value = ''
    await loadMessages()
    await loadThreads()
  } catch (err) {
    sendError.value = describeApiError(err, errorCtx(), '傳送失敗，請稍後再試', {
      not_allowed: `你們目前不在同一${eventStore.termTeam}，也沒有進行中的申請，無法傳訊息`,
      validation_failed: '訊息不可空白，最多 1000 字',
    })
  } finally {
    sending.value = false
  }
}

const conversationTitle = computed(
  () => selectedThread.value?.otherDisplayName ?? draftRecipient.value?.displayName ?? '',
)

// ---- 檢舉（共用 ReportDialog）----
const reportTarget = ref<MessageView | null>(null)
async function submitReport(reason: string) {
  const target = reportTarget.value
  if (!target || !auth.token) return
  await api.reportMessage(auth.getToken, target.id, reason)
  await loadMessages()
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-black">站內訊息</h1>
    <p class="mt-1 text-sm text-dim">
      只有同{{ eventStore.termTeam }}或申請關係中的人可以互傳；訊息發布前會經過自動化風險檢測。
    </p>
    <p class="mt-1 text-sm text-dim">
      遇到可疑訊息除了檢舉，也請多加利用 <strong class="text-ink">165 反詐騙諮詢專線</strong>
      查證保護自己；若涉及人身安全，請直接撥打 <strong class="text-ink">110</strong> 報警。
    </p>

    <div v-if="!auth.isLoggedIn" class="card mt-6 p-8 text-center">
      <p>登入後就能查看你的對話。</p>
      <RouterLink to="/profile" class="btn btn-primary mt-4">前往登入</RouterLink>
    </div>

    <div v-else class="mt-6 grid gap-4 md:grid-cols-[280px_1fr]">
      <!-- thread list -->
      <aside :class="{ 'hidden md:block': conversationOpen }" aria-label="對話列表">
        <p v-if="loadingThreads" class="text-dim" aria-live="polite">載入中⋯</p>
        <div v-else-if="loadError" class="card p-4 text-sm" role="alert">
          <p class="text-danger">{{ loadError }}</p>
          <button type="button" class="btn btn-quiet mt-3 text-sm" @click="loadThreads">重試</button>
        </div>
        <ul v-else-if="threads.length || draftRecipient" class="space-y-2">
          <li v-if="draftRecipient" class="card border-primary bg-primary-mist p-4">
            <p class="font-medium">{{ draftRecipient.displayName }}</p>
            <p class="text-xs text-dim">新對話</p>
          </li>
          <li v-for="thread in threads" :key="thread.id">
            <button
              class="card w-full cursor-pointer p-4 text-left transition-colors duration-150 hover:border-primary"
              :class="{ '!border-primary bg-primary-mist': thread.id === selectedThreadId }"
              @click="openThread(thread)"
            >
              <p class="font-medium">{{ thread.otherDisplayName }}</p>
              <p class="mt-0.5 font-mono text-xs text-dim">
                {{ formatDateTime(thread.lastMessageAt) }}
              </p>
            </button>
          </li>
        </ul>
        <div v-else class="card p-6 text-sm text-dim">
          還沒有對話。到{{ eventStore.termTeam }}頁面或申請列表找「傳訊息」按鈕開始。
        </div>
      </aside>

      <!-- conversation -->
      <section
        v-if="conversationOpen"
        class="card flex min-h-[420px] flex-col"
        aria-label="對話內容"
      >
        <header class="flex items-center gap-2 border-b border-line px-4 py-2">
          <button
            type="button"
            class="btn btn-quiet h-11 w-11 !px-0 md:hidden"
            aria-label="回到對話列表"
            @click="backToList"
          >
            ←
          </button>
          <h2 class="font-bold">{{ conversationTitle }}</h2>
        </header>

        <div class="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <p v-if="messages.length === 0" class="text-sm text-dim">
            尚無訊息，說聲哈囉吧。
          </p>
          <div
            v-for="m in messages"
            :key="m.id"
            class="flex"
            :class="m.mine ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-[85%] rounded-xl px-4 py-2.5 text-sm"
              :class="m.mine ? 'bg-primary-mist' : 'bg-mist'"
            >
              <p v-if="m.body" class="whitespace-pre-line">{{ m.body }}</p>
              <p v-else-if="m.visibility === 'pending_review'" class="italic text-dim">
                （訊息審核中）
              </p>
              <p v-else class="italic text-dim">（訊息未通過審核）</p>
              <p
                v-if="m.mine && m.visibility === 'blocked'"
                class="mt-1 text-xs text-dim"
              >
                若認為誤判，請透過 GitHub Issues 或活動主辦單位聯繫。
              </p>
              <p class="mt-1 flex items-center gap-2 font-mono text-[11px] text-dim">
                {{ formatDateTime(m.createdAt) }}
                <span v-if="m.mine && m.visibility === 'pending_review'" class="text-warn">審核中</span>
                <span v-if="m.mine && m.visibility === 'blocked'" class="text-danger">未通過</span>
                <span v-if="!m.mine && m.reportedByMe">已檢舉</span>
                <button
                  v-if="!m.mine && !m.reportedByMe && m.body"
                  type="button"
                  class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-danger"
                  @click="reportTarget = m"
                >
                  檢舉
                </button>
              </p>
            </div>
          </div>
        </div>

        <footer class="border-t border-line px-5 py-3">
          <p v-if="sendError" class="mb-2 text-sm text-danger" role="alert">{{ sendError }}</p>
          <form class="flex items-end gap-2" @submit.prevent="send">
            <label class="sr-only" for="message-body">訊息內容</label>
            <textarea
              id="message-body"
              v-model="draftBody"
              class="field-input flex-1"
              rows="2"
              maxlength="1000"
              placeholder="輸入訊息⋯"
              @keydown.enter.exact.prevent="send"
            ></textarea>
            <button type="submit" class="btn btn-primary" :disabled="sending || !draftBody.trim()">
              送出
            </button>
          </form>
        </footer>
      </section>

      <section v-else class="card hidden items-center justify-center p-10 text-dim md:flex">
        選一個對話開始
      </section>
    </div>

    <ReportDialog
      :open="reportTarget !== null"
      title="檢舉這則訊息"
      description="檢舉後訊息會先隱藏，並交由更嚴格的 AI 複審；必要時由管理員人工處理。"
      done-description="這則訊息已隱藏並送交複審，結果會反映在對話中。"
      :submit="submitReport"
      @close="reportTarget = null"
    />
  </div>
</template>
