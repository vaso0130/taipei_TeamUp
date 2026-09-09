<script setup lang="ts">
/**
 * One event as a signboard card. The whole card is the link into the event.
 * Status wording comes from the summary data alone: open → 招募中 until
 * recruitClosesAt passes (招募已截止); closed → 已結束.
 */
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { EventSummary } from '@teamup/shared'
import { formatDate, formatDateTime } from '../../lib/format.js'

const props = defineProps<{
  event: EventSummary
  /** The only open event: spans the grid and gets larger type. */
  featured?: boolean
}>()

const router = useRouter()
// The named route lands with the event-layer router change; until then the
// same path is used so the card stays navigable.
const to = computed(() =>
  router.hasRoute('event-home')
    ? { name: 'event-home', params: { slug: props.event.slug } }
    : `/e/${encodeURIComponent(props.event.slug)}`,
)

const status = computed(() => {
  if (props.event.status === 'closed') {
    return { label: '已結束', badge: 'text-dim bg-mist', bar: 'var(--color-dim)' }
  }
  if (new Date(props.event.recruitClosesAt).getTime() <= Date.now()) {
    return { label: '招募已截止', badge: 'text-dim bg-mist', bar: 'var(--color-dim)' }
  }
  return { label: '招募中', badge: 'text-ok bg-ok-mist', bar: 'var(--color-ok)' }
})

const dateRange = computed(() => {
  const start = formatDate(props.event.startsAt)
  const end = formatDate(props.event.endsAt)
  return start === end ? start : `${start} – ${end}`
})
</script>

<template>
  <RouterLink
    :to="to"
    class="card group block overflow-hidden transition-colors duration-150 hover:border-primary"
    :aria-label="`${event.name}（${status.label}）`"
  >
    <div class="h-1.5" :style="{ backgroundColor: status.bar }" aria-hidden="true"></div>
    <div :class="featured ? 'p-6 sm:p-8' : 'p-5 sm:p-6'">
      <span class="inline-block rounded-full px-2.5 py-0.5 text-xs font-medium" :class="status.badge">
        {{ status.label }}
      </span>
      <h3 class="mt-3 font-bold leading-snug" :class="featured ? 'text-2xl sm:text-3xl' : 'text-xl'">
        {{ event.name }}
      </h3>

      <!-- Featured: three columns. Regular: timetable rows so dates never wrap mid-range. -->
      <dl
        class="mt-4 font-mono text-sm"
        :class="featured ? 'grid gap-x-8 gap-y-3 sm:grid-cols-3' : 'space-y-2'"
      >
        <div :class="featured ? '' : 'flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4'">
          <dt class="shrink-0 text-xs text-dim" :class="featured ? '' : 'w-16'">活動日期</dt>
          <dd class="font-semibold" :class="featured ? 'mt-1' : ''">{{ dateRange }}</dd>
        </div>
        <div :class="featured ? '' : 'flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4'">
          <dt class="shrink-0 text-xs text-dim" :class="featured ? '' : 'w-16'">招募截止</dt>
          <dd class="font-semibold" :class="featured ? 'mt-1' : ''">
            {{ formatDateTime(event.recruitClosesAt) }}
          </dd>
        </div>
        <div v-if="featured" class="hidden sm:flex sm:items-end sm:justify-end">
          <span class="inline-flex items-center gap-1 text-sm font-medium text-primary-deep">
            進入活動
            <svg
              class="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
        </div>
      </dl>

      <span
        v-if="!featured"
        class="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary-deep"
      >
        進入活動
        <svg
          class="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
    </div>
  </RouterLink>
</template>
