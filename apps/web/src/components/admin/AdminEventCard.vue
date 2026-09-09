<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { AdminEventSummary, EventStatus } from '@teamup/shared'
import {
  EVENT_DELETE_LABEL,
  EVENT_REOPEN_LABEL,
  EVENT_STATUS_ACTION_LABEL,
  EVENT_STATUS_BAR,
  EVENT_STATUS_NEXT,
  cannotDeleteHint,
} from '../../lib/event-status.js'
import { formatDate, formatDateTime } from '../../lib/format.js'
import EventStatusBadge from './EventStatusBadge.vue'

/**
 * One row of the admin event list (docs/design/admin-events.md §2). Besides
 * edit / copy / export it offers the one status action the state machine
 * allows next (plus 重新開放招募 for closed events) and 刪除活動 — enabled only
 * while the event has no participants and no teams (ADR-035). The parent
 * owns confirmation dialogs and API calls; this card only emits intents.
 */
const props = defineProps<{
  event: AdminEventSummary
  /** A request for this card is in flight — disables every action. */
  busy: boolean
  /** JSON export in flight for this card. */
  exporting: boolean
}>()
const emit = defineEmits<{
  status: [to: EventStatus]
  delete: []
  export: []
}>()

const next = computed(() => EVENT_STATUS_NEXT[props.event.status])
const nextLabel = computed(() => EVENT_STATUS_ACTION_LABEL[props.event.status])
const isEmpty = computed(() => props.event.counts.teams === 0 && props.event.counts.participants === 0)
const deleteHintId = computed(() => `no-delete-${props.event.slug}`)
</script>

<template>
  <li class="card overflow-hidden" :class="{ 'opacity-80': event.status === 'archived' }">
    <div class="h-1.5" :style="{ backgroundColor: EVENT_STATUS_BAR[event.status] }" aria-hidden="true"></div>
    <div class="p-5">
      <div class="flex flex-wrap items-center gap-2">
        <EventStatusBadge :status="event.status" />
        <h2 class="text-lg font-bold">{{ event.name || '未命名活動' }}</h2>
      </div>
      <p class="mt-1 font-mono text-xs text-dim">{{ event.slug }}</p>

      <dl class="mt-4 grid gap-x-8 gap-y-3 font-mono text-sm sm:grid-cols-3">
        <div>
          <dt class="text-xs text-dim">活動日期</dt>
          <dd class="mt-0.5 font-semibold">{{ formatDate(event.startsAt) }} – {{ formatDate(event.endsAt) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-dim">招募截止</dt>
          <dd class="mt-0.5 font-semibold">{{ formatDateTime(event.recruitClosesAt) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-dim">規模</dt>
          <dd class="mt-0.5 font-semibold">
            {{ event.termTeam }} {{ event.counts.teams }}・參加者 {{ event.counts.participants }}
          </dd>
        </div>
      </dl>

      <!-- two rows: navigation/export first, lifecycle second; both wrap freely on narrow screens -->
      <div class="mt-4 flex flex-wrap gap-2">
        <RouterLink
          :to="{ name: 'admin-event-edit', params: { slug: event.slug } }"
          class="btn"
          :class="event.status === 'archived' ? 'btn-quiet' : 'btn-primary'"
        >
          {{ event.status === 'archived' ? '檢視' : '編輯' }}
        </RouterLink>
        <RouterLink
          :to="{ name: 'admin-event-new', query: { start: 'copy', slug: event.slug } }"
          class="btn btn-quiet"
        >
          複製為新活動
        </RouterLink>
        <button type="button" class="btn btn-quiet" :disabled="exporting || busy" @click="emit('export')">
          {{ exporting ? '匯出中⋯' : '匯出 JSON' }}
        </button>
      </div>

      <!-- archived events have no next step; the row stays only while a delete is still possible -->
      <div v-if="next || isEmpty" class="mt-2 flex flex-wrap items-center gap-2">
        <button
          v-if="next && nextLabel"
          type="button"
          class="btn"
          :class="next === 'archived' ? 'btn-danger' : 'btn-cta'"
          :disabled="busy"
          @click="emit('status', next)"
        >
          {{ nextLabel }}
        </button>
        <button
          v-if="event.status === 'closed'"
          type="button"
          class="btn btn-quiet"
          :disabled="busy"
          @click="emit('status', 'open')"
        >
          {{ EVENT_REOPEN_LABEL }}
        </button>

        <button
          v-if="isEmpty"
          type="button"
          class="btn btn-danger"
          :disabled="busy"
          @click="emit('delete')"
        >
          {{ EVENT_DELETE_LABEL }}
        </button>
        <!-- disabled buttons swallow hover in some browsers: the tooltip sits on the wrapper -->
        <span v-else class="inline-block" :title="cannotDeleteHint(event.termTeam)">
          <button type="button" class="btn btn-danger" disabled :aria-describedby="deleteHintId">
            {{ EVENT_DELETE_LABEL }}
          </button>
          <span :id="deleteHintId" class="sr-only">{{ cannotDeleteHint(event.termTeam) }}</span>
        </span>
      </div>
    </div>
  </li>
</template>
