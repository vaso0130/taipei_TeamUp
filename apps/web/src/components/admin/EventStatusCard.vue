<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { EVENT_STATUS_TRANSITIONS, type AdminEventStats, type EventStatus } from '@teamup/shared'
import {
  EVENT_STATUS_ACTION_LABEL,
  EVENT_STATUS_LABEL,
  EVENT_STATUS_NEXT,
} from '../../lib/event-status.js'
import ModalShell from '../ModalShell.vue'
import EventStatusBadge from './EventStatusBadge.vue'

/**
 * Section ⑧: current state, what participants see, one primary next step,
 * secondary actions as text links, confirmation dialogs (ModalShell) with
 * the server-side open checklist when opening is refused.
 */
const props = defineProps<{
  status: EventStatus
  termTeam: string
  /** Unsaved edits: status changes are blocked until saved (§6). */
  dirty: boolean
  busy: boolean
  error: string | null
  /** Items the server reported missing for draft → open. */
  openChecklist: string[] | null
  stats: AdminEventStats | null
  /** Draft with no participants/teams. */
  canDelete: boolean
}>()
const emit = defineEmits<{ change: [to: EventStatus]; delete: [] }>()

const DESCRIPTION = computed<Record<EventStatus, string>>(() => ({
  draft: '草稿對外不可見。開放後會出現在首頁，參加者可以填資料、開團。',
  open: '參加者可以開團、申請、傳訊息。',
  closed: '不能開團與申請；資料依保存天數清除。',
  archived: '已封存。從所有列表消失，直接連結仍可讀。',
}))

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

const dialog = computed(() => {
  const to = pending.value
  const t = props.termTeam
  if (to === 'open' && props.status === 'draft') {
    return {
      title: '開放活動',
      body: '開放後會出現在首頁，參加者可以填資料、開團。系統會先檢查：名稱、三個時間有效、招募截止在未來、人數規則、至少一個角色與一個技能。',
      confirm: '確認開放',
      danger: false,
    }
  }
  if (to === 'open') {
    return {
      title: '重新開放活動',
      body: `重新開放後參加者又可以開團、申請與傳訊息；既有${t}維持不變。`,
      confirm: '重新開放',
      danger: false,
    }
  }
  if (to === 'closed') {
    return {
      title: '關閉招募與活動',
      body: `關閉後不能再開團與申請，既有${t}與訊息仍可見；可以重新開放。`,
      confirm: '確認關閉',
      danger: false,
    }
  }
  if (to === 'archived') {
    return {
      title: '封存活動',
      body: '封存後從所有列表消失，直接連結仍可讀。此動作不可逆。',
      confirm: '確認封存',
      danger: true,
    }
  }
  return null
})

const blockedByChecklist = computed(() => pending.value === 'open' && (props.openChecklist?.length ?? 0) > 0)

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
    <p class="mt-3 text-sm">{{ DESCRIPTION[status] }}</p>

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
        重新開放
      </button>
      <p v-if="dirty" id="status-dirty-hint" class="text-sm text-warn">先儲存變更，才能變更狀態。</p>
    </div>

    <!-- delete: drafts with no data only (§6) -->
    <div v-if="status === 'draft'" class="mt-6 border-t border-line pt-4">
      <button
        v-if="canDelete"
        type="button"
        class="inline-flex min-h-[44px] items-center text-sm text-danger underline decoration-dotted underline-offset-2"
        :disabled="busy"
        @click="confirmingDelete = true"
      >
        刪除這場活動
      </button>
      <p v-else class="text-sm text-dim">已有參加者或{{ termTeam }}，無法刪除；請改走關閉與封存。</p>
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
      <h2 id="delete-dialog-title" class="text-lg font-bold">刪除這場活動？</h2>
      <p class="mt-2 text-sm text-dim">
        只有仍是{{ EVENT_STATUS_LABEL.draft }}、且沒有任何參加者或{{ termTeam }}的活動可以刪除。刪除後無法復原。
      </p>
      <div class="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" class="btn btn-quiet" data-autofocus @click="confirmingDelete = false">取消</button>
        <button type="button" class="btn btn-danger" :disabled="busy" @click="emit('delete')">
          {{ busy ? '處理中⋯' : '確認刪除' }}
        </button>
      </div>
    </ModalShell>
  </div>
</template>
