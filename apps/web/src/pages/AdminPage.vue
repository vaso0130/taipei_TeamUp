<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type {
  AdminStats,
  AdminTeamItem,
  AdminThreadDetail,
  AdminUserItem,
  PendingModerationItem,
  RiskMessageItem,
  UserModerationHistory,
} from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import EmptyState from '../components/EmptyState.vue'
import ModalShell from '../components/ModalShell.vue'
import { formatDateTime } from '../lib/format.js'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const auth = useAuthStore()
const eventStore = useEventStore()

const tab = ref<'stats' | 'users' | 'teams' | 'pending' | 'risk'>('stats')
const items = ref<PendingModerationItem[]>([])
const riskItems = ref<RiskMessageItem[]>([])
const stats = ref<AdminStats | null>(null)
const users = ref<AdminUserItem[]>([])
const teams = ref<AdminTeamItem[]>([])
const userSearch = ref('')
const showProcessedRisk = ref(false)

const filteredUsers = computed(() => {
  const q = userSearch.value.trim().toLowerCase()
  if (!q) return users.value
  return users.value.filter(
    (u) => u.displayName.toLowerCase().includes(q) || (u.teamName ?? '').toLowerCase().includes(q),
  )
})

/** Handled = a human already made the call; hidden by default. */
const visibleRiskItems = computed(() =>
  showProcessedRisk.value
    ? riskItems.value
    : riskItems.value.filter((item) => !item.decidedBy.startsWith('human')),
)
const unprocessedRiskCount = computed(
  () => riskItems.value.filter((item) => !item.decidedBy.startsWith('human')).length,
)

const TABS = computed(() => [
  { key: 'stats' as const, label: '平台總覽' },
  { key: 'users' as const, label: `帳號（${users.value.length}）` },
  { key: 'teams' as const, label: `${eventStore.termTeam}（${teams.value.length}）` },
  { key: 'pending' as const, label: `待人工審核（${items.value.length}）` },
  { key: 'risk' as const, label: `風險訊息（${unprocessedRiskCount.value}）` },
])

const USER_STATUS_LABEL: Record<string, string> = {
  active: '正常',
  suspended: '已停權',
  deleted: '已刪除',
}

// Event vocabulary (termTeam) is data, so these labels are computed.
const INTENT_LABEL = computed<Record<string, string>>(() => ({
  looking_for_team: `找${eventStore.termTeam}中`,
  has_team: `已有${eventStore.termTeam}`,
  browsing: '先看看',
}))
const TEAM_STATUS_LABEL: Record<string, string> = {
  recruiting: '招募中',
  full: '已滿編',
  closed: '已關閉',
}
const loading = ref(true)
const forbidden = ref(false)
const feedback = ref('')

const TYPE_LABEL = computed<Record<string, string>>(() => ({
  participant_blurb: '自我介紹',
  team_pitch: `${eventStore.termTeam}簡介`,
  application_message: '申請/邀請附言',
  message: '站內訊息',
}))

const RISK_LABEL: Record<string, string> = { low: '低', medium: '中', high: '高' }
const RISK_CLASS: Record<string, string> = {
  low: 'bg-ok-mist text-ok',
  medium: 'bg-warn-mist text-warn',
  high: 'bg-danger-mist text-danger',
}
const REASON_LABEL: Record<string, string> = {
  scam: '詐騙/釣魚',
  harassment: '騷擾',
  spam: '垃圾訊息',
  other: '其他',
}

async function load() {
  if (!auth.token) {
    loading.value = false
    return
  }
  loading.value = true
  forbidden.value = false
  try {
    const slug = eventStore.event?.slug
    const [pending, risk, overview, roster, teamList] = await Promise.all([
      api.adminListPending(auth.getToken),
      api.adminListRisk(auth.getToken),
      slug ? api.adminStats(auth.getToken, slug) : Promise.resolve(null),
      slug ? api.adminListUsers(auth.getToken, slug) : Promise.resolve({ items: [] }),
      slug ? api.adminListTeams(auth.getToken, slug) : Promise.resolve({ items: [] }),
    ])
    items.value = pending.items
    riskItems.value = risk.items
    stats.value = overview
    users.value = roster.items
    teams.value = teamList.items
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
      forbidden.value = true
    } else {
      console.error(err)
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await eventStore.ensureLoaded()
  await load()
})
// On a hard reload the Firebase session is restored after mount; without
// this the dashboard would sit on empty counters until "重新整理".
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) void load()
  },
)

async function decide(item: PendingModerationItem, action: 'approve' | 'block') {
  if (!auth.token) return
  feedback.value = ''
  try {
    await api.adminDecide(auth.getToken, { target: item.target, action })
    await load()
  } catch {
    feedback.value = '操作失敗，請稍後再試'
  }
}

// ---- thread review panel ----
const openThread = ref<AdminThreadDetail | null>(null)
const threadLoading = ref(false)
async function reviewThread(threadId: string) {
  if (!auth.token) return
  threadLoading.value = true
  history.value = null
  try {
    openThread.value = await api.adminGetThread(auth.getToken, threadId)
  } catch {
    feedback.value = '載入對話失敗'
  } finally {
    threadLoading.value = false
  }
}

async function decideMessage(messageId: string, action: 'approve' | 'block') {
  if (!auth.token || !openThread.value) return
  feedback.value = ''
  try {
    await api.adminDecide(auth.getToken, {
      target: { type: 'message', messageId },
      action,
    })
    await reviewThread(openThread.value.id)
    await load()
  } catch {
    feedback.value = '操作失敗，請稍後再試'
  }
}

// ---- user strike history panel ----
const history = ref<UserModerationHistory | null>(null)
async function showHistory(userId: string) {
  if (!auth.token) return
  try {
    history.value = await api.adminUserModeration(auth.getToken, userId)
  } catch {
    feedback.value = '載入違規紀錄失敗'
  }
}

const reactivating = ref(false)
async function reactivate(userId: string) {
  if (!auth.token) return
  if (!window.confirm('確定解除這個帳號的停權嗎？（會同時重設本期的違規計數）')) return
  reactivating.value = true
  feedback.value = ''
  try {
    await api.adminReactivate(auth.getToken, userId)
    if (openThread.value) await reviewThread(openThread.value.id)
    if (history.value?.userId === userId) await showHistory(userId)
    await load()
  } catch {
    feedback.value = '解除停權失敗，請稍後再試'
  } finally {
    reactivating.value = false
  }
}

async function suspend(userId: string, displayName: string) {
  if (!auth.token) return
  if (!window.confirm(`確定停權「${displayName}」嗎？對方將無法登入使用平台。`)) return
  reactivating.value = true
  feedback.value = ''
  try {
    await api.adminSuspend(auth.getToken, userId)
    if (history.value?.userId === userId) await showHistory(userId)
    await load()
  } catch (err) {
    feedback.value =
      err instanceof ApiError && err.status === 403
        ? '無法停權管理員帳號'
        : '停權失敗，請稍後再試'
  } finally {
    reactivating.value = false
  }
}

async function disbandTeam(team: AdminTeamItem) {
  if (!auth.token) return
  if (
    !window.confirm(
      `確定強制解散「${team.name}」嗎？（${team.memberCount} 名${eventStore.termMember}將被移出，無法復原）`,
    )
  )
    return
  feedback.value = ''
  try {
    await api.adminDeleteTeam(auth.getToken, team.id)
    await load()
  } catch {
    feedback.value = '解散失敗，請稍後再試'
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-black">內容審核後台</h1>
    <p class="mt-1 text-sm text-dim">
      中高風險與被檢舉的內容才會出現在這裡；每次閱覽對話內容都會留下稽核紀錄。
    </p>

    <div v-if="!auth.isLoggedIn || forbidden" class="card mt-6 p-8 text-center">
      <p>此頁面僅限管理員使用。</p>
      <RouterLink to="/" class="btn btn-quiet mt-4">回首頁</RouterLink>
    </div>

    <template v-else>
      <div class="mt-5 flex flex-wrap items-center gap-2" role="tablist">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="btn text-sm"
          :class="tab === t.key ? 'btn-primary' : 'btn-quiet'"
          role="tab"
          :aria-selected="tab === t.key"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
        <button class="btn btn-quiet text-sm" :disabled="loading" @click="load">
          重新整理
        </button>
      </div>

      <p v-if="feedback" class="mt-4 text-sm text-danger" role="alert">{{ feedback }}</p>
      <p v-if="loading" class="mt-6 text-dim">載入中⋯</p>

      <!-- 平台總覽 -->
      <template v-if="tab === 'stats'">
        <div v-if="stats" class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div class="card p-5">
            <p class="text-sm text-dim">註冊帳號</p>
            <p class="mt-1 text-3xl font-black">{{ stats.users.active }}</p>
            <p class="mt-1 text-xs text-dim">
              停權 {{ stats.users.suspended }}・已刪除 {{ stats.users.deleted }}
            </p>
          </div>
          <div class="card p-5">
            <p class="text-sm text-dim">本活動參加者</p>
            <p class="mt-1 text-3xl font-black">{{ stats.participants.total }}</p>
            <p class="mt-1 text-xs text-dim">
              <template v-for="(n, intent, i) in stats.participants.byIntent" :key="intent">
                <span v-if="i > 0">・</span>{{ INTENT_LABEL[intent] ?? intent }} {{ n }}
              </template>
              <span v-if="stats.registeredWithoutParticipation > 0">
                ・註冊未參加 {{ stats.registeredWithoutParticipation }}
              </span>
            </p>
          </div>
          <div class="card p-5">
            <p class="text-sm text-dim">{{ eventStore.termTeam }}</p>
            <p class="mt-1 text-3xl font-black">{{ stats.teams.total }}</p>
            <p class="mt-1 text-xs text-dim">
              <template v-for="(n, status, i) in stats.teams.byStatus" :key="status">
                <span v-if="i > 0">・</span>{{ TEAM_STATUS_LABEL[status] ?? status }} {{ n }}
              </template>
              ・已加入{{ eventStore.termTeam }} {{ stats.teams.membersInTeams }} 人
            </p>
          </div>
          <div class="card p-5">
            <p class="text-sm text-dim">站內訊息</p>
            <p class="mt-1 text-3xl font-black">{{ stats.messages.total }}</p>
            <p class="mt-1 text-xs text-dim">累計則數</p>
          </div>
        </div>
        <p v-else-if="!loading" class="mt-6 text-dim">尚無統計資料。</p>
      </template>

      <!-- 帳號名單（僅中繼資料：不含 Email 與任何內容） -->
      <template v-else-if="tab === 'users'">
        <div class="mt-4 flex flex-wrap items-center gap-3">
          <input
            v-model="userSearch"
            type="search"
            class="field-input w-full max-w-xs text-sm"
            :placeholder="`搜尋暱稱或${eventStore.termTeam}名稱`"
            aria-label="搜尋帳號"
          />
          <p class="text-xs text-dim">此名單只含暱稱與狀態，不含 Email 或任何內容。</p>
        </div>
        <ul v-if="filteredUsers.length" class="mt-4 space-y-2">
          <li
            v-for="u in filteredUsers"
            :key="u.userId"
            class="card flex flex-wrap items-center gap-x-3 gap-y-2 p-4"
          >
            <button
              class="cursor-pointer font-medium underline decoration-dotted underline-offset-2"
              @click="showHistory(u.userId)"
            >
              {{ u.displayName }}
            </button>
            <span
              class="rounded-full px-2.5 py-0.5 text-xs"
              :class="u.status === 'suspended' ? 'bg-danger-mist text-danger' : 'bg-ok-mist text-ok'"
            >
              {{ USER_STATUS_LABEL[u.status] ?? u.status }}
            </span>
            <span class="text-sm text-dim">{{ u.intent ? (INTENT_LABEL[u.intent] ?? u.intent) : '未參加本活動' }}</span>
            <RouterLink
              v-if="u.teamId"
              :to="`/teams/${u.teamId}`"
              class="text-sm underline decoration-dotted underline-offset-2"
            >
              {{ u.teamName }}
            </RouterLink>
            <span v-if="u.highCount > 0" class="rounded-full bg-danger-mist px-2 py-0.5 text-xs text-danger">
              高風險 ×{{ u.highCount }}
            </span>
            <span v-if="u.mediumCount > 0" class="rounded-full bg-warn-mist px-2 py-0.5 text-xs text-warn">
              中風險 ×{{ u.mediumCount }}
            </span>
            <span v-if="u.createdAt" class="font-mono text-[11px] text-dim">
              {{ formatDateTime(u.createdAt) }} 加入
            </span>
            <span class="grow"></span>
            <button
              v-if="u.status === 'active'"
              class="btn btn-danger !min-h-[32px] text-xs"
              :disabled="reactivating"
              @click="suspend(u.userId, u.displayName)"
            >
              停權
            </button>
            <button
              v-else-if="u.status === 'suspended'"
              class="btn btn-primary !min-h-[32px] text-xs"
              :disabled="reactivating"
              @click="reactivate(u.userId)"
            >
              解除停權
            </button>
          </li>
        </ul>
        <EmptyState v-else-if="!loading" class="mt-6" title="沒有符合的帳號" hint="換個關鍵字試試。" />
      </template>

      <!-- termTeam 名單 -->
      <template v-else-if="tab === 'teams'">
        <ul v-if="teams.length" class="mt-6 space-y-2">
          <li
            v-for="t in teams"
            :key="t.id"
            class="card flex flex-wrap items-center gap-x-3 gap-y-2 p-4"
          >
            <RouterLink :to="`/teams/${t.id}`" class="font-medium underline decoration-dotted underline-offset-2">
              {{ t.name }}
            </RouterLink>
            <span class="rounded-full bg-mist px-2.5 py-0.5 text-xs text-dim">
              {{ TEAM_STATUS_LABEL[t.status] ?? t.status }}
            </span>
            <span class="text-sm text-dim">{{ t.memberCount }} 名{{ eventStore.termMember }}</span>
            <span class="text-sm text-dim">
              發起人：
              <button
                class="cursor-pointer underline decoration-dotted underline-offset-2"
                @click="showHistory(t.ownerUserId)"
              >
                {{ t.ownerDisplayName }}
              </button>
            </span>
            <span class="font-mono text-[11px] text-dim">{{ formatDateTime(t.createdAt) }}</span>
            <span class="grow"></span>
            <button class="btn btn-danger !min-h-[32px] text-xs" @click="disbandTeam(t)">
              強制解散
            </button>
          </li>
        </ul>
        <EmptyState v-else-if="!loading" class="mt-6" :title="`還沒有任何${eventStore.termTeam}`" hint="等大家開團吧。" />
      </template>

      <!-- 待審佇列 -->
      <template v-else-if="tab === 'pending'">
        <ul v-if="items.length" class="mt-6 space-y-4">
          <li v-for="(item, i) in items" :key="i" class="card p-5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded-full bg-mist px-2.5 py-0.5 text-xs text-dim">
                {{ TYPE_LABEL[item.target.type] ?? item.target.type }}
              </span>
              <span class="text-sm text-dim">作者：{{ item.authorDisplayName }}</span>
              <template v-if="item.verdict">
                <span class="rounded-full px-2.5 py-0.5 text-xs" :class="RISK_CLASS[item.verdict.riskLevel]">
                  AI 判定：{{ RISK_LABEL[item.verdict.riskLevel] }}
                </span>
                <span class="text-xs text-dim">{{ item.verdict.rationale || '（無理由）' }}</span>
                <span class="font-mono text-[11px] text-dim">{{ formatDateTime(item.verdict.decidedAt) }}</span>
              </template>
              <span v-else class="text-xs text-dim">（等待自動審核結果）</span>
            </div>
            <p class="mt-3 whitespace-pre-line rounded-lg bg-mist p-4 text-sm">{{ item.content }}</p>
            <div class="mt-4 flex gap-2">
              <button class="btn btn-primary text-sm" @click="decide(item, 'approve')">
                放行
              </button>
              <button class="btn btn-danger text-sm" @click="decide(item, 'block')">
                擋下
              </button>
              <button
                v-if="item.threadId"
                class="btn btn-quiet text-sm"
                @click="reviewThread(item.threadId)"
              >
                檢視對話
              </button>
            </div>
          </li>
        </ul>
        <EmptyState v-else-if="!loading" class="mt-6" title="沒有等待人工審核的內容" hint="佇列是空的，太平盛世。" />
      </template>

      <!-- 風險訊息總覽 -->
      <template v-else>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm text-dim">
            包含：自動判為中/高風險、被使用者檢舉、以及「已放行但帶風險訊號」的抽查項目。點「檢視對話」看完整脈絡。
          </p>
          <label class="flex cursor-pointer items-center gap-1.5 text-sm text-dim">
            <input v-model="showProcessedRisk" type="checkbox" />
            顯示已人工處理（{{ riskItems.length - unprocessedRiskCount }}）
          </label>
        </div>
        <ul v-if="visibleRiskItems.length" class="mt-4 space-y-3">
          <li v-for="item in visibleRiskItems" :key="item.messageId" class="card p-4">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="rounded-full px-2.5 py-0.5" :class="RISK_CLASS[item.riskLevel]">
                風險：{{ RISK_LABEL[item.riskLevel] }}
              </span>
              <span v-if="item.flagged" class="rounded-full bg-warn-mist px-2.5 py-0.5 text-warn">
                已放行・待抽查
              </span>
              <span v-if="item.reportCount > 0" class="rounded-full bg-danger-mist px-2.5 py-0.5 text-danger">
                被檢舉 ×{{ item.reportCount }}（{{ item.reportReasons.map((r) => REASON_LABEL[r] ?? r).join('、') }}）
              </span>
              <span class="text-dim">{{ item.decidedBy === 'auto' ? item.modelId : '人工判定' }}</span>
            </div>
            <p class="mt-2 text-sm">
              寄件者：
              <button class="cursor-pointer underline decoration-dotted underline-offset-2" @click="showHistory(item.senderId)">
                {{ item.senderDisplayName }}
              </button>
              <span class="ml-2 text-dim">{{ item.rationale || '（無理由）' }}</span>
            </p>
            <p class="mt-1 font-mono text-[11px] text-dim">{{ formatDateTime(item.decidedAt) }}</p>
            <button class="btn btn-quiet mt-3 text-sm" @click="reviewThread(item.threadId)">
              檢視對話
            </button>
          </li>
        </ul>
        <EmptyState v-else-if="!loading" class="mt-6" title="目前沒有風險訊息" hint="沒有中高風險、檢舉或待抽查的訊息。" />
      </template>

      <!-- 對話檢視 -->
      <ModalShell
        :open="!!openThread || threadLoading"
        labelledby="admin-thread-title"
        panel-class="max-h-[85vh] max-w-2xl overflow-y-auto"
        @close="openThread = null"
      >
        <p v-if="threadLoading" id="admin-thread-title" class="text-dim">載入中⋯</p>
        <template v-else-if="openThread">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 id="admin-thread-title" class="text-lg font-bold">對話檢視</h2>
              <p class="mt-1 text-sm text-dim">
                <template v-for="(p, i) in openThread.participants" :key="p.userId">
                  <button class="cursor-pointer underline decoration-dotted underline-offset-2" @click="showHistory(p.userId)">
                    {{ p.displayName }}
                  </button>
                  <span v-if="p.status !== 'active'">（{{ p.status === 'suspended' ? '已停權' : '已刪除' }}）</span>
                  <span v-if="i === 0"> ↔ </span>
                </template>
                ・此次閱覽已記入稽核
              </p>
            </div>
            <button class="btn btn-quiet text-sm" data-autofocus @click="openThread = null">
              關閉
            </button>
          </div>

          <ul class="mt-4 space-y-3">
            <li v-for="m in openThread.messages" :key="m.id" class="rounded-lg border border-line p-3">
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <span class="font-medium">{{ m.senderDisplayName }}</span>
                <span class="font-mono text-dim">{{ formatDateTime(m.createdAt) }}</span>
                <span v-if="m.riskLevel" class="rounded-full px-2 py-0.5" :class="RISK_CLASS[m.riskLevel]">
                  {{ RISK_LABEL[m.riskLevel] }}
                </span>
                <span v-if="m.flagged" class="text-warn">待抽查</span>
                <span v-if="m.reportCount > 0" class="text-danger">被檢舉 ×{{ m.reportCount }}</span>
                <span v-if="m.visibility !== 'published'" class="text-dim">
                  （{{ m.visibility === 'blocked' ? '已封鎖' : '審核中' }}）
                </span>
              </div>
              <p class="mt-2 whitespace-pre-line text-sm">{{ m.body }}</p>
              <div v-if="m.flagged || m.visibility !== 'published' || m.reportCount > 0" class="mt-2 flex gap-2">
                <button class="btn btn-primary !min-h-[32px] text-xs" @click="decideMessage(m.id, 'approve')">
                  放行
                </button>
                <button class="btn btn-danger !min-h-[32px] text-xs" @click="decideMessage(m.id, 'block')">
                  擋下
                </button>
              </div>
            </li>
          </ul>
        </template>
      </ModalShell>

      <!-- 使用者違規紀錄（可從風險列表或對話檢視開啟，浮在最上層） -->
      <ModalShell
        :open="!!history"
        label="使用者審核紀錄"
        panel-class="max-h-[75vh] max-w-lg overflow-y-auto"
        :z-index="60"
        @close="history = null"
      >
        <template v-if="history">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="font-bold">
              {{ history.displayName }}
              <span class="ml-1 text-sm font-normal" :class="history.status === 'suspended' ? 'text-danger' : 'text-dim'">
                （{{ history.status === 'active' ? '正常' : history.status === 'suspended' ? '已停權' : '已刪除' }}）
              </span>
            </p>
            <div class="flex gap-2">
              <button
                v-if="history.status === 'suspended'"
                class="btn btn-primary text-sm"
                :disabled="reactivating"
                @click="reactivate(history.userId)"
              >
                解除停權
              </button>
              <button
                v-else-if="history.status === 'active'"
                class="btn btn-danger text-sm"
                :disabled="reactivating"
                @click="suspend(history.userId, history.displayName)"
              >
                停權
              </button>
              <button class="btn btn-quiet text-sm" data-autofocus @click="history = null">
                關閉
              </button>
            </div>
          </div>
          <ul v-if="history.records.length" class="mt-4 space-y-2 text-sm">
            <li v-for="(r, i) in history.records" :key="i" class="rounded-lg bg-mist px-3 py-2">
              <span :class="r.riskLevel === 'high' ? 'text-danger' : r.riskLevel === 'medium' ? 'text-warn' : 'text-ok'">
                [{{ RISK_LABEL[r.riskLevel] }}]
              </span>
              {{ TYPE_LABEL[r.targetType.replace('reported_', '')] ?? r.targetType }}
              <span v-if="r.flagged" class="text-warn">・待抽查</span>
              <span class="text-dim">・{{ r.rationale || '無理由' }}・{{ r.decidedBy === 'auto' ? '自動' : '人工' }}</span>
              <span class="ml-1 font-mono text-[11px] text-dim">{{ formatDateTime(r.createdAt) }}</span>
            </li>
          </ul>
          <p v-else class="mt-4 text-sm text-dim">沒有任何審核紀錄。</p>
        </template>
      </ModalShell>
    </template>
  </div>
</template>
