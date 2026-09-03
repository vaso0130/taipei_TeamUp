<script setup lang="ts">
defineProps<{
  label: string
  /** MRT-line dot color; omit for a plain chip. */
  dot?: string
  selectable?: boolean
  selected?: boolean
}>()
defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    v-if="selectable"
    type="button"
    class="chip chip-selectable"
    :class="{ 'chip-selected': selected }"
    :aria-pressed="selected"
    @click="$emit('toggle')"
  >
    <span v-if="dot" class="chip-dot" :style="{ backgroundColor: dot }" aria-hidden="true"></span>
    {{ label }}
  </button>
  <span v-else class="chip">
    <span v-if="dot" class="chip-dot" :style="{ backgroundColor: dot }" aria-hidden="true"></span>
    {{ label }}
  </span>
</template>
