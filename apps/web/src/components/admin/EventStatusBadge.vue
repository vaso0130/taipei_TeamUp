<script setup lang="ts">
import type { EventStatus } from '@teamup/shared'
import { EVENT_STATUS_CLASS, EVENT_STATUS_LABEL } from '../../lib/event-status.js'

defineProps<{ status: EventStatus; size?: 'sm' | 'md' }>()
</script>

<template>
  <span
    class="inline-flex items-center rounded-full font-medium whitespace-nowrap"
    :class="[EVENT_STATUS_CLASS[status], size === 'md' ? 'px-3 py-1 text-sm' : 'px-2.5 py-0.5 text-xs']"
  >
    {{ EVENT_STATUS_LABEL[status] }}
  </span>
</template>
