<script setup lang="ts">
/**
 * Error state for list/detail loads. Distinguishes "service unavailable"
 * from a generic failure so a database outage never masquerades as an
 * empty list.
 */
import type { LoadFailure } from '../lib/errors.js'

defineProps<{
  kind: LoadFailure
  /** Replaces the default headline (e.g. for not_found). */
  title?: string | undefined
  hint?: string | undefined
}>()
const emit = defineEmits<{ retry: [] }>()

const DEFAULTS: Record<LoadFailure, { title: string; hint: string }> = {
  unavailable: { title: '服務暫時無法使用', hint: '伺服器或資料庫暫時沒有回應，請稍後重試。' },
  failed: { title: '載入失敗', hint: '網路或伺服器發生問題，請重試一次。' },
  not_found: { title: '找不到這個內容', hint: '它可能已被移除，或網址有誤。' },
}
</script>

<template>
  <div class="card px-6 py-10 text-center" role="alert">
    <p class="font-medium">{{ title ?? DEFAULTS[kind].title }}</p>
    <p class="mt-1 text-sm text-dim">{{ hint ?? DEFAULTS[kind].hint }}</p>
    <div class="mt-4 flex flex-wrap justify-center gap-2">
      <button v-if="kind !== 'not_found'" type="button" class="btn btn-primary" @click="emit('retry')">
        重試
      </button>
      <slot name="action" />
    </div>
  </div>
</template>
