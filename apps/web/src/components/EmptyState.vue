<script setup lang="ts">
defineProps<{
  title: string
  hint?: string
}>()
</script>

<template>
  <div class="card px-6 py-10 text-center">
    <p class="font-medium">{{ title }}</p>
    <p v-if="hint" class="mt-1 text-sm text-dim">{{ hint }}</p>
    <div v-if="$slots.action" class="mt-4">
      <slot name="action" />
    </div>
  </div>
</template>
