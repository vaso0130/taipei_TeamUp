<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { useAuthStore } from './stores/auth.js'
import { useEventStore } from './stores/event.js'

const eventStore = useEventStore()
const auth = useAuthStore()
onMounted(() => {
  auth.init()
  void eventStore.ensureLoaded()
})

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
        <RouterLink to="/" class="flex items-center gap-2.5" aria-label="回到首頁">
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

    <footer class="border-t border-line bg-card">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-dim">
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
