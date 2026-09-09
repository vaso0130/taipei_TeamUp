<script setup lang="ts">
/**
 * Boolean setting as an accessible switch: `role=switch aria-checked`,
 * 44px hit area, visible label plus one-line helper. The label is a real
 * <label for> so clicking the text toggles too.
 */
const model = defineModel<boolean>({ required: true })
defineProps<{
  id: string
  label: string
  hint?: string | undefined
  disabled?: boolean
}>()
</script>

<template>
  <div class="flex items-start justify-between gap-4 py-1">
    <div class="min-w-0">
      <label :for="id" class="field-label !mb-0 cursor-pointer">{{ label }}</label>
      <p v-if="hint" :id="`${id}-hint`" class="field-hint !mt-1">{{ hint }}</p>
    </div>
    <button
      :id="id"
      type="button"
      role="switch"
      :aria-checked="model"
      :aria-describedby="hint ? `${id}-hint` : undefined"
      :disabled="disabled"
      class="relative flex h-11 w-16 shrink-0 cursor-pointer items-center rounded-full px-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50"
      :class="model ? 'bg-primary' : 'bg-line'"
      @click="model = !model"
    >
      <span class="sr-only">{{ model ? '開啟' : '關閉' }}</span>
      <span
        class="block h-7 w-7 rounded-full bg-card transition-transform duration-150"
        :class="model ? 'translate-x-7' : 'translate-x-0'"
        aria-hidden="true"
      ></span>
    </button>
  </div>
</template>
