<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { TeamDetail, TeamSummary } from '@teamup/shared'
import { api } from '../api/client.js'
import { classifyLoadError, describeApiError, type LoadFailure } from '../lib/errors.js'
import { captchaToken } from '../lib/recaptcha.js'
import EmptyState from '../components/EmptyState.vue'
import LoadError from '../components/LoadError.vue'
import TagChip from '../components/TagChip.vue'
import TeamCard from '../components/TeamCard.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const teams = ref<TeamSummary[]>([])
const loading = ref(true)
const loadError = ref<LoadFailure | null>(null)
const myTeam = ref<TeamDetail | null>(null)

// Filters live in the URL so a filtered view can be shared.
const filters = reactive({
  status: (route.query.status as string) ?? '',
  role: (route.query.role as string) ?? '',
  skill: (route.query.skill as string) ?? '',
})
const showCreate = ref(route.query.create === '1')

watch(filters, () => {
  const query: Record<string, string> = {}
  if (filters.status) query.status = filters.status
  if (filters.role) query.role = filters.role
  if (filters.skill) query.skill = filters.skill
  if (showCreate.value) query.create = '1'
  void router.replace({ query })
  void loadTeams()
})

async function loadTeams() {
  loading.value = true
  loadError.value = null
  await eventStore.ensureLoaded()
  const slug = eventStore.event?.slug
  if (!slug) {
    loadError.value = 'failed'
    loading.value = false
    return
  }
  try {
    teams.value = (await api.listTeams(slug, filters)).teams
  } catch (err) {
    teams.value = []
    loadError.value = classifyLoadError(err)
  } finally {
    loading.value = false
  }
}

async function loadMyTeam() {
  const slug = eventStore.event?.slug
  if (!slug || !auth.token || !auth.isLoggedIn) return
  try {
    myTeam.value = (await api.myTeam(auth.getToken, slug)).team
  } catch {
    myTeam.value = null
  }
}

onMounted(async () => {
  await eventStore.ensureLoaded()
  await Promise.all([loadTeams(), loadMyTeam()])
})
watch(
  () => auth.isLoggedIn,
  () => void loadMyTeam(),
)

// ---- create team form ----
const form = reactive({ name: '', pitch: '', neededRoles: [] as string[], neededSkills: [] as string[] })
const formErrors = reactive({ name: '' })
const creating = ref(false)
const createError = ref('')

function toggleKey(list: string[], key: string) {
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  else list.push(key)
}

function validateName() {
  formErrors.name =
    form.name.trim().length === 0 || form.name.trim().length > 40 ? '名稱須為 1–40 個字' : ''
}

async function createTeam() {
  validateName()
  if (formErrors.name) return
  const slug = eventStore.event?.slug
  if (!slug || !auth.token) return
  creating.value = true
  createError.value = ''
  try {
    const detail = await api.createTeam(
      auth.getToken,
      slug,
      { ...form, name: form.name.trim() },
      await captchaToken('create_team'),
    )
    await router.push({ name: 'team-detail', params: { id: detail.id } })
  } catch (err) {
    createError.value = describeApiError(
      err,
      { termTeam: eventStore.termTeam, termMember: eventStore.termMember },
      '建立失敗，請稍後再試',
      {
        already_in_team: `你已在一個${eventStore.termTeam}中，無法再建立新的`,
        recruiting_closed: '揪團已截止，無法建立',
        name_rejected: '名稱未通過自動化篩選，請換一個名稱',
        validation_failed: '名稱須為 1–40 個字，簡介最多 1000 字',
      },
    )
  } finally {
    creating.value = false
  }
}

const canCreate = computed(
  () => auth.isLoggedIn && eventStore.recruitOpen && !(eventStore.event?.exclusiveMembership && myTeam.value),
)
/** Landed on ?create=1 without a session: explain instead of showing nothing. */
const needsLoginToCreate = computed(() => showCreate.value && !auth.isLoggedIn && !auth.loading)
</script>

<template>
  <div>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-black">找{{ eventStore.termTeam }}</h1>
        <p class="mt-1 text-sm text-dim">看看誰在招募，找到缺你的那一個{{ eventStore.termTeam }}。</p>
      </div>
      <button v-if="canCreate" class="btn btn-cta" @click="showCreate = !showCreate">
        {{ showCreate ? '收合表單' : `建立${eventStore.termTeam}` }}
      </button>
    </div>

    <!-- create requested but not signed in -->
    <div
      v-if="needsLoginToCreate"
      class="card mt-4 flex flex-wrap items-center justify-between gap-3 bg-primary-mist px-5 py-4 text-sm"
      role="status"
    >
      <span>請先登入，登入後即可建立{{ eventStore.termTeam }}。</span>
      <RouterLink
        :to="{ name: 'profile', query: { next: 'create-team' } }"
        class="btn btn-primary text-sm"
      >
        前往登入
      </RouterLink>
    </div>

    <!-- my team banner -->
    <RouterLink
      v-if="myTeam"
      :to="{ name: 'team-detail', params: { id: myTeam.id } }"
      class="card mt-5 flex items-center justify-between gap-3 border-primary bg-primary-mist px-5 py-4 transition-colors duration-150 hover:border-primary-deep"
    >
      <span>
        你目前在「<strong>{{ myTeam.name }}</strong
        >」（{{ myTeam.memberCount }} 名{{ eventStore.termMember }}）
      </span>
      <span class="text-sm font-medium text-primary-deep">查看 →</span>
    </RouterLink>

    <!-- create form -->
    <form v-if="showCreate && canCreate" class="card mt-5 p-6" novalidate @submit.prevent="createTeam">
      <h2 class="font-bold">建立{{ eventStore.termTeam }}</h2>

      <div class="mt-4">
        <label class="field-label" for="team-name">名稱</label>
        <input
          id="team-name"
          v-model="form.name"
          class="field-input max-w-md"
          maxlength="40"
          required
          :aria-invalid="!!formErrors.name"
          aria-describedby="team-name-error team-name-hint"
          @blur="validateName"
        />
        <p v-if="formErrors.name" id="team-name-error" class="field-error">{{ formErrors.name }}</p>
        <p id="team-name-hint" class="field-hint">送出時會經過自動化篩選確認合規（約需數秒）。</p>
      </div>

      <div class="mt-4">
        <label class="field-label" for="team-pitch">想做什麼（選填）</label>
        <textarea
          id="team-pitch"
          v-model="form.pitch"
          class="field-input"
          rows="3"
          maxlength="1000"
          aria-describedby="team-pitch-hint"
        ></textarea>
        <p id="team-pitch-hint" class="field-hint">發布前會經過自動化風險檢測，通過後才公開。</p>
      </div>

      <fieldset v-if="eventStore.detail?.roles.length" class="mt-4">
        <legend class="field-label">還缺哪些角色（選填）</legend>
        <div class="flex flex-wrap gap-2">
          <TagChip
            v-for="role in eventStore.detail.roles"
            :key="role.key"
            :label="role.label"
            selectable
            :selected="form.neededRoles.includes(role.key)"
            @toggle="toggleKey(form.neededRoles, role.key)"
          />
        </div>
      </fieldset>

      <fieldset v-for="group in eventStore.skillGroups" :key="group.category" class="mt-4">
        <legend class="field-label">還缺的技能：{{ group.category }}（選填）</legend>
        <div class="flex flex-wrap gap-2">
          <TagChip
            v-for="skill in group.skills"
            :key="skill.key"
            :label="skill.label"
            :dot="group.color"
            selectable
            :selected="form.neededSkills.includes(skill.key)"
            @toggle="toggleKey(form.neededSkills, skill.key)"
          />
        </div>
      </fieldset>

      <p v-if="createError" class="field-error mt-4" role="alert">{{ createError }}</p>
      <div class="mt-5">
        <button type="submit" class="btn btn-primary" :disabled="creating">
          {{ creating ? '建立中⋯' : `建立${eventStore.termTeam}` }}
        </button>
      </div>
    </form>

    <!-- filters -->
    <div class="mt-6 flex flex-wrap items-center gap-3">
      <label class="text-sm text-dim" for="filter-status">狀態</label>
      <select id="filter-status" v-model="filters.status" class="field-input w-auto">
        <option value="">全部</option>
        <option value="recruiting">招募中</option>
        <option value="full">已滿編</option>
        <option value="closed">已關閉</option>
      </select>

      <label class="text-sm text-dim" for="filter-role">缺角色</label>
      <select id="filter-role" v-model="filters.role" class="field-input w-auto">
        <option value="">不限</option>
        <option v-for="role in eventStore.detail?.roles ?? []" :key="role.key" :value="role.key">
          {{ role.label }}
        </option>
      </select>

      <label class="text-sm text-dim" for="filter-skill">缺技能</label>
      <select id="filter-skill" v-model="filters.skill" class="field-input w-auto">
        <option value="">不限</option>
        <option
          v-for="skill in eventStore.detail?.skills ?? []"
          :key="skill.key"
          :value="skill.key"
        >
          {{ skill.label }}
        </option>
      </select>
    </div>

    <!-- list -->
    <p v-if="loading" class="mt-6 text-dim" aria-live="polite">載入中⋯</p>
    <LoadError v-else-if="loadError" class="mt-6" :kind="loadError" @retry="loadTeams" />
    <div v-else-if="teams.length" class="mt-6 grid gap-4 sm:grid-cols-2">
      <TeamCard v-for="team in teams" :key="team.id" :team="team" />
    </div>
    <EmptyState
      v-else
      class="mt-6"
      :title="`還沒有符合條件的${eventStore.termTeam}`"
      hint="調整篩選條件，或自己開一個！"
    >
      <template v-if="canCreate" #action>
        <button class="btn btn-cta" @click="showCreate = true">建立{{ eventStore.termTeam }}</button>
      </template>
    </EmptyState>
  </div>
</template>
