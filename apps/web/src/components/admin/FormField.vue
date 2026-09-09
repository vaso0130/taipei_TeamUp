<script setup lang="ts">
import { computed } from 'vue'

/**
 * Label + helper + inline error wrapper. The slot receives the ids the
 * control must reference (`describedby`, `invalid`) so every field gets
 * consistent aria wiring without repeating it.
 */
const props = defineProps<{
  id: string
  label: string
  hint?: string | undefined
  error?: string | undefined
  required?: boolean
  /** Optional trailing text on the label row (e.g. character count). */
  meta?: string | undefined
}>()

const hintId = computed(() => `${props.id}-hint`)
const errorId = computed(() => `${props.id}-error`)
const describedby = computed(() => {
  const ids: string[] = []
  if (props.error) ids.push(errorId.value)
  if (props.hint) ids.push(hintId.value)
  return ids.length ? ids.join(' ') : undefined
})
</script>

<template>
  <div>
    <div class="flex items-baseline justify-between gap-3">
      <label :for="id" class="field-label">
        {{ label }}
        <span v-if="required" class="text-danger" aria-hidden="true">＊</span>
        <span v-if="required" class="sr-only">（必填）</span>
      </label>
      <span v-if="meta" class="field-hint !mt-0 shrink-0 font-mono">{{ meta }}</span>
    </div>
    <slot :describedby="describedby" :invalid="Boolean(error)" :error-id="errorId" />
    <p v-if="error" :id="errorId" class="field-error" role="alert">{{ error }}</p>
    <p v-if="hint" :id="hintId" class="field-hint">{{ hint }}</p>
  </div>
</template>
