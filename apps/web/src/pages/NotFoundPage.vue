<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { useEventStore } from '../stores/event.js'

/**
 * 404 — also rendered by the event home for an unknown slug. The "back to
 * teams" shortcut only makes sense when we know which event the visitor
 * was in (and it actually loaded).
 */
const eventStore = useEventStore()
</script>

<template>
  <section class="card mx-auto max-w-lg px-6 py-12 text-center" aria-labelledby="not-found-title">
    <p class="eyebrow">404</p>
    <h1 id="not-found-title" class="mt-3 text-2xl font-black">找不到這個頁面</h1>
    <p class="mt-3 text-sm text-dim">
      這個網址不存在，可能是連結打錯了，或是頁面已經移除。
    </p>
    <div class="mt-6 flex flex-wrap justify-center gap-3">
      <RouterLink to="/" class="btn btn-primary">回首頁</RouterLink>
      <RouterLink
        v-if="eventStore.current && eventStore.detail"
        :to="{ name: 'teams', params: { slug: eventStore.current } }"
        class="btn btn-quiet"
      >
        找{{ eventStore.termTeam }}
      </RouterLink>
    </div>
  </section>
</template>
