<script setup lang="ts">
/**
 * `/events`: the list of events to step into, reached from the landing
 * board's CTA (docs/design/landing-and-event-layer.md §1 「活動列表」).
 */
import { onMounted, ref } from 'vue'
import type { EventSummary } from '@teamup/shared'
import { api } from '../api/client.js'
import EventPicker from '../components/landing/EventPicker.vue'
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
  <section aria-labelledby="events-title">
    <p class="eyebrow">下一站</p>
    <h1 id="events-title" class="mt-2 text-3xl font-black sm:text-4xl">進行中的活動</h1>
    <p class="mt-2 text-dim">選一場進去，看看誰在找隊友。</p>
    <EventPicker class="mt-8" :events="events" :loading="loading" :error="error" @retry="load" />
  </section>
</template>
