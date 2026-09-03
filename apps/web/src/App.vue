<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import RealDarkMode from './components/RealDarkMode.vue'
import { useAuthStore } from './stores/auth.js'
import { useEventStore } from './stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()

// ---- dark mode toggle（第一次按是陷阱） ----
const realDark = ref(false) // the flashlight prank overlay
const isDark = ref(false) // the actual dark theme
const darkToast = ref('')
let brandClicks: number[] = []
let toastTimer: ReturnType<typeof setTimeout> | undefined

function applyTheme(dark: boolean) {
  isDark.value = dark
  document.documentElement.classList.toggle('dark', dark)
  try {
    localStorage.setItem('tpe-theme', dark ? 'dark' : 'light')
  } catch {
    /* private mode etc. — theme just won't persist */
  }
}

function showToast(text: string, ms?: number) {
  darkToast.value = text
  clearTimeout(toastTimer)
  if (ms) toastTimer = setTimeout(() => (darkToast.value = ''), ms)
}

function alreadyPranked(): boolean {
  try {
    return localStorage.getItem('tpe-dark-pranked') === '1'
  } catch {
    return true
  }
}

function toggleDark() {
  if (realDark.value) {
    // Second press: lights back on, deliver the real thing.
    realDark.value = false
    applyTheme(true)
    showToast('好啦，這才是你要的深色模式 🌙', 3500)
    return
  }
  if (isDark.value) {
    applyTheme(false)
    showToast('')
    return
  }
  if (!alreadyPranked()) {
    // First press ever: real darkness. Physically.
    try {
      localStorage.setItem('tpe-dark-pranked', '1')
    } catch {
      /* fine — they'll just get pranked again next visit */
    }
    realDark.value = true
    showToast('🔦 已啟用真・深色模式（物理）。想要普通的？再按一次。')
    return
  }
  applyTheme(true)
}

/** Hidden encore: five quick clicks on the roundel summon the flashlight anytime. */
function onBrandClick() {
  const now = Date.now()
  brandClicks = [...brandClicks.filter((t) => now - t < 3000), now]
  if (brandClicks.length >= 5) {
    brandClicks = []
    realDark.value = !realDark.value
    showToast(realDark.value ? '🔦 真・深色模式——按 Esc 開燈' : '', 5000)
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && realDark.value) {
    realDark.value = false
    showToast('')
  }
}

onMounted(() => {
  auth.init()
  void eventStore.ensureLoaded()
  window.addEventListener('keydown', onKeydown)
  try {
    if (localStorage.getItem('tpe-theme') === 'dark') applyTheme(true)
  } catch {
    /* default light */
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const navItems = [
  { to: '/teams', label: '找團' },
  { to: '/people', label: '找人' },
  { to: '/applications', label: '申請' },
  { to: '/messages', label: '訊息' },
]
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <header class="border-b border-line bg-card">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <RouterLink to="/" class="flex items-center gap-2.5" aria-label="回到首頁" @click="onBrandClick">
          <!-- brand roundel: the 配 character as a station mark -->
          <span
            class="flex h-9 w-9 items-center justify-center rounded-full bg-primary font-brand text-lg font-bold text-white"
            aria-hidden="true"
          >
            配
          </span>
          <span class="hidden flex-col leading-tight sm:flex">
            <span class="font-bold">台北配</span>
            <span class="text-xs text-dim">配.taipei</span>
          </span>
        </RouterLink>

        <nav class="flex items-center gap-1 sm:gap-2" aria-label="主選單">
          <RouterLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="rounded-lg px-3 py-2 text-sm font-medium text-dim transition-colors duration-150 hover:text-ink"
            active-class="!text-primary-deep bg-primary-mist"
          >
            {{ item.label }}
          </RouterLink>
          <RouterLink
            v-if="auth.me?.isAdmin"
            to="/admin"
            class="rounded-lg px-3 py-2 text-sm font-medium text-dim transition-colors duration-150 hover:text-ink"
            active-class="!text-primary-deep bg-primary-mist"
          >
            審核
          </RouterLink>
          <button
            class="btn btn-quiet !min-h-[40px] !px-3 text-base"
            :aria-pressed="isDark"
            :aria-label="isDark ? '切換為淺色模式' : '切換為深色模式'"
            :title="isDark ? '切換為淺色模式' : '切換為深色模式'"
            @click="toggleDark"
          >
            {{ realDark ? '🔦' : isDark ? '🌙' : '☀️' }}
          </button>
          <RouterLink
            to="/profile"
            class="btn btn-quiet ml-1 !min-h-[40px] !px-3 text-sm"
            active-class="!border-primary !text-primary-deep"
          >
            {{ auth.isLoggedIn ? auth.me?.displayName : '登入' }}
          </RouterLink>
        </nav>
      </div>
    </header>

    <main class="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
      <RouterView />
    </main>

    <RealDarkMode :enabled="realDark" />
    <Transition name="fade">
      <p
        v-if="darkToast"
        class="fixed bottom-6 left-1/2 z-[1000] w-max max-w-[90vw] -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-center text-sm text-white shadow-lg"
        role="status"
      >
        {{ darkToast }}
      </p>
    </Transition>

    <footer class="border-t border-line bg-card">
      <div
        class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-dim"
      >
        <p>本平台為開源專案（MIT），僅協助組隊媒合，不代為報名活動。</p>
        <nav class="flex gap-4" aria-label="政策連結">
          <RouterLink to="/privacy" class="hover:text-ink">隱私權政策</RouterLink>
          <RouterLink to="/terms" class="hover:text-ink">服務條款</RouterLink>
          <a
            href="https://github.com/vaso0130/taipei_TeamUp"
            target="_blank"
            rel="noopener noreferrer"
            class="hover:text-ink"
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
</style>
