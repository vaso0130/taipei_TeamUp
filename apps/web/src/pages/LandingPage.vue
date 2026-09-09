<script setup lang="ts">
/**
 * Landing `/`: the night MRT board (hero) and the list of events to step
 * into. Spec: docs/design/landing-and-event-layer.md §1.
 */
import { onMounted, ref } from 'vue'
import type { EventSummary } from '@teamup/shared'
import { api } from '../api/client.js'
import EventPicker from '../components/landing/EventPicker.vue'
import HeroCopy from '../components/landing/HeroCopy.vue'
import HeroMap from '../components/landing/HeroMap.vue'
import { classifyLoadError, type LoadFailure } from '../lib/errors.js'

const events = ref<EventSummary[]>([])
const loading = ref(true)
const error = ref<LoadFailure | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    events.value = (await api.listEvents()).events
  } catch (err) {
    error.value = classifyLoadError(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <!--
      Hero board: fixed ink ground in both themes (the one dark surface on
      the site). Full-bleed on phones, a rounded signboard inside the page
      column from sm up.
    -->
    <section
      class="hero-board relative -mx-4 -mt-8 flex min-h-[80vh] flex-col justify-end overflow-hidden sm:mx-0 sm:mt-0 sm:min-h-[70vh] sm:rounded-2xl"
      aria-labelledby="hero-title"
    >
      <div class="absolute inset-0">
        <HeroMap />
      </div>
      <div class="relative px-5 pb-10 pt-24 sm:px-10 sm:pb-12 sm:pt-32 lg:px-14">
        <HeroCopy />
      </div>
    </section>

    <section id="events" class="py-12 outline-none sm:py-16" aria-labelledby="events-title" tabindex="-1">
      <h2 id="events-title" class="text-2xl font-black sm:text-3xl">進行中的活動</h2>
      <p class="mt-2 text-dim">選一場進去，看看誰在找隊友</p>
      <EventPicker class="mt-8" :events="events" :loading="loading" :error="error" @retry="load" />
    </section>
  </div>
</template>

<style scoped>
.hero-board {
  background-color: #16302b;
  /* Hairline: invisible against light paper, keeps the edge in the dark theme. */
  border: 1px solid rgba(255, 255, 255, 0.08);
}
</style>
