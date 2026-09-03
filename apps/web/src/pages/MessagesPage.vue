<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { MessageView, ThreadView } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import { formatDateTime } from '../lib/format.js'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const threads = ref<ThreadView[]>([])
const messages = ref<MessageView[]>([])
const loadingThreads = ref(false)
const sendError = ref('')
const draftBody = ref('')
const sending = ref(false)

/** A conversation target that has no thread yet (came from a 傳訊息 button). */
const draftRecipient = computed(() => {
  const to = route.query.to as string | undefined
  if (!to) return null
  if (threads.value.some((t) => t.otherUserId === to)) return null
  return { userId: to, displayName: (route.query.name as string) ?? '對方' }
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

async function loadThreads() {
  const slug = eventStore.event?.slug
  if (!slug || !auth.token || !auth.isLoggedIn) return
  loadingThreads.value = true
  try {
    threads.value = (await api.listThreads(auth.token, slug)).threads
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 503)) console.error(err)
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
    messages.value = (await api.listMessages(auth.token, id)).messages
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      messages.value = []
    }
  }
}

// No websockets by design (spec §2.2) — plain polling while open.
let pollTimer: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  await eventStore.ensureLoaded()
  await loadThreads()
  await loadMessages()
  pollTimer = setInterval(() => void loadMessages(), 10_000)
})
onUnmounted(() => clearInterval(pollTimer))
watch(selectedThreadId, () => void loadMessages())
watch(
  () => auth.isLoggedIn,
  async () => {
    await loadThreads()
    await loadMessages()
  },
)

function openThread(thread: ThreadView) {
  void router.replace({ query: { thread: thread.id } })
}
function backToList() {
  void router.replace({ query: {} })
}

async function send() {
  const body = draftBody.value.trim()
  const slug = eventStore.event?.slug
  if (!body || !auth.token || !slug) return
  sending.value = true
  sendError.value = ''
  try {
    if (selectedThread.value) {
      await api.sendMessage(auth.token, selectedThread.value.id, body)
    } else if (draftRecipient.value) {
      const { thread } = await api.startThread(auth.token, slug, draftRecipient.value.userId, body)
      await loadThreads()
      await router.replace({ query: { thread: thread.id } })
    } else {
      return
    }
    draftBody.value = ''
    await loadMessages()
    await loadThreads()
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    sendError.value =
      code === 'not_allowed'
        ? '你們目前不在同一' + eventStore.termTeam + '，也沒有進行中的申請，無法傳訊息'
        : code === 'validation_failed'
          ? '訊息不可空白，最多 1000 字'
          : '傳送失敗，請稍後再試'
  } finally {
    sending.value = false
  }
}

const conversationTitle = computed(
  () => selectedThread.value?.otherDisplayName ?? draftRecipient.value?.displayName ?? '',
)

// ---- 檢舉 ----

const REPORT_REASON_OPTIONS = [
  { value: 'scam', label: '詐騙或釣魚' },
  { value: 'harassment', label: '騷擾或威脅' },
  { value: 'spam', label: '垃圾訊息' },
  { value: 'other', label: '其他不當內容' },
] as const

const reportTarget = ref<MessageView | null>(null)
const reportReason = ref<string>('scam')
const reporting = ref(false)
const reportError = ref('')
const reportDone = ref(false)

function openReport(m: MessageView) {
  reportTarget.value = m
  reportReason.value = 'scam'
  reportError.value = ''
  reportDone.value = false
}

function closeReport() {
  reportTarget.value = null
}

async function submitReport() {
  const target = reportTarget.value
  if (!target || !auth.token) return
  reporting.value = true
  reportError.value = ''
  try {
    await api.reportMessage(auth.token, target.id, reportReason.value)
    reportDone.value = true
    await loadMessages()
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    reportError.value =
      code === 'already_reported'
        ? '你已經檢舉過這則訊息了'
        : code === 'rate_limited'
          ? '檢舉太頻繁，請稍後再試'
          : '檢舉失敗，請稍後再試'
  } finally {
    reporting.value = false
  }
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
        <p v-if="loadingThreads" class="text-dim">載入中⋯</p>
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
        <header class="flex items-center gap-3 border-b border-line px-5 py-3">
          <button class="text-sm text-dim hover:text-ink md:hidden" @click="backToList">←</button>
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
              <p class="mt-1 flex items-center gap-2 font-mono text-[11px] text-dim">
                {{ formatDateTime(m.createdAt) }}
                <span v-if="m.mine && m.visibility === 'pending_review'" class="text-warn">審核中</span>
                <span v-if="m.mine && m.visibility === 'blocked'" class="text-danger">未通過</span>
                <span v-if="!m.mine && m.reportedByMe">已檢舉</span>
                <button
                  v-if="!m.mine && !m.reportedByMe && m.body"
                  type="button"
                  class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-danger"
                  @click="openReport(m)"
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

    <!-- 檢舉對話框 -->
    <div
      v-if="reportTarget"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-title"
      @click.self="closeReport"
    >
      <div class="card w-full max-w-md p-6">
        <template v-if="!reportDone">
          <h2 id="report-title" class="text-lg font-bold">檢舉這則訊息</h2>
          <p class="mt-1 text-sm text-dim">
            檢舉後訊息會先隱藏，並交由更嚴格的 AI 複審；必要時由管理員人工處理。
            需要留證據的話，<strong class="text-ink">請先截圖再送出檢舉</strong>。
          </p>
          <fieldset class="mt-4 space-y-2">
            <legend class="sr-only">檢舉原因</legend>
            <label
              v-for="opt in REPORT_REASON_OPTIONS"
              :key="opt.value"
              class="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input v-model="reportReason" type="radio" name="report-reason" :value="opt.value" />
              {{ opt.label }}
            </label>
          </fieldset>
          <div class="mt-4 rounded-lg bg-mist p-3 text-sm">
            <p class="font-medium">保護自己</p>
            <p class="mt-1 text-dim">
              懷疑遇到詐騙？先撥 <strong class="text-ink">165 反詐騙諮詢專線</strong> 查證。
              若對方威脅你的人身安全，請直接撥打 <strong class="text-ink">110</strong> 報警。
              檢舉前先截圖保留證據；訊息隱藏後平台仍保留原始紀錄，警方可依法調閱。
            </p>
          </div>
          <p v-if="reportError" class="mt-3 text-sm text-danger" role="alert">{{ reportError }}</p>
          <div class="mt-5 flex justify-end gap-2">
            <button type="button" class="btn" @click="closeReport">取消</button>
            <button type="button" class="btn btn-primary" :disabled="reporting" @click="submitReport">
              送出檢舉
            </button>
          </div>
        </template>
        <template v-else>
          <h2 id="report-title" class="text-lg font-bold">已收到你的檢舉</h2>
          <p class="mt-2 text-sm text-dim">
            這則訊息已隱藏並送交複審，結果會反映在對話中。謝謝你幫忙維護社群安全。
          </p>
          <p class="mt-2 text-sm text-dim">
            再次提醒：可疑訊息可撥 <strong class="text-ink">165</strong> 查證、
            人身安全疑慮請撥 <strong class="text-ink">110</strong>。
          </p>
          <div class="mt-5 flex justify-end">
            <button type="button" class="btn btn-primary" @click="closeReport">知道了</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
