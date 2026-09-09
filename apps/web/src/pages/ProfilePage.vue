<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { api, ApiError } from '../api/client.js'
import { describeApiError } from '../lib/errors.js'
import { ENV_EVENT_SLUG, legacyEventSlug, preferredEventSlug } from '../lib/event-routes.js'
import { emailToUnicode } from '../lib/punycode.js'
import LoadError from '../components/LoadError.vue'
import ParticipationForm from '../components/ParticipationForm.vue'
import { useAuthStore } from '../stores/auth.js'
import { useEventStore } from '../stores/event.js'

const auth = useAuthStore()
const eventStore = useEventStore()
const router = useRouter()
const route = useRoute()

onMounted(() => {
  void eventStore.ensureSummaries()
  // The login page is where a returning Firebase session is worth restoring.
  if (auth.usesFirebase) void auth.ensureFirebase()
})

const errorCtx = () => ({ termTeam: eventStore.termTeam, termMember: eventStore.termMember })

/**
 * Arrived from a "create team" CTA while signed out: explain, then continue
 * after login. The CTA carries its event (`?event=`); a bare `?next=` (old
 * links) falls back to the legacy rule — build-time slug, else the sole
 * open event, else the event list.
 */
const nextIsCreateTeam = computed(() => route.query.next === 'create-team')
async function continueToCreateTeam() {
  const fromQuery = typeof route.query.event === 'string' ? route.query.event : null
  const slug = fromQuery ?? legacyEventSlug(ENV_EVENT_SLUG, await eventStore.ensureSummaries())
  if (slug) await router.replace({ name: 'teams', params: { slug }, query: { create: '1' } })
  else await router.replace({ name: 'home' })
}
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (loggedIn && nextIsCreateTeam.value) void continueToCreateTeam()
  },
  { immediate: true },
)

// ---- per-event participation (§5): one section per open event ----
const openEvents = computed(() => eventStore.openEvents)
const summariesReady = computed(() => eventStore.summaries !== null)
/** Expanded by default: the event the visitor came from, else the build-time default, else the first. */
const defaultOpenSlug = computed(() =>
  preferredEventSlug(eventStore.current, ENV_EVENT_SLUG, openEvents.value),
)
const sectionId = (slug: string) => `participation-title-${slug}`

// ---- data rights: export & delete (spec §6.5) ----
const exporting = ref(false)
const accountMessage = ref('')
async function exportData() {
  if (!auth.token) return
  exporting.value = true
  accountMessage.value = ''
  try {
    const data = await api.exportMe(auth.getToken)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'teamup-data-export.json'
    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    accountMessage.value = describeApiError(err, errorCtx(), '匯出失敗，請稍後再試')
  } finally {
    exporting.value = false
  }
}

const deleting = ref(false)
async function deleteAccount() {
  if (!auth.token) return
  const confirmed = window.confirm(
    `確定要刪除帳號嗎？\n\n這會立即退出你目前所屬的${eventStore.termTeam}` +
      `（若你是發起人，會交棒給最早加入的${eventStore.termMember}）、撤回進行中的申請，` +
      '內容立即隱藏，30 天後永久刪除。之後以同一 Email 再登入會建立全新的空白帳號。',
  )
  if (!confirmed) return
  deleting.value = true
  accountMessage.value = ''
  try {
    await api.deleteMe(auth.getToken)
    auth.logout()
    await router.push('/')
  } catch (err) {
    accountMessage.value = describeApiError(err, errorCtx(), '刪除失敗，請稍後再試')
  } finally {
    deleting.value = false
  }
}

// ---- dev login (local development only) ----
const loginEmail = ref('')
const isDevBuild = import.meta.env.DEV
/**
 * Sign-in links come from noreply@<authDomain> by default; a verified
 * custom sending domain overrides it via VITE_MAIL_SENDER. A punycode
 * domain (xn--…) is shown alongside its Unicode form so it does not read
 * like phishing; VITE_MAIL_SENDER_DISPLAY overrides the readable form.
 */
const mailSender =
  import.meta.env.VITE_MAIL_SENDER ||
  (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
    ? `noreply@${import.meta.env.VITE_FIREBASE_AUTH_DOMAIN}`
    : '')
const mailSenderDisplay = import.meta.env.VITE_MAIL_SENDER_DISPLAY || emailToUnicode(mailSender)
const mailSenderHint = computed(() => {
  if (!mailSender) return ''
  return mailSenderDisplay !== mailSender
    ? `${mailSenderDisplay}（實際地址 ${mailSender}）`
    : mailSender
})

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
    await api.updateMe(auth.getToken, displayName.value)
    await auth.fetchMe()
    nameMessage.value = '已儲存'
  } catch (err) {
    nameMessage.value = describeApiError(err, errorCtx(), '儲存失敗，請稍後再試', {
      name_rejected: '暱稱未通過自動化篩選，請換一個',
      validation_failed: '暱稱須為 1–30 個字',
    })
    if (err instanceof ApiError && err.status === 400 && err.code !== 'validation_failed') {
      nameMessage.value = '暱稱須為 1–30 個字'
    }
  } finally {
    savingName.value = false
  }
}

</script>

<template>
  <div class="space-y-5">
    <!-- not logged in -->
    <section v-if="!auth.isLoggedIn" class="card p-6" aria-labelledby="login-title">
      <h1 id="login-title" class="text-xl font-black">登入</h1>
      <p
        v-if="nextIsCreateTeam"
        class="mt-3 rounded-lg bg-primary-mist px-4 py-3 text-sm text-primary-deep"
        role="status"
      >
        登入後即可建立{{ eventStore.termTeam }}，登入完成會直接帶你到建立表單。
      </p>
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
          <form class="flex flex-col gap-2 sm:flex-row" @submit.prevent="auth.sendEmailLink(loginEmail)">
            <label class="sr-only" for="login-email">Email</label>
            <input
              id="login-email"
              v-model="loginEmail"
              type="email"
              required
              autocomplete="email"
              placeholder="you@example.com"
              class="field-input min-w-0 flex-1"
            />
            <button type="submit" class="btn btn-quiet shrink-0">寄送登入連結</button>
          </form>
          <p v-if="auth.emailLinkSent" class="rounded-lg bg-ok-mist px-4 py-3 text-sm text-ok" role="status">
            登入連結已寄出。若收件匣沒看到，請檢查<strong>垃圾郵件</strong>
            <template v-if="mailSenderHint">（寄件者為 {{ mailSenderHint }}）</template>，並將其標示為非垃圾郵件。
          </p>
        </div>
      </template>
      <template v-else-if="isDevBuild">
        <p class="mt-3 text-sm text-dim">
          本機開發模式：輸入任一 Email 即可登入（後端 <code class="font-mono">AUTH_PROVIDER=dev</code>）。
          正式環境將使用 Google 登入與 Email 連結登入。
        </p>
        <form class="mt-4 flex max-w-md flex-col gap-2 sm:flex-row" @submit.prevent="auth.devLogin(loginEmail)">
          <label class="sr-only" for="login-email">Email</label>
          <input
            id="login-email"
            v-model="loginEmail"
            type="email"
            required
            autocomplete="email"
            placeholder="you@example.com"
            class="field-input min-w-0 flex-1"
          />
          <button type="submit" class="btn btn-primary shrink-0">登入</button>
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
          <button class="btn btn-quiet text-sm" @click="auth.logout()">登出</button>
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
          <button class="btn btn-quiet text-sm" :disabled="exporting" @click="exportData">
            {{ exporting ? '匯出中⋯' : '匯出我的資料（JSON）' }}
          </button>
          <button class="btn btn-danger text-sm" :disabled="deleting" @click="deleteAccount">
            {{ deleting ? '刪除中⋯' : '刪除帳號' }}
          </button>
        </div>
        <p v-if="accountMessage" class="field-error" role="alert">{{ accountMessage }}</p>
      </section>

      <!-- participation: one collapsible section per open event (§5) -->
      <LoadError
        v-if="eventStore.summariesError && !summariesReady"
        :kind="eventStore.summariesError"
        title="活動列表載入失敗"
        @retry="eventStore.ensureSummaries()"
      />
      <p v-else-if="!summariesReady" class="text-sm text-dim" aria-live="polite">載入活動⋯</p>
      <section v-else-if="openEvents.length === 0" class="card p-6" aria-labelledby="no-events-title">
        <h2 id="no-events-title" class="font-bold">參加資料</h2>
        <p class="mt-2 text-sm text-dim">
          目前沒有進行中的活動。有活動開放招募時，這裡會出現每場活動的參加資料表單。
        </p>
      </section>
      <template v-else>
        <section
          v-for="e in openEvents"
          :key="e.slug"
          class="card"
          :aria-labelledby="sectionId(e.slug)"
        >
        <details :open="e.slug === defaultOpenSlug" class="group p-6">
          <summary class="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <h2 :id="sectionId(e.slug)" class="font-bold">我在「{{ e.name }}」</h2>
            <span class="flex items-center gap-2 text-xs text-dim">
              <RouterLink
                :to="{ name: 'event-home', params: { slug: e.slug } }"
                class="inline-flex min-h-[44px] items-center underline decoration-dotted underline-offset-2 hover:text-ink"
              >
                前往活動
              </RouterLink>
              <svg
                class="h-4 w-4 transition-transform group-open:rotate-180"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </summary>
          <ParticipationForm :slug="e.slug" />
        </details>
        </section>
      </template>
    </template>
  </div>
</template>
