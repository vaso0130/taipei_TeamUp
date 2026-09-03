<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { PublicParticipantView, TeamDetail } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import EmptyState from '../components/EmptyState.vue'
import ReportDialog from '../components/ReportDialog.vue'
import TagChip from '../components/TagChip.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()

const people = ref<PublicParticipantView[]>([])
const loading = ref(true)
const myTeam = ref<TeamDetail | null>(null)

async function load() {
  const slug = eventStore.event?.slug
  if (!slug) return
  loading.value = true
  try {
    people.value = (await api.listParticipants(slug)).participants
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 503)) console.error(err)
    people.value = []
  } finally {
    loading.value = false
  }
}

// ---- 檢舉 ----
const reportUserId = ref<string | null>(null)
async function submitReport(reason: string) {
  const slug = eventStore.event?.slug
  if (!auth.token || !slug || !reportUserId.value) return
  await api.reportParticipant(auth.token, slug, reportUserId.value, reason)
}

async function loadMyTeam() {
  const slug = eventStore.event?.slug
  if (!slug || !auth.token || !auth.isLoggedIn) {
    myTeam.value = null
    return
  }
  try {
    myTeam.value = (await api.myTeam(auth.token, slug)).team
  } catch {
    myTeam.value = null
  }
}

onMounted(async () => {
  await eventStore.ensureLoaded()
  await Promise.all([load(), loadMyTeam()])
})
watch(
  () => auth.isLoggedIn,
  () => void loadMyTeam(),
)

/** Owners of a recruiting team can invite directly from this list. */
const canInvite = computed(
  () =>
    !!myTeam.value &&
    myTeam.value.viewerIsOwner &&
    myTeam.value.status === 'recruiting' &&
    eventStore.recruitOpen,
)

const inviteOpenFor = ref<string | null>(null)
const inviteMessage = ref('')
const inviteState = reactive<Record<string, { kind: 'ok' | 'error'; text: string }>>({})

function openInvite(userId: string) {
  inviteOpenFor.value = inviteOpenFor.value === userId ? null : userId
  inviteMessage.value = ''
}

async function sendInvite(userId: string) {
  if (!auth.token || !myTeam.value) return
  try {
    await api.inviteToTeam(auth.token, myTeam.value.id, userId, inviteMessage.value)
    inviteState[userId] = { kind: 'ok', text: '邀請已送出' }
    inviteOpenFor.value = null
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    inviteState[userId] = {
      kind: 'error',
      text:
        code === 'duplicate_application'
          ? '已邀請過，等待對方回覆'
          : code === 'already_in_team' || code === 'already_in_this_team'
            ? `對方已有${eventStore.termTeam}`
            : '邀請失敗，請稍後再試',
    }
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-black">找人</h1>
    <p class="mt-1 text-sm text-dim">
      這些人把自己標記為「想找{{ eventStore.termTeam }}」，主動邀請他們吧。
    </p>

    <!-- Why can't I act? Always explain the missing affordance. -->
    <div
      v-if="!canInvite && !loading"
      class="card mt-4 flex flex-wrap items-center justify-between gap-3 bg-primary-mist px-5 py-4 text-sm"
    >
      <template v-if="!auth.isLoggedIn">
        <span>登入並建立{{ eventStore.termTeam }}後，就能直接邀請這裡的人。</span>
        <RouterLink to="/profile" class="btn btn-primary !min-h-[40px] text-sm">前往登入</RouterLink>
      </template>
      <template v-else-if="!myTeam">
        <span>想邀請他們？先建立你的{{ eventStore.termTeam }}，邀請按鈕就會出現。</span>
        <RouterLink
          :to="{ name: 'teams', query: { create: '1' } }"
          class="btn btn-cta !min-h-[40px] text-sm"
        >
          建立{{ eventStore.termTeam }}
        </RouterLink>
      </template>
      <span v-else-if="!myTeam.viewerIsOwner">
        只有{{ eventStore.termTeam }}的發起人可以送出邀請；你可以請發起人來這裡邀人。
      </span>
      <span v-else-if="myTeam.status !== 'recruiting'">
        你的{{ eventStore.termTeam }}目前未開放招募，到{{ eventStore.termTeam }}頁面重新開放後即可邀請。
      </span>
      <span v-else>揪團已截止，無法再送出邀請。</span>
    </div>

    <p v-if="loading" class="mt-6 text-dim">載入中⋯</p>

    <div v-else-if="people.length" class="mt-6 grid gap-4 sm:grid-cols-2">
      <article v-for="person in people" :key="person.userId" class="card p-5">
        <div class="flex items-start justify-between gap-2">
          <h2 class="font-bold">{{ person.displayName }}</h2>
          <button
            v-if="auth.isLoggedIn && person.userId !== auth.me?.userId"
            class="cursor-pointer text-xs text-dim underline decoration-dotted underline-offset-2 hover:text-danger"
            @click="reportUserId = person.userId"
          >
            檢舉
          </button>
        </div>
        <p v-if="person.blurb" class="mt-1 text-sm text-dim">{{ person.blurb }}</p>

        <ul v-if="person.preferredRoles.length" class="mt-3 flex flex-wrap gap-1.5" aria-label="偏好角色">
          <li v-for="key in person.preferredRoles" :key="key">
            <TagChip :label="eventStore.roleLabel(key)" />
          </li>
        </ul>
        <ul v-if="person.skills.length" class="mt-2 flex flex-wrap gap-1.5" aria-label="技能">
          <li v-for="key in person.skills" :key="key">
            <TagChip :label="eventStore.skillLabel(key)" :dot="eventStore.skillDot(key)" />
          </li>
        </ul>
        <ul
          v-if="person.customTags.length"
          class="mt-2 flex flex-wrap gap-1.5"
          aria-label="自訂標籤"
        >
          <li v-for="tag in person.customTags" :key="tag">
            <TagChip :label="tag" />
          </li>
        </ul>

        <div v-if="canInvite" class="mt-4">
          <p
            v-if="inviteState[person.userId]"
            class="mb-2 text-sm"
            :class="inviteState[person.userId]!.kind === 'ok' ? 'text-ok' : 'text-danger'"
            role="status"
          >
            {{ inviteState[person.userId]!.text }}
          </p>
          <template v-if="inviteOpenFor === person.userId">
            <label class="field-label" :for="`invite-msg-${person.userId}`">附言（選填）</label>
            <textarea
              :id="`invite-msg-${person.userId}`"
              v-model="inviteMessage"
              class="field-input"
              rows="2"
              maxlength="500"
            ></textarea>
            <div class="mt-2 flex gap-2">
              <button class="btn btn-primary !min-h-[40px] text-sm" @click="sendInvite(person.userId)">
                送出邀請
              </button>
              <button class="btn btn-quiet !min-h-[40px] text-sm" @click="inviteOpenFor = null">
                取消
              </button>
            </div>
          </template>
          <button
            v-else-if="!inviteState[person.userId]"
            class="btn btn-quiet !min-h-[40px] text-sm"
            @click="openInvite(person.userId)"
          >
            邀請加入「{{ myTeam?.name }}」
          </button>
        </div>
      </article>
    </div>

    <EmptyState
      v-else
      class="mt-6"
      title="還沒有人在找團"
      :hint="`到個人檔案把自己設成「想找${eventStore.termTeam}」，就會出現在這裡。`"
    >
      <template #action>
        <RouterLink to="/profile" class="btn btn-primary">編輯我的檔案</RouterLink>
      </template>
    </EmptyState>

    <ReportDialog
      :open="reportUserId !== null"
      title="檢舉這位參加者"
      description="檢舉後對方的自我介紹會先隱藏，並連同暱稱交由更嚴格的 AI 複審；必要時由管理員人工處理。"
      :submit="submitReport"
      @close="reportUserId = null"
    />
  </div>
</template>
