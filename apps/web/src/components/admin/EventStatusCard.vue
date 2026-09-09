<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { EVENT_STATUS_TRANSITIONS, type AdminEventStats, type EventStatus } from '@teamup/shared'
import {
  EVENT_DELETE_DIALOG,
  EVENT_DELETE_LABEL,
  EVENT_REOPEN_LABEL,
  EVENT_STATUS_ACTION_LABEL,
  EVENT_STATUS_DESCRIPTION,
  EVENT_STATUS_NEXT,
  cannotDeleteHint,
  statusDialogCopy,
} from '../../lib/event-status.js'
import ModalShell from '../ModalShell.vue'
import EventStatusBadge from './EventStatusBadge.vue'

/**
 * Section ⑧: current state, what participants see, one primary next step,
 * secondary actions as text links, confirmation dialogs (ModalShell) with
 * the server-side open checklist when opening is refused. Copy lives in
 * lib/event-status.ts so the list page shows the very same words.
 */
const props = defineProps<{
  status: EventStatus
  termTeam: string
  /** Saved slug — enables the "open the public page" link (draft preview is admin-only, §3). */
  slug?: string | null
  /** Unsaved edits: status changes are blocked until saved (§6). */
  dirty: boolean
  busy: boolean
  error: string | null
  /** Items the server reported missing for draft → open. */
  openChecklist: string[] | null
  stats: AdminEventStats | null
  /** No participants and no teams — deletable in any status (ADR-035). */
  canDelete: boolean
}>()
const emit = defineEmits<{ change: [to: EventStatus]; delete: [] }>()

const next = computed(() => EVENT_STATUS_NEXT[props.status])
const primaryLabel = computed(() => EVENT_STATUS_ACTION_LABEL[props.status])

const pending = ref<EventStatus | null>(null)
const confirmingDelete = ref(false)

/** Open the confirmation for a transition (also used by the bottom bar). */
function request(to: EventStatus) {
  if (props.dirty || props.busy) return
  // Only transitions the API accepts (shared EVENT_STATUS_TRANSITIONS) get a dialog.
  if (!EVENT_STATUS_TRANSITIONS[props.status].includes(to)) return
  pending.value = to
}
defineExpose({ request })

// A successful change arrives as a new `status` prop: close the dialog.
watch(
  () => props.status,
  () => {
    pending.value = null
  },
)

const dialog = computed(() =>
  pending.value ? statusDialogCopy(props.status, pending.value, props.termTeam) : null,
)

const blockedByChecklist = computed(() => pending.value === 'open' && (props.openChecklist?.length ?? 0) > 0)

/** Public event page; a draft renders there only for admins (store fallback, §3). */
const publicHref = computed(() => (props.slug ? `/e/${encodeURIComponent(props.slug)}` : null))
const publicLinkLabel = computed(() => {
  if (props.status === 'draft') return '預覽前台'
  if (props.status === 'open' || props.status === 'closed') return '查看前台'
  return null
})

function confirm() {
  if (!pending.value || blockedByChecklist.value) return
  emit('change', pending.value)
}
</script>

<template>
  <div class="card p-5">
    <div class="flex flex-wrap items-center gap-3">
      <EventStatusBadge :status="status" size="md" />
      <p v-if="stats" class="font-mono text-sm text-dim">
        {{ termTeam }} {{ stats.teams }}・參加者 {{ stats.participants }}
      </p>
    </div>
    <p class="mt-3 text-sm">{{ EVENT_STATUS_DESCRIPTION[status] }}</p>

    <p v-if="publicHref && publicLinkLabel" class="mt-3">
      <a :href="publicHref" target="_blank" rel="noopener" class="btn btn-quiet text-sm">
        {{ publicLinkLabel }} ↗
      </a>
      <span v-if="status === 'draft'" class="ml-2 text-xs text-dim">只有登入的管理員看得到。</span>
    </p>

    <p v-if="error" class="mt-3 rounded-lg bg-danger-mist px-4 py-3 text-sm text-danger" role="alert">
      {{ error }}
    </p>

    <div v-if="next && primaryLabel" class="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        class="btn"
        :class="next === 'archived' ? 'btn-danger' : 'btn-primary'"
        :disabled="dirty || busy"
        :aria-describedby="dirty ? 'status-dirty-hint' : undefined"
        @click="request(next)"
      >
        {{ primaryLabel }}
      </button>
      <button
        v-if="status === 'closed'"
        type="button"
        class="btn btn-quiet"
        :disabled="dirty || busy"
        @click="request('open')"
      >
        {{ EVENT_REOPEN_LABEL }}
      </button>
      <p v-if="dirty" id="status-dirty-hint" class="text-sm text-warn">先儲存變更，才能變更狀態。</p>
    </div>

    <!-- delete: any status, as long as nobody has joined or formed a team (ADR-035) -->
    <div class="mt-6 border-t border-line pt-4">
      <button
        v-if="canDelete"
        type="button"
        class="inline-flex min-h-[44px] items-center text-sm text-danger underline decoration-dotted underline-offset-2"
        :disabled="busy"
        @click="confirmingDelete = true"
      >
        {{ EVENT_DELETE_LABEL }}
      </button>
      <p v-else-if="status !== 'archived'" class="text-sm text-dim">{{ cannotDeleteHint(termTeam) }}。</p>
      <p v-else class="text-sm text-dim">{{ cannotDeleteHint(termTeam) }}；已封存的活動不再提供其他動作。</p>
    </div>

    <!-- transition confirmation -->
    <ModalShell :open="pending !== null && dialog !== null" labelledby="status-dialog-title" @close="pending = null">
      <template v-if="dialog">
        <h2 id="status-dialog-title" class="text-lg font-bold">{{ dialog.title }}</h2>
        <p class="mt-2 text-sm text-dim">{{ dialog.body }}</p>
        <div
          v-if="blockedByChecklist"
          class="mt-3 rounded-lg bg-danger-mist px-4 py-3 text-sm text-danger"
          role="alert"
        >
          <p class="font-medium">開放前還缺：</p>
          <ul class="mt-1 list-disc space-y-0.5 pl-5">
            <li v-for="(item, i) in openChecklist" :key="i">{{ item }}</li>
          </ul>
          <p class="mt-2">補齊並儲存後再開放。</p>
        </div>
        <div class="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" class="btn btn-quiet" data-autofocus @click="pending = null">取消</button>
          <button
            type="button"
            class="btn"
            :class="dialog.danger ? 'btn-danger' : 'btn-primary'"
            :disabled="busy || blockedByChecklist"
            @click="confirm"
          >
            {{ busy ? '處理中⋯' : dialog.confirm }}
          </button>
        </div>
      </template>
    </ModalShell>

    <!-- delete confirmation -->
    <ModalShell :open="confirmingDelete" labelledby="delete-dialog-title" @close="confirmingDelete = false">
      <h2 id="delete-dialog-title" class="text-lg font-bold">{{ EVENT_DELETE_DIALOG.title }}</h2>
      <p class="mt-2 text-sm text-dim">{{ EVENT_DELETE_DIALOG.body }}</p>
      <div class="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" class="btn btn-quiet" data-autofocus @click="confirmingDelete = false">取消</button>
        <button type="button" class="btn btn-danger" :disabled="busy" @click="emit('delete')">
          {{ busy ? '處理中⋯' : EVENT_DELETE_DIALOG.confirm }}
        </button>
      </div>
    </ModalShell>
  </div>
</template>
