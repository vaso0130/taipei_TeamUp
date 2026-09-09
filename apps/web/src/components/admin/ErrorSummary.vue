<script setup lang="ts">
import { ref } from 'vue'

/**
 * Form-level error list (docs/design/admin-events.md §5): `role=alert`,
 * programmatically focusable, one link per field that scrolls to and
 * focuses the offending control. The parent calls `focus()` after a
 * failed submit.
 */
defineProps<{
  items: { fieldId: string; label: string; message: string }[]
  /** Server messages that map to no field. */
  extra?: string[]
}>()

const root = ref<HTMLElement | null>(null)

function focus() {
  root.value?.focus()
  root.value?.scrollIntoView({ block: 'nearest' })
}

function jump(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  el.focus({ preventScroll: true })
}

defineExpose({ focus })
</script>

<template>
  <div
    ref="root"
    role="alert"
    tabindex="-1"
    class="card border-danger bg-danger-mist p-4 outline-none focus-visible:outline-2"
  >
    <p class="font-bold text-danger">有 {{ items.length + (extra?.length ?? 0) }} 個地方需要修正</p>
    <ul class="mt-1 text-sm">
      <li v-for="item in items" :key="item.fieldId">
        <a
          :href="`#${item.fieldId}`"
          class="inline-flex min-h-[44px] items-center underline decoration-dotted underline-offset-2"
          @click.prevent="jump(item.fieldId)"
        >
          <span class="font-medium">{{ item.label }}</span>：{{ item.message }}
        </a>
      </li>
      <li v-for="(msg, i) in extra" :key="`x-${i}`" class="py-1.5">{{ msg }}</li>
    </ul>
  </div>
</template>
