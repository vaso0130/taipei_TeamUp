<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import RealDarkMode from './components/RealDarkMode.vue'
import { useAuthStore } from './stores/auth.js'
import { useEventStore } from './stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()

// ---- easter egg: 真・深色模式（連點品牌圓標 5 下） ----
const realDark = ref(false)
const darkToast = ref(false)
let brandClicks: number[] = []
let toastTimer: ReturnType<typeof setTimeout> | undefined

function onBrandClick() {
  const now = Date.now()
  brandClicks = [...brandClicks.filter((t) => now - t < 3000), now]
  if (brandClicks.length >= 5) {
    brandClicks = []
    realDark.value = !realDark.value
    darkToast.value = realDark.value
    clearTimeout(toastTimer)
    if (realDark.value) toastTimer = setTimeout(() => (darkToast.value = false), 5000)
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && realDark.value) {
    realDark.value = false
    darkToast.value = false
  }
}

onMounted(() => {
  auth.init()
  void eventStore.ensureLoaded()
  window.addEventListener('keydown', onKeydown)
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
        class="fixed bottom-6 left-1/2 z-[1000] -translate-x-1/2 rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg"
        role="status"
      >
        🔦 真・深色模式——按 Esc 或再連點圓標 5 下開燈
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
