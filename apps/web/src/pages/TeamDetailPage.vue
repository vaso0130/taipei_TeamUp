<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { ApplicationView, TeamDetail } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import { captchaToken } from '../lib/recaptcha.js'
import ReportDialog from '../components/ReportDialog.vue'
import TagChip from '../components/TagChip.vue'
import { formatDate } from '../lib/format.js'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const route = useRoute()
const router = useRouter()
const eventStore = useEventStore()
const auth = useAuthStore()

const teamId = computed(() => String(route.params.id))
const team = ref<TeamDetail | null>(null)
const loading = ref(true)
const notFound = ref(false)
const pendingApplications = ref<ApplicationView[]>([])

async function load() {
  loading.value = true
  notFound.value = false
  try {
    team.value = await api.getTeam(teamId.value, auth.token ?? undefined)
    if (team.value.viewerIsOwner && auth.token) {
      pendingApplications.value = (
        await api.listTeamApplications(auth.token, teamId.value)
      ).applications
    }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 503)) {
      notFound.value = true
    } else {
      console.error(err)
      notFound.value = true
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await eventStore.ensureLoaded()
  await load()
})
watch(() => auth.isLoggedIn, load)

const event = computed(() => eventStore.event)

const statusMeta = computed(() => {
  switch (team.value?.status) {
    case 'recruiting':
      return { label: '招募中', bar: 'var(--color-primary)', chip: 'text-primary-deep bg-primary-mist' }
    case 'full':
      return { label: '已滿編', bar: 'var(--color-warn)', chip: 'text-warn bg-warn-mist' }
    default:
      return { label: '已關閉', bar: 'var(--color-dim)', chip: 'text-dim bg-mist' }
  }
})

const contactRankLabel = (rank: number) =>
  rank === 1 ? '主要聯絡人' : rank === 2 ? '次要聯絡人' : `聯絡人 ${rank}`

const contactRankOf = (userId: string) =>
  team.value?.contacts.find((c) => c.userId === userId)?.rank ?? null

const isSelf = (userId: string) => auth.me?.userId === userId

// ---- 檢舉 ----
const reportOpen = ref(false)
async function submitTeamReport(reason: string) {
  if (!auth.token || !team.value) return
  await api.reportTeam(auth.token, team.value.id, reason)
}

// ---- apply ----
const applyMessage = ref('')
const applying = ref(false)
const applyFeedback = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

const canApply = computed(
  () =>
    auth.isLoggedIn &&
    team.value &&
    !team.value.viewerIsMember &&
    team.value.status === 'recruiting' &&
    eventStore.recruitOpen,
)

async function submitApply() {
  if (!auth.token || !team.value) return
  applying.value = true
  applyFeedback.value = null
  try {
    await api.applyToTeam(
      auth.token,
      team.value.id,
      applyMessage.value,
      await captchaToken('apply_team'),
    )
    applyFeedback.value = { kind: 'ok', text: '申請已送出，等待對方回覆。' }
    applyMessage.value = ''
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    applyFeedback.value = {
      kind: 'error',
      text:
        code === 'already_in_team'
          ? `你已在其他${eventStore.termTeam}中，無法申請`
          : code === 'duplicate_application'
            ? '你已送出過申請，等待回覆中'
            : code === 'not_recruiting' || code === 'recruiting_closed'
              ? '這個' + eventStore.termTeam + '目前不接受申請'
              : '申請失敗，請稍後再試',
    }
  } finally {
    applying.value = false
  }
}

// ---- owner: respond to applications ----
const respondFeedback = ref('')
async function respond(applicationId: string, action: 'accept' | 'reject') {
  if (!auth.token) return
  respondFeedback.value = ''
  try {
    await api.respondApplication(auth.token, applicationId, action)
    await load()
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    respondFeedback.value =
      code === 'team_full'
        ? `${eventStore.termTeam}已滿，無法再接受`
        : code === 'already_in_team'
          ? `對方已加入其他${eventStore.termTeam}`
          : '操作失敗，請稍後再試'
  }
}

// ---- owner: contacts ----
const contactPicks = reactive<Record<number, string>>({})
const contactsFeedback = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const savingContacts = ref(false)

watch(team, (t) => {
  if (!t) return
  for (const c of t.contacts) contactPicks[c.rank] = c.userId
})

const contactsReady = computed(() => {
  const e = event.value
  const t = team.value
  return !!e && !!t && e.requiredContacts > 0 && t.viewerIsOwner
})
const contactsAllowed = computed(() => {
  const e = event.value
  const t = team.value
  return !!e && !!t && t.memberCount >= e.minMembers
})

async function saveContacts() {
  const e = event.value
  if (!auth.token || !team.value || !e) return
  const contacts = Array.from({ length: e.requiredContacts }, (_, i) => ({
    userId: contactPicks[i + 1] ?? '',
    rank: i + 1,
  }))
  if (contacts.some((c) => !c.userId)) {
    contactsFeedback.value = { kind: 'error', text: '每個聯絡人位置都要選一位成員' }
    return
  }
  if (new Set(contacts.map((c) => c.userId)).size !== contacts.length) {
    contactsFeedback.value = { kind: 'error', text: '聯絡人不能重複' }
    return
  }
  savingContacts.value = true
  contactsFeedback.value = null
  try {
    await api.putContacts(auth.token, team.value.id, { contacts })
    contactsFeedback.value = { kind: 'ok', text: '聯絡人已更新' }
    await load()
  } catch {
    contactsFeedback.value = { kind: 'error', text: '儲存失敗，請稍後再試' }
  } finally {
    savingContacts.value = false
  }
}

// ---- owner: recruiting needs + status ----
const editNeeds = reactive({ neededRoles: [] as string[], neededSkills: [] as string[], pitch: '' })
const needsFeedback = ref('')
const savingNeeds = ref(false)
watch(team, (t) => {
  if (!t) return
  editNeeds.neededRoles = [...t.neededRoles]
  editNeeds.neededSkills = [...t.neededSkills]
  editNeeds.pitch = t.pitch
})

function toggleKey(list: string[], key: string) {
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  else list.push(key)
}

async function saveNeeds() {
  if (!auth.token || !team.value) return
  savingNeeds.value = true
  needsFeedback.value = ''
  try {
    await api.updateTeam(auth.token, team.value.id, { ...editNeeds })
    needsFeedback.value = '已儲存'
    await load()
  } catch {
    needsFeedback.value = '儲存失敗，請稍後再試'
  } finally {
    savingNeeds.value = false
  }
}

async function toggleStatus() {
  if (!auth.token || !team.value) return
  const next = team.value.status === 'closed' ? 'recruiting' : 'closed'
  try {
    await api.updateTeam(auth.token, team.value.id, { status: next })
    await load()
  } catch (err) {
    needsFeedback.value =
      err instanceof ApiError && err.code === 'team_full' ? '已滿編，無法重新開放' : '操作失敗'
  }
}

// ---- owner: delete (only while sole member) ----
const deleting = ref(false)
async function removeTeam() {
  if (!auth.token || !team.value) return
  if (!window.confirm(`確定要刪除「${team.value.name}」嗎？此動作無法復原。`)) return
  deleting.value = true
  try {
    await api.deleteTeam(auth.token, team.value.id)
    await router.push({ name: 'teams' })
  } catch (err) {
    deleting.value = false
    needsFeedback.value =
      err instanceof ApiError && err.code === 'team_not_empty'
        ? '還有其他成員在隊上，請先請成員退出再刪除'
        : '刪除失敗，請稍後再試'
  }
}

// ---- member: leave ----
const leaving = ref(false)
async function leave() {
  if (!auth.token || !team.value) return
  if (!window.confirm(`確定要離開「${team.value.name}」嗎？`)) return
  leaving.value = true
  try {
    await api.leaveTeam(auth.token, team.value.id)
    await router.push({ name: 'teams' })
  } catch {
    leaving.value = false
  }
}

const applicationMessageOf = (a: ApplicationView) =>
  a.message ?? (a.messageVisibility === 'pending_review' ? '（附言審核中）' : null)
</script>

<template>
  <div>
    <p v-if="loading" class="text-dim">載入中⋯</p>

    <template v-else-if="notFound || !team">
      <div class="card p-8 text-center">
        <p class="font-medium">找不到這個{{ eventStore.termTeam }}</p>
        <RouterLink to="/teams" class="btn btn-quiet mt-4">回列表</RouterLink>
      </div>
    </template>

    <template v-else>
      <RouterLink to="/teams" class="text-sm text-dim hover:text-ink">← 回{{ eventStore.termTeam }}列表</RouterLink>

      <!-- signboard header -->
      <section class="card mt-3 overflow-hidden">
        <div class="h-2" :style="{ backgroundColor: statusMeta.bar }" aria-hidden="true"></div>
        <div class="p-6">
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="text-2xl font-black">{{ team.name }}</h1>
            <span class="rounded-full px-3 py-1 text-xs font-medium" :class="statusMeta.chip">
              {{ statusMeta.label }}
            </span>
            <span class="font-mono text-sm font-semibold text-primary-deep">
              {{ team.memberCount }}<span class="text-dim">/{{ event?.maxMembers }}</span>
              {{ eventStore.termMember }}
            </span>
            <span class="grow"></span>
            <button
              v-if="auth.isLoggedIn && !team.viewerIsOwner"
              class="cursor-pointer text-xs text-dim underline decoration-dotted underline-offset-2 hover:text-danger"
              @click="reportOpen = true"
            >
              檢舉
            </button>
          </div>

          <p v-if="team.pitch" class="mt-3 whitespace-pre-line text-dim">{{ team.pitch }}</p>
          <p
            v-if="team.viewerIsOwner && team.pitchVisibility === 'pending_review' && team.pitch"
            class="mt-2 text-sm text-warn"
          >
            簡介審核中，通過後其他人才看得到。
          </p>

          <ul
            v-if="team.neededRoles.length || team.neededSkills.length"
            class="mt-4 flex flex-wrap gap-2"
            aria-label="還缺的角色與技能"
          >
            <li v-for="key in team.neededRoles" :key="`r-${key}`">
              <TagChip :label="`缺 ${eventStore.roleLabel(key)}`" />
            </li>
            <li v-for="key in team.neededSkills" :key="`s-${key}`">
              <TagChip :label="eventStore.skillLabel(key)" :dot="eventStore.skillDot(key)" />
            </li>
          </ul>

          <p class="mt-4 font-mono text-xs text-dim">建立於 {{ formatDate(team.createdAt) }}</p>
        </div>
      </section>

      <!-- members -->
      <section class="card mt-5 p-6" aria-labelledby="members-title">
        <h2 id="members-title" class="font-bold">{{ eventStore.termMember }}（{{ team.memberCount }}）</h2>
        <ul class="mt-3 divide-y divide-line">
          <li v-for="member in team.members" :key="member.userId" class="flex flex-wrap items-center gap-2 py-2.5">
            <span class="font-medium">{{ member.displayName }}</span>
            <span
              v-if="member.userId === team.ownerUserId"
              class="rounded-full bg-mist px-2 py-0.5 text-xs text-dim"
            >
              發起人
            </span>
            <span
              v-if="contactRankOf(member.userId)"
              class="rounded-full bg-primary-mist px-2 py-0.5 text-xs text-primary-deep"
            >
              {{ contactRankLabel(contactRankOf(member.userId)!) }}
            </span>
            <RouterLink
              v-if="team.viewerIsMember && !isSelf(member.userId)"
              :to="{ name: 'messages', query: { to: member.userId, name: member.displayName } }"
              class="ml-auto text-sm font-medium text-primary-deep hover:underline"
            >
              傳訊息
            </RouterLink>
          </li>
        </ul>

        <button
          v-if="team.viewerIsMember && !team.viewerIsOwner"
          class="btn btn-danger mt-4"
          :disabled="leaving"
          @click="leave"
        >
          離開{{ eventStore.termTeam }}
        </button>
      </section>

      <!-- apply -->
      <section v-if="canApply" class="card mt-5 p-6" aria-labelledby="apply-title">
        <h2 id="apply-title" class="font-bold">申請加入</h2>
        <label class="field-label mt-3" for="apply-message">附言（選填）</label>
        <textarea
          id="apply-message"
          v-model="applyMessage"
          class="field-input"
          rows="3"
          maxlength="500"
          aria-describedby="apply-message-hint"
          :placeholder="`說說你能為這個${eventStore.termTeam}帶來什麼`"
        ></textarea>
        <p id="apply-message-hint" class="field-hint">附言發布前會經過自動化風險檢測。</p>
        <p
          v-if="applyFeedback"
          class="mt-3 text-sm"
          :class="applyFeedback.kind === 'ok' ? 'text-ok' : 'text-danger'"
          role="alert"
        >
          {{ applyFeedback.text }}
        </p>
        <button class="btn btn-cta mt-4" :disabled="applying" @click="submitApply">
          {{ applying ? '送出中⋯' : '送出申請' }}
        </button>
      </section>
      <section v-else-if="!auth.isLoggedIn && team.status === 'recruiting'" class="card mt-5 p-6">
        <p>
          想加入這個{{ eventStore.termTeam }}？
          <RouterLink to="/profile" class="font-medium text-primary-deep underline">先登入</RouterLink>
          再送出申請。
        </p>
      </section>

      <!-- owner: pending applications -->
      <section v-if="team.viewerIsOwner" class="card mt-5 p-6" aria-labelledby="pending-title">
        <h2 id="pending-title" class="font-bold">待處理的申請（{{ pendingApplications.length }}）</h2>
        <p v-if="respondFeedback" class="mt-2 text-sm text-danger" role="alert">{{ respondFeedback }}</p>
        <p v-if="pendingApplications.length === 0" class="mt-2 text-sm text-dim">
          目前沒有等待回覆的申請。
        </p>
        <ul v-else class="mt-3 divide-y divide-line">
          <li v-for="a in pendingApplications" :key="a.id" class="py-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span class="font-medium">{{ a.applicantDisplayName }}</span>
                <span class="ml-2 text-xs text-dim">{{ a.direction === 'apply' ? '申請加入' : '已邀請' }}</span>
                <p v-if="applicationMessageOf(a)" class="mt-1 text-sm text-dim">
                  {{ applicationMessageOf(a) }}
                </p>
              </div>
              <div v-if="a.direction === 'apply'" class="flex gap-2">
                <button class="btn btn-primary !min-h-[40px] !px-4 text-sm" @click="respond(a.id, 'accept')">
                  接受
                </button>
                <button class="btn btn-quiet !min-h-[40px] !px-4 text-sm" @click="respond(a.id, 'reject')">
                  婉拒
                </button>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <!-- owner: contacts -->
      <section v-if="contactsReady" class="card mt-5 p-6" aria-labelledby="contacts-title">
        <h2 id="contacts-title" class="font-bold">指定聯絡人</h2>
        <p v-if="!contactsAllowed" class="mt-2 text-sm text-dim">
          {{ eventStore.termTeam }}達到 {{ event?.minMembers }} 名{{ eventStore.termMember
          }}後，才能指定 {{ event?.requiredContacts }} 位聯絡人。
        </p>
        <template v-else>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div v-for="rank in event?.requiredContacts ?? 0" :key="rank">
              <label class="field-label" :for="`contact-${rank}`">{{ contactRankLabel(rank) }}</label>
              <select :id="`contact-${rank}`" v-model="contactPicks[rank]" class="field-input">
                <option value="" disabled>選擇{{ eventStore.termMember }}</option>
                <option v-for="m in team.members" :key="m.userId" :value="m.userId">
                  {{ m.displayName }}
                </option>
              </select>
            </div>
          </div>
          <p
            v-if="contactsFeedback"
            class="mt-3 text-sm"
            :class="contactsFeedback.kind === 'ok' ? 'text-ok' : 'text-danger'"
            role="alert"
          >
            {{ contactsFeedback.text }}
          </p>
          <button class="btn btn-primary mt-4" :disabled="savingContacts" @click="saveContacts">
            儲存聯絡人
          </button>
        </template>
      </section>

      <!-- owner: manage recruiting -->
      <section v-if="team.viewerIsOwner" class="card mt-5 p-6" aria-labelledby="manage-title">
        <h2 id="manage-title" class="font-bold">招募設定</h2>

        <div class="mt-3">
          <label class="field-label" for="edit-pitch">{{ eventStore.termTeam }}簡介</label>
          <textarea
            id="edit-pitch"
            v-model="editNeeds.pitch"
            class="field-input"
            rows="3"
            maxlength="1000"
          ></textarea>
        </div>

        <fieldset v-if="eventStore.detail?.roles.length" class="mt-4">
          <legend class="field-label">還缺哪些角色</legend>
          <div class="flex flex-wrap gap-2">
            <TagChip
              v-for="role in eventStore.detail.roles"
              :key="role.key"
              :label="role.label"
              selectable
              :selected="editNeeds.neededRoles.includes(role.key)"
              @toggle="toggleKey(editNeeds.neededRoles, role.key)"
            />
          </div>
        </fieldset>

        <fieldset v-for="group in eventStore.skillGroups" :key="group.category" class="mt-4">
          <legend class="field-label">還缺的技能：{{ group.category }}</legend>
          <div class="flex flex-wrap gap-2">
            <TagChip
              v-for="skill in group.skills"
              :key="skill.key"
              :label="skill.label"
              :dot="group.color"
              selectable
              :selected="editNeeds.neededSkills.includes(skill.key)"
              @toggle="toggleKey(editNeeds.neededSkills, skill.key)"
            />
          </div>
        </fieldset>

        <p v-if="needsFeedback" class="mt-3 text-sm text-dim" role="status">{{ needsFeedback }}</p>
        <div class="mt-4 flex flex-wrap gap-3">
          <button class="btn btn-primary" :disabled="savingNeeds" @click="saveNeeds">儲存</button>
          <button v-if="team.status !== 'full'" class="btn btn-quiet" @click="toggleStatus">
            {{ team.status === 'closed' ? '重新開放招募' : '關閉招募' }}
          </button>
          <button
            v-if="team.memberCount === 1"
            class="btn btn-quiet text-danger"
            :disabled="deleting"
            @click="removeTeam"
          >
            刪除{{ eventStore.termTeam }}
          </button>
        </div>
      </section>

      <ReportDialog
        :open="reportOpen"
        :title="`檢舉這個${eventStore.termTeam}`"
        description="檢舉後其簡介會先隱藏，並連同名稱交由更嚴格的 AI 複審；必要時由管理員人工處理。"
        :submit="submitTeamReport"
        @close="reportOpen = false"
      />
    </template>
  </div>
</template>
