<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AdminEventSummary, EventTemplate } from '@teamup/shared'
import { EVENT_STATUS_LABEL } from '../../lib/event-status.js'

/**
 * The three starting points for a new event (docs/design/admin-events.md
 * §2): template, copy of an existing event, blank. Shared by the create
 * page and the list's empty state.
 */
defineProps<{
  templates: EventTemplate[] | null
  templatesError: string | null
  events: AdminEventSummary[]
  compact?: boolean
}>()
const emit = defineEmits<{
  choose: [start: { kind: 'template'; key: string } | { kind: 'copy'; slug: string } | { kind: 'blank' }]
}>()

const copySlug = ref('')
const canCopy = computed(() => copySlug.value !== '')
</script>

<template>
  <div class="grid gap-4 md:grid-cols-3">
    <!-- template -->
    <section class="card flex flex-col p-5" aria-labelledby="start-template-title">
      <p class="eyebrow">起點 1</p>
      <h3 id="start-template-title" class="mt-2 text-lg font-bold">從範本開始</h3>
      <p class="mt-1 text-sm text-dim">內建的規則組合，改日期與名稱就能用。</p>
      <p v-if="templates === null && !templatesError" class="mt-4 text-sm text-dim">載入範本中⋯</p>
      <p v-else-if="templatesError" class="mt-4 text-sm text-danger" role="alert">{{ templatesError }}</p>
      <ul v-else-if="templates && templates.length" class="mt-4 space-y-2">
        <li v-for="t in templates" :key="t.key">
          <button
            type="button"
            class="flex w-full cursor-pointer flex-col items-start rounded-lg border border-line px-4 py-3 text-left transition-colors duration-150 hover:border-primary hover:bg-primary-mist"
            @click="emit('choose', { kind: 'template', key: t.key })"
          >
            <span class="font-medium">{{ t.name }}</span>
            <span class="mt-0.5 text-sm text-dim">{{ t.description }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="mt-4 text-sm text-dim">目前沒有可用的範本。</p>
    </section>

    <!-- copy -->
    <section class="card flex flex-col p-5" aria-labelledby="start-copy-title">
      <p class="eyebrow">起點 2</p>
      <h3 id="start-copy-title" class="mt-2 text-lg font-bold">複製既有活動</h3>
      <p class="mt-1 text-sm text-dim">帶入全部設定與字典；名稱加「（複本）」、代號重填、狀態回到草稿。</p>
      <template v-if="events.length">
        <label for="start-copy-source" class="field-label mt-4">要複製的活動</label>
        <select id="start-copy-source" v-model="copySlug" class="field-input">
          <option value="" disabled>請選擇</option>
          <option v-for="e in events" :key="e.slug" :value="e.slug">
            {{ e.name }}（{{ EVENT_STATUS_LABEL[e.status] }}）
          </option>
        </select>
        <button
          type="button"
          class="btn btn-quiet mt-3 self-start"
          :disabled="!canCopy"
          @click="canCopy && emit('choose', { kind: 'copy', slug: copySlug })"
        >
          複製這場活動
        </button>
      </template>
      <p v-else class="mt-4 text-sm text-dim">還沒有任何活動可以複製。</p>
    </section>

    <!-- blank -->
    <section class="card flex flex-col p-5" aria-labelledby="start-blank-title">
      <p class="eyebrow">起點 3</p>
      <h3 id="start-blank-title" class="mt-2 text-lg font-bold">空白</h3>
      <p class="mt-1 text-sm text-dim">只有預設值：每組 1–1 人、沒有角色與技能字典，全部自己填。</p>
      <div class="mt-auto pt-4">
        <button type="button" class="btn btn-quiet" @click="emit('choose', { kind: 'blank' })">
          從空白開始
        </button>
      </div>
    </section>
  </div>
</template>
