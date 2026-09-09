<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import RealDarkMode from './components/RealDarkMode.vue'
import {
  applyThemeClass,
  readThemePreference,
  resolveDark,
  type ThemePreference,
} from './lib/theme.js'
import { routeSlug } from './router.js'
import { useAuthStore } from './stores/auth.js'
import { useEventStore } from './stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()
const route = useRoute()

// ---- event layer (docs/design/landing-and-event-layer.md §2) ----
const slug = computed(() => routeSlug(route))
const inEventLayer = computed(() => slug.value !== null)
/** Event name shown under the brand as "where you are"; falls back while loading. */
const eventLabel = computed(() => (inEventLayer.value ? eventStore.event?.name ?? '' : ''))

// Drafts are admin-only: a 404 seen before the session was restored gets a
// second chance once we know the visitor is an admin; logging out forgets them.
watch(
  () => auth.me?.isAdmin,
  (isAdmin) => {
    if (isAdmin && eventStore.notFound && eventStore.current) void eventStore.retry(eventStore.current)
  },
)
watch(
  () => auth.isLoggedIn,
  (loggedIn) => {
    if (!loggedIn) eventStore.dropDrafts()
  },
)

// ---- dark mode toggle（第一次按是陷阱） ----
const realDark = ref(false) // the flashlight prank overlay
const isDark = ref(false) // the actual dark theme
const darkToast = ref('')
let brandClicks: number[] = []
let toastTimer: ReturnType<typeof setTimeout> | undefined
const TOAST_MS = 6000

function setTheme(pref: ThemePreference) {
  isDark.value = resolveDark(pref)
  applyThemeClass(pref)
  try {
    if (pref === null) localStorage.removeItem('tpe-theme')
    else localStorage.setItem('tpe-theme', pref)
  } catch {
    /* private mode etc. — theme just won't persist */
  }
}

function showToast(text: string, ms: number = TOAST_MS) {
  darkToast.value = text
  clearTimeout(toastTimer)
  if (text && ms) toastTimer = setTimeout(() => (darkToast.value = ''), ms)
}

function alreadyPranked(): boolean {
  try {
    return localStorage.getItem('tpe-dark-pranked') === '1'
  } catch {
    return true
  }
}

/**
 * The prank is skipped for anyone it could genuinely inconvenience:
 * reduced-motion / high-contrast users, people whose OS is already dark
 * (they want the real thing), and touch devices where the flashlight
 * only lights up under a finger.
 */
function prankIsSafe(): boolean {
  if (typeof matchMedia !== 'function') return false
  const blocked = [
    '(prefers-reduced-motion: reduce)',
    '(prefers-contrast: more)',
    '(prefers-color-scheme: dark)',
    '(pointer: coarse)',
  ].some((q) => matchMedia(q).matches)
  return !blocked
}

function toggleDark() {
  if (realDark.value) {
    // Second press: lights back on, deliver the real thing.
    realDark.value = false
    setTheme('dark')
    showToast('好啦，這才是你要的深色模式', 3500)
    return
  }
  if (isDark.value) {
    setTheme('light')
    showToast('')
    return
  }
  if (!alreadyPranked() && prankIsSafe()) {
    // First press ever: real darkness. Physically.
    try {
      localStorage.setItem('tpe-dark-pranked', '1')
    } catch {
      /* fine — they'll just get pranked again next visit */
    }
    realDark.value = true
    showToast('已啟用真・深色模式（物理）。想要普通的？再按一次。')
    return
  }
  setTheme('dark')
}

/**
 * Hidden encore: five quick clicks on the roundel summon the
 * flashlight anytime. The roundel wobbles on every click and mutters
 * at three and four — curiosity does the rest. Only the first click in
 * a burst navigates; the rest just count, so the page is not re-routed
 * home five times.
 */
const brandWobble = ref(0)
function onBrandClick(e: MouseEvent) {
  const now = Date.now()
  brandClicks = [...brandClicks.filter((t) => now - t < 3000), now]
  brandWobble.value++
  if (brandClicks.length > 1) e.preventDefault()
  if (brandClicks.length === 3) showToast('？', 1500)
  if (brandClicks.length === 4) showToast('再一下就要停電了…', 2000)
  if (brandClicks.length >= 5) {
    brandClicks = []
    realDark.value = !realDark.value
    showToast(realDark.value ? '真・深色模式——按 Esc 或再按主題鈕開燈' : '', 5000)
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && realDark.value) {
    realDark.value = false
    showToast('')
  }
}

const systemDark =
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
function onSystemThemeChange() {
  // Follow the OS only while the user has not made an explicit choice.
  if (readThemePreference() === null) setTheme(null)
}

onMounted(() => {
  auth.init()
  window.addEventListener('keydown', onKeydown)
  setTheme(readThemePreference())
  systemDark?.addEventListener('change', onSystemThemeChange)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  systemDark?.removeEventListener('change', onSystemThemeChange)
})

/** Inside an event: its pages (with slug). Outside — or on an unknown slug — back to the event list. */
const navItems = computed(() => {
  const s = eventStore.notFound ? null : slug.value
  const eventNav = s
    ? [
        { key: 'teams', to: { name: 'teams', params: { slug: s } }, label: '找團' },
        { key: 'people', to: { name: 'people', params: { slug: s } }, label: '找人' },
        { key: 'applications', to: { name: 'applications', params: { slug: s } }, label: '申請' },
      ]
    : [{ key: 'events', to: { name: 'home' }, label: '活動' }]
  return [...eventNav, { key: 'messages', to: { name: 'messages' }, label: '訊息' }]
})
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="border-b border-line bg-card">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-4">
        <RouterLink
          to="/"
          class="flex shrink-0 items-center gap-2.5 rounded-lg"
          aria-label="回到首頁"
          @click="onBrandClick"
        >
          <!-- brand roundel: the 配 character as a station mark -->
          <span
            :key="brandWobble"
            class="flex h-11 w-11 items-center justify-center rounded-full bg-primary font-brand text-xl font-bold text-on-primary"
            :class="{ 'brand-wobble': brandWobble > 0 }"
            aria-hidden="true"
          >
            配
          </span>
          <span class="hidden flex-col leading-tight sm:flex">
            <span class="font-bold">台北配</span>
            <!-- "where you are": the event name replaces the domain inside an event -->
            <span
              v-if="eventLabel"
              class="max-w-[10rem] truncate text-xs text-dim"
              data-testid="header-event-name"
              :title="eventLabel"
            >
              {{ eventLabel }}
            </span>
            <span v-else class="text-xs text-dim">配.taipei</span>
          </span>
        </RouterLink>

        <nav
          class="flex min-w-0 items-center gap-0.5 overflow-x-auto sm:gap-1 [scrollbar-width:none]"
          aria-label="主選單"
        >
          <RouterLink
            v-for="item in navItems"
            :key="item.key"
            :to="item.to"
            class="nav-link shrink-0 sm:px-3"
            active-class="nav-link-active"
          >
            {{ item.label }}
          </RouterLink>
          <RouterLink
            v-if="auth.me?.isAdmin"
            to="/admin"
            class="nav-link shrink-0 sm:px-3"
            active-class="nav-link-active"
          >
            審核
          </RouterLink>
          <button
            type="button"
            class="btn btn-quiet h-11 w-11 shrink-0 !px-0"
            :aria-pressed="isDark"
            :aria-label="
              realDark
                ? '目前為手電筒模式，再按一次切換為深色模式'
                : isDark
                  ? '切換為淺色模式'
                  : '切換為深色模式'
            "
            @click="toggleDark"
          >
            <!-- flashlight / moon / sun: inline SVG, no emoji (ADR-008) -->
            <svg
              v-if="realDark"
              class="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M6 3h12v3l-3 4v11H9V10L6 6z" />
              <path d="M6 6h12" />
              <circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none" />
            </svg>
            <svg
              v-else-if="isDark"
              class="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
            </svg>
            <svg
              v-else
              class="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          </button>
          <RouterLink
            to="/profile"
            class="btn btn-quiet shrink-0 whitespace-nowrap !px-2.5 text-sm sm:!px-3"
            active-class="!border-primary !text-primary-deep"
          >
            {{ auth.isLoggedIn ? auth.me?.displayName : '登入' }}
          </RouterLink>
        </nav>
      </div>
    </header>

    <!-- draft preview (admins only, §3): sticky so the state is never out of view -->
    <div
      v-if="inEventLayer && eventStore.preview"
      class="sticky top-0 z-30 border-b border-warn/30 bg-warn-mist text-warn"
      role="status"
    >
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-sm">
        <p>
          <strong class="font-semibold">草稿預覽</strong>
          <span class="ml-2">只有管理員看得到；開放後才會出現在活動列表。</span>
        </p>
        <RouterLink
          :to="{ name: 'admin-event-edit', params: { slug: slug! } }"
          class="inline-flex min-h-[44px] items-center font-medium underline decoration-dotted underline-offset-2"
        >
          回編輯器
        </RouterLink>
      </div>
    </div>

    <!-- archived: readable by direct link, nothing can be changed (§4) -->
    <div
      v-else-if="inEventLayer && eventStore.archived"
      class="border-b border-line bg-mist text-dim"
      role="status"
    >
      <p class="mx-auto max-w-5xl px-4 py-2 text-sm">這場活動已封存，僅供瀏覽。</p>
    </div>

    <!-- Editor-style pages (route meta `wide`) get a three-column-friendly width. -->
    <main class="mx-auto w-full flex-1 px-4 py-8" :class="route.meta.wide ? 'max-w-7xl' : 'max-w-5xl'">
      <div
        v-if="auth.sessionExpired"
        class="card mb-6 flex flex-wrap items-center justify-between gap-3 bg-warn-mist px-5 py-4 text-sm"
        role="alert"
      >
        <span class="text-warn">登入已過期，請重新登入。</span>
        <div class="flex gap-2">
          <RouterLink to="/profile" class="btn btn-primary text-sm" @click="auth.dismissSessionExpired()">
            前往登入
          </RouterLink>
          <button type="button" class="btn btn-quiet text-sm" @click="auth.dismissSessionExpired()">
            關閉
          </button>
        </div>
      </div>
      <RouterView />
    </main>

    <RealDarkMode :enabled="realDark" />
    <Transition name="fade">
      <p
        v-if="darkToast"
        class="fixed bottom-6 left-1/2 z-[1000] w-max max-w-[90vw] -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-center text-sm text-white"
        role="status"
      >
        {{ darkToast }}
      </p>
    </Transition>

    <footer class="border-t border-line bg-card">
      <div
        class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-4 text-sm text-dim"
      >
        <p class="py-2">本平台為開源專案（MIT），僅協助組隊媒合，不代為報名活動。</p>
        <nav class="flex flex-wrap gap-x-1" aria-label="政策連結">
          <RouterLink to="/privacy" class="nav-link">隱私權政策</RouterLink>
          <RouterLink to="/terms" class="nav-link">服務條款</RouterLink>
          <a
            href="https://github.com/vaso0130/taipei_TeamUp"
            target="_blank"
            rel="noopener noreferrer"
            class="nav-link"
          >
            原始碼（GitHub）↗
          </a>
        </nav>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Re-triggered on every click via :key bump. */
.brand-wobble {
  animation: brand-wobble 0.35s ease;
}
@keyframes brand-wobble {
  25% {
    transform: rotate(-12deg) scale(1.08);
  }
  60% {
    transform: rotate(9deg) scale(1.04);
  }
  100% {
    transform: rotate(0) scale(1);
  }
}
</style>
