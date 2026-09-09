<script setup lang="ts">
/**
 * Event list under the hero (docs/design/landing-and-event-layer.md §1).
 * Open events sorted by recruiting deadline (soonest first); closed ones
 * collapsed, most recently ended first; archived never shown. A single open
 * event still renders as a list — the visitor is meant to step in — just
 * at full width.
 */
import { computed, ref } from 'vue'
import type { EventSummary } from '@teamup/shared'
import EmptyState from '../EmptyState.vue'
import LoadError from '../LoadError.vue'
import type { LoadFailure } from '../../lib/errors.js'
import EventCard from './EventCard.vue'

const props = defineProps<{
  events: EventSummary[]
  loading?: boolean
  error?: LoadFailure | null
}>()
const emit = defineEmits<{ retry: [] }>()

const time = (iso: string) => new Date(iso).getTime()

const open = computed(() =>
  props.events
    .filter((e) => e.status === 'open')
    .sort((a, b) => time(a.recruitClosesAt) - time(b.recruitClosesAt)),
)
const closed = computed(() =>
  props.events.filter((e) => e.status === 'closed').sort((a, b) => time(b.endsAt) - time(a.endsAt)),
)
const closedShown = ref(false)
</script>

<template>
  <div>
    <!-- loading: two card-shaped placeholders -->
    <div v-if="loading" class="grid gap-4 sm:grid-cols-2" aria-busy="true" aria-live="polite">
      <span class="sr-only">載入活動中</span>
      <div v-for="i in 2" :key="i" class="card animate-pulse overflow-hidden" aria-hidden="true">
        <div class="h-1.5 bg-line"></div>
        <div class="space-y-3 p-5 sm:p-6">
          <div class="h-5 w-16 rounded-full bg-mist"></div>
          <div class="h-6 w-2/3 rounded bg-mist"></div>
          <div class="grid gap-3 pt-2 sm:grid-cols-2">
            <div class="h-10 rounded bg-mist"></div>
            <div class="h-10 rounded bg-mist"></div>
          </div>
        </div>
      </div>
    </div>

    <LoadError v-else-if="error" :kind="error" @retry="emit('retry')" />

    <template v-else>
      <ul v-if="open.length" class="grid gap-4 sm:grid-cols-2">
        <li v-for="e in open" :key="e.slug" :class="{ 'sm:col-span-2': open.length === 1 }">
          <EventCard :event="e" :featured="open.length === 1" />
        </li>
      </ul>
      <EmptyState
        v-else
        title="目前沒有進行中的活動"
        hint="新的活動開放招募後會出現在這裡。"
      />

      <section v-if="closed.length" class="mt-8">
        <h3 class="sr-only">已結束的活動</h3>
        <button
          type="button"
          class="closed-toggle"
          :aria-expanded="closedShown"
          aria-controls="closed-events"
          @click="closedShown = !closedShown"
        >
          <svg
            class="h-4 w-4 shrink-0 transition-transform duration-150"
            :class="{ 'rotate-90': closedShown }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          已結束的活動（{{ closed.length }}）
        </button>
        <ul v-show="closedShown" id="closed-events" class="mt-4 grid gap-4 sm:grid-cols-2">
          <li v-for="e in closed" :key="e.slug">
            <EventCard :event="e" />
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.closed-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  padding: 0 0.75rem 0 0.5rem;
  border-radius: 0.5rem;
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--color-dim);
  cursor: pointer;
  transition: color 150ms ease;
}
.closed-toggle:hover {
  color: var(--color-ink);
}
</style>
