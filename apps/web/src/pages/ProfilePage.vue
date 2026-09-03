<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { ParticipationInput } from '@teamup/shared'
import { api, ApiError } from '../api/client.js'
import TagChip from '../components/TagChip.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const auth = useAuthStore()
const eventStore = useEventStore()
const router = useRouter()

onMounted(() => void eventStore.ensureLoaded())

// ---- data rights: export & delete (spec §6.5) ----
const exporting = ref(false)
async function exportData() {
  if (!auth.token) return
  exporting.value = true
  try {
    const data = await api.exportMe(auth.token)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'teamup-data-export.json'
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    exporting.value = false
  }
}

const deleting = ref(false)
async function deleteAccount() {
  if (!auth.token) return
  const confirmed = window.confirm(
    '確定要刪除帳號嗎？\n\n這會立即退出你目前所屬的' +
      (eventStore.termTeam ?? '隊伍') +
      '（若你是發起人，會交棒給最早加入的成員）、撤回進行中的申請，內容立即隱藏，30 天後永久刪除。',
  )
  if (!confirmed) return
  deleting.value = true
  try {
    await api.deleteMe(auth.token)
    auth.logout()
    await router.push('/')
  } finally {
    deleting.value = false
  }
}

// ---- dev login (local development only) ----
const loginEmail = ref('')
const isDevBuild = import.meta.env.DEV
/** Firebase's sign-in links come from noreply@<authDomain>. */
const mailSender = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
  ? `noreply@${import.meta.env.VITE_FIREBASE_AUTH_DOMAIN}`
  : ''

// ---- display name ----
const displayName = ref('')
watch(
  () => auth.me,
  (me) => {
    if (me) displayName.value = me.displayName
  },
  { immediate: true },
)
const savingName = ref(false)
const nameMessage = ref('')
async function saveDisplayName() {
  if (!auth.token) return
  savingName.value = true
  nameMessage.value = ''
  try {
    await api.updateMe(auth.token, displayName.value)
    await auth.fetchMe()
    nameMessage.value = '已儲存'
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    nameMessage.value =
      code === 'name_rejected'
        ? '暱稱未通過自動化篩選，請換一個'
        : code === 'moderation_unavailable'
          ? '自動化篩選暫時無法使用，請稍後再試'
          : err instanceof ApiError && err.status === 400
            ? '暱稱須為 1–30 個字'
            : '儲存失敗，請稍後再試'
  } finally {
    savingName.value = false
  }
}

// ---- per-event participation ----
const event = computed(() => eventStore.event)
const form = reactive<ParticipationInput>({
  intent: 'looking_for_team',
  preferredRoles: [],
  skills: [],
  blurb: '',
  customTags: [],
  guardianConsentConfirmed: false,
})
/** Comma/、-separated editing buffer for free-form tags. */
const customTagsText = ref('')
const blurbVisibility = ref<string | null>(null)
const loadedParticipation = ref(false)

watch(
  [() => auth.me, event],
  async ([me, e]) => {
    if (!me || !e || !auth.token || loadedParticipation.value) return
    loadedParticipation.value = true
    const existing = await api.getParticipation(auth.token, e.slug).catch(() => null)
    if (existing) {
      form.intent = existing.intent
      form.preferredRoles = [...existing.preferredRoles]
      form.skills = [...existing.skills]
      form.blurb = existing.blurb
      form.customTags = [...existing.customTags]
      customTagsText.value = existing.customTags.join('、')
      form.isAdult = existing.isAdult ?? undefined
      form.guardianConsentConfirmed = existing.guardianConsentConfirmed
      blurbVisibility.value = existing.blurbVisibility
    }
  },
  { immediate: true },
)

function toggleKey(list: string[], key: string) {
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  else list.push(key)
}

const savingForm = ref(false)
const formMessage = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
async function saveParticipation() {
  const e = event.value
  if (!auth.token || !e) return
  savingForm.value = true
  formMessage.value = null
  // Parse the tag buffer: comma (half/full width) or 、 separated.
  form.customTags = [
    ...new Set(
      customTagsText.value
        .split(/[,，、]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    ),
  ]
  try {
    const view = await api.putParticipation(auth.token, e.slug, { ...form })
    blurbVisibility.value = view.blurbVisibility
    formMessage.value = { kind: 'ok', text: '已儲存' }
  } catch (err) {
    const code = err instanceof ApiError ? err.code : ''
    formMessage.value = {
      kind: 'error',
      text:
        code === 'adult_check_required'
          ? '請先回答是否年滿 18 歲'
          : code === 'invalid_custom_tags'
            ? `自訂標籤最多 ${event.value?.maxCustomTags} 個、每個最長 ${event.value?.customTagMaxLength} 字`
            : '儲存失敗，請稍後再試',
    }
  } finally {
    savingForm.value = false
  }
}

const intentOptions = computed(() => {
  const termTeam = event.value?.termTeam ?? '隊伍'
  return [
    { value: 'looking_for_team', label: `我想找${termTeam}`, hint: '會出現在「找人」列表' },
    { value: 'has_team', label: `我已有${termTeam}`, hint: '' },
    { value: 'browsing', label: '先看看', hint: '' },
  ] as const
})
</script>

<template>
  <div class="space-y-5">
    <!-- not logged in -->
    <section v-if="!auth.isLoggedIn" class="card p-6" aria-labelledby="login-title">
      <h1 id="login-title" class="text-xl font-black">登入</h1>
      <p v-if="auth.error" class="mt-3 rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn" role="alert">
        {{ auth.error }}
      </p>
      <!-- 個資法第 8 條告知：直接呈現在登入處，不只藏在連結裡 -->
      <div class="mt-4 rounded-lg bg-mist p-4 text-sm text-dim">
        <p>
          登入即建立帳號。我們只蒐集你的 <strong>Email</strong>（加密儲存，用於登入）與你自訂的暱稱；
          不蒐集真名、電話與生日。你發布的內容會經過自動化風險檢測。
          你可隨時在本頁匯出或刪除你的資料。詳見
          <RouterLink to="/privacy" class="font-medium text-primary-deep underline">隱私權政策</RouterLink>。
          不提供 Email 將無法使用本服務。
        </p>
      </div>
      <template v-if="auth.usesFirebase">
        <div class="mt-4 flex flex-col gap-3 sm:max-w-md">
          <button type="button" class="btn btn-primary" @click="auth.loginWithGoogle()">
            使用 Google 帳號登入
          </button>
          <div class="flex items-center gap-3 text-xs text-dim" aria-hidden="true">
            <span class="h-px flex-1 bg-line"></span>
            或
            <span class="h-px flex-1 bg-line"></span>
          </div>
          <form class="flex flex-wrap gap-2" @submit.prevent="auth.sendEmailLink(loginEmail)">
            <label class="sr-only" for="login-email">Email</label>
            <input
              id="login-email"
              v-model="loginEmail"
              type="email"
              required
              placeholder="you@example.com"
              class="field-input flex-1"
            />
            <button type="submit" class="btn btn-quiet">寄送登入連結</button>
          </form>
          <p v-if="auth.emailLinkSent" class="rounded-lg bg-ok-mist px-4 py-3 text-sm text-ok" role="status">
            登入連結已寄出。若收件匣沒看到，請檢查<strong>垃圾郵件</strong>
            <template v-if="mailSender">（寄件者為 {{ mailSender }}）</template>，並將其標示為非垃圾郵件。
          </p>
        </div>
      </template>
      <template v-else-if="isDevBuild">
        <p class="mt-3 text-sm text-dim">
          本機開發模式：輸入任一 Email 即可登入（後端 <code class="font-mono">AUTH_PROVIDER=dev</code>）。
          正式環境將使用 Google 登入與 Email 連結登入。
        </p>
        <form class="mt-4 flex max-w-md flex-wrap gap-2" @submit.prevent="auth.devLogin(loginEmail)">
          <label class="sr-only" for="login-email">Email</label>
          <input
            id="login-email"
            v-model="loginEmail"
            type="email"
            required
            placeholder="you@example.com"
            class="field-input flex-1"
          />
          <button type="submit" class="btn btn-primary">登入</button>
        </form>
      </template>
      <p v-else class="mt-3 text-dim">登入功能即將開放。</p>
    </section>

    <!-- logged in -->
    <template v-else>
      <section class="card p-6" aria-labelledby="account-title">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 id="account-title" class="text-xl font-black">我的帳號</h1>
            <p class="mt-1 font-mono text-sm text-dim">{{ auth.me?.emailHint }}</p>
          </div>
          <button class="btn btn-quiet !min-h-[40px] text-sm" @click="auth.logout()">登出</button>
        </div>
        <div class="mt-4 flex max-w-md flex-wrap items-end gap-2">
          <div class="flex-1">
            <label class="field-label" for="display-name">暱稱</label>
            <input id="display-name" v-model="displayName" maxlength="30" class="field-input" />
          </div>
          <button class="btn btn-primary" :disabled="savingName" @click="saveDisplayName">儲存</button>
        </div>
        <p v-if="nameMessage" class="field-hint" role="status">{{ nameMessage }}</p>
        <p class="field-hint">用暱稱就好，不需要真名。儲存時會經過自動化篩選確認合規（約需數秒）。</p>

        <div class="mt-6 flex flex-wrap gap-3 border-t border-line pt-4">
          <button class="btn btn-quiet !min-h-[40px] text-sm" :disabled="exporting" @click="exportData">
            {{ exporting ? '匯出中⋯' : '匯出我的資料（JSON）' }}
          </button>
          <button class="btn btn-danger !min-h-[40px] text-sm" :disabled="deleting" @click="deleteAccount">
            刪除帳號
          </button>
        </div>
      </section>

      <section v-if="event" class="card p-6" aria-labelledby="participation-title">
        <h2 id="participation-title" class="font-bold">我在「{{ event.name }}」</h2>

        <fieldset class="mt-4">
          <legend class="field-label">狀態</legend>
          <div class="flex flex-wrap gap-2">
            <label
              v-for="opt in intentOptions"
              :key="opt.value"
              class="chip chip-selectable !py-2"
              :class="{ 'chip-selected': form.intent === opt.value }"
            >
              <input v-model="form.intent" type="radio" class="sr-only" :value="opt.value" />
              {{ opt.label }}
            </label>
          </div>
          <p class="field-hint">
            {{ intentOptions.find((o) => o.value === form.intent)?.hint ?? '' }}
          </p>
        </fieldset>

        <fieldset v-if="eventStore.detail?.roles.length" class="mt-4">
          <legend class="field-label">偏好角色</legend>
          <div class="flex flex-wrap gap-2">
            <TagChip
              v-for="role in eventStore.detail.roles"
              :key="role.key"
              :label="role.label"
              selectable
              :selected="form.preferredRoles.includes(role.key)"
              @toggle="toggleKey(form.preferredRoles, role.key)"
            />
          </div>
        </fieldset>

        <fieldset v-for="group in eventStore.skillGroups" :key="group.category" class="mt-4">
          <legend class="field-label">{{ group.category }}</legend>
          <div class="flex flex-wrap gap-2">
            <TagChip
              v-for="skill in group.skills"
              :key="skill.key"
              :label="skill.label"
              :dot="group.color"
              selectable
              :selected="form.skills.includes(skill.key)"
              @toggle="toggleKey(form.skills, skill.key)"
            />
          </div>
        </fieldset>

        <div class="mt-4">
          <label class="field-label" for="blurb">
            自我介紹
            <span
              v-if="blurbVisibility === 'pending_review'"
              class="ml-2 rounded-full bg-warn-mist px-2 py-0.5 text-xs font-normal text-warn"
            >
              審核中
            </span>
            <span
              v-else-if="blurbVisibility === 'blocked'"
              class="ml-2 rounded-full bg-danger-mist px-2 py-0.5 text-xs font-normal text-danger"
            >
              未通過審核
            </span>
          </label>
          <textarea
            id="blurb"
            v-model="form.blurb"
            rows="3"
            maxlength="500"
            class="field-input"
            aria-describedby="blurb-hint"
            placeholder="介紹一下自己，讓別人知道你想做什麼"
          ></textarea>
          <p id="blurb-hint" class="field-hint">發布前會經過自動化風險檢測，通過後才公開。</p>

          <template v-if="(event?.maxCustomTags ?? 0) > 0">
            <label class="field-label mt-4" for="custom-tags">
              自訂技能標籤（選填）
            </label>
            <input
              id="custom-tags"
              v-model="customTagsText"
              class="field-input"
              type="text"
              :placeholder="'例如：Rust、Godot、手語（最多 ' + event!.maxCustomTags + ' 個，以逗號或頓號分隔）'"
              aria-describedby="custom-tags-hint"
            />
            <p id="custom-tags-hint" class="field-hint">
              字典裡沒有的技能可以自己加，最多 {{ event!.maxCustomTags }} 個、每個
              {{ event!.customTagMaxLength }} 字內；與自介一併通過風險檢測後公開。
            </p>
          </template>
        </div>

        <fieldset v-if="event.requiresAdultCheck" class="mt-4">
          <legend class="field-label">你是否年滿 18 歲？</legend>
          <div class="flex gap-2">
            <label class="chip chip-selectable !py-2" :class="{ 'chip-selected': form.isAdult === true }">
              <input v-model="form.isAdult" type="radio" class="sr-only" :value="true" /> 是
            </label>
            <label class="chip chip-selectable !py-2" :class="{ 'chip-selected': form.isAdult === false }">
              <input v-model="form.isAdult" type="radio" class="sr-only" :value="false" /> 否
            </label>
          </div>
          <div v-if="form.isAdult === false" class="mt-3 rounded-lg bg-warn-mist px-4 py-3 text-sm text-warn">
            <p>報名活動時需檢附法定代理人書面同意書，由活動主辦單位收取；本平台不收也不儲存同意書。</p>
            <label class="mt-2 flex items-center gap-2">
              <input v-model="form.guardianConsentConfirmed" type="checkbox" />
              我確認已取得法定代理人同意
            </label>
          </div>
        </fieldset>

        <p
          v-if="formMessage"
          class="mt-4 text-sm"
          :class="formMessage.kind === 'ok' ? 'text-ok' : 'text-danger'"
          role="status"
        >
          {{ formMessage.text }}
        </p>
        <button class="btn btn-primary mt-4" :disabled="savingForm" @click="saveParticipation">
          {{ savingForm ? '儲存中⋯' : '儲存檔案' }}
        </button>
      </section>
    </template>
  </div>
</template>
