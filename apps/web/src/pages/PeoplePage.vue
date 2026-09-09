<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import type { PublicParticipantView, TeamDetail } from '@teamup/shared'
import { api } from '../api/client.js'
import { classifyLoadError, describeApiError, type LoadFailure } from '../lib/errors.js'
import EmptyState from '../components/EmptyState.vue'
import LoadError from '../components/LoadError.vue'
import ReportDialog from '../components/ReportDialog.vue'
import TagChip from '../components/TagChip.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()
const route = useRoute()
const slug = computed(() => String(route.params.slug))

const people = ref<PublicParticipantView[]>([])
const loading = ref(true)
const loadError = ref<LoadFailure | null>(null)
const myTeam = ref<TeamDetail | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  const detail = await eventStore.ensureLoaded(slug.value)
  if (!detail) {
    loadError.value = eventStore.failures[slug.value] ?? 'failed'
    loading.value = false
    return
  }
  // Draft preview (§3): nobody can have joined a draft, so do not ask.
  if (eventStore.preview) {
    people.value = []
    loading.value = false
    return
  }
  try {
    people.value = (await api.listParticipants(slug.value)).participants
  } catch (err) {
    people.value = []
    loadError.value = classifyLoadError(err)
  } finally {
    loading.value = false
  }
}

// ---- 檢舉 ----
const reportUserId = ref<string | null>(null)
async function submitReport(reason: string) {
  if (!auth.token || !reportUserId.value) return
  await api.reportParticipant(auth.getToken, slug.value, reportUserId.value, reason)
}

async function loadMyTeam() {
  if (!auth.token || !auth.isLoggedIn || eventStore.preview) {
    myTeam.value = null
    return
  }
  try {
    myTeam.value = (await api.myTeam(auth.getToken, slug.value)).team
  } catch {
    myTeam.value = null
  }
}

onMounted(async () => {
  await eventStore.ensureLoaded(slug.value)
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
    eventStore.recruitOpen &&
    !eventStore.readOnly,
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
    await api.inviteToTeam(auth.getToken, myTeam.value.id, userId, inviteMessage.value)
    inviteState[userId] = { kind: 'ok', text: '邀請已送出' }
    inviteOpenFor.value = null
  } catch (err) {
    inviteState[userId] = {
      kind: 'error',
      text: describeApiError(
        err,
        { termTeam: eventStore.termTeam, termMember: eventStore.termMember },
        '邀請失敗，請稍後再試',
        {
          duplicate_application: '已邀請過，等待對方回覆',
          already_in_team: `對方已有${eventStore.termTeam}`,
          already_in_this_team: `對方已在你的${eventStore.termTeam}中`,
          validation_failed: '附言最多 500 字',
          participation_required: `對方尚未完成參加資料，暫時無法邀請`,
        },
      ),
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

    <!-- Why can't I act? Always explain the missing affordance (unless nothing can be done at all). -->
    <div
      v-if="!canInvite && !loading && !eventStore.readOnly"
      class="card mt-4 flex flex-wrap items-center justify-between gap-3 bg-primary-mist px-5 py-4 text-sm"
    >
      <template v-if="!auth.isLoggedIn">
        <span>登入並建立{{ eventStore.termTeam }}後，就能直接邀請這裡的人。</span>
        <RouterLink to="/profile" class="btn btn-primary text-sm">前往登入</RouterLink>
      </template>
      <template v-else-if="!myTeam">
        <span>想邀請他們？先建立你的{{ eventStore.termTeam }}，邀請按鈕就會出現。</span>
        <RouterLink
          v-if="eventStore.recruitOpen"
          :to="{ name: 'teams', params: { slug }, query: { create: '1' } }"
          class="btn btn-cta text-sm"
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

    <p v-if="loading" class="mt-6 text-dim" aria-live="polite">載入中⋯</p>

    <LoadError v-else-if="loadError" class="mt-6" :kind="loadError" @retry="load" />

    <div v-else-if="people.length" class="mt-6 grid gap-4 sm:grid-cols-2">
      <article v-for="person in people" :key="person.userId" class="card p-5">
        <div class="flex items-start justify-between gap-2">
          <h2 class="font-bold">{{ person.displayName }}</h2>
          <button
            v-if="auth.isLoggedIn && person.userId !== auth.me?.userId && !eventStore.readOnly"
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
              <button class="btn btn-primary text-sm" @click="sendInvite(person.userId)">
                送出邀請
              </button>
              <button class="btn btn-quiet text-sm" @click="inviteOpenFor = null">取消</button>
            </div>
          </template>
          <button
            v-else-if="!inviteState[person.userId]"
            class="btn btn-quiet text-sm"
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
      :title="`還沒有人在找${eventStore.termTeam}`"
      :hint="
        eventStore.preview
          ? '草稿尚無資料——開放活動後參加者才能填寫參加資料。'
          : `到個人檔案把自己設成「想找${eventStore.termTeam}」，就會出現在這裡。`
      "
    >
      <template v-if="!eventStore.readOnly" #action>
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
