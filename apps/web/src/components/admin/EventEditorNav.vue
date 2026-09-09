<script setup lang="ts">
import { SECTIONS, sectionElementId, type SectionId } from '../../composables/useEventEditor.js'

/**
 * Section navigation for the editor: a sticky vertical list on desktop,
 * a horizontally scrollable row of chips on narrow screens. Each item
 * carries that section's visible error count (red dot + number).
 */
defineProps<{
  active: SectionId
  errorCounts: Record<SectionId, number>
}>()
const emit = defineEmits<{ select: [id: SectionId] }>()

function go(id: SectionId) {
  emit('select', id)
  const el = document.getElementById(sectionElementId(id))
  el?.scrollIntoView({ block: 'start' })
  // Move focus to the section heading so keyboard users land where they clicked.
  el?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
}
</script>

<template>
  <nav aria-label="編輯區塊">
    <ul
      class="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pb-0"
    >
      <li v-for="(s, i) in SECTIONS" :key="s.id" class="shrink-0">
        <a
          :href="`#${sectionElementId(s.id)}`"
          class="flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-sm whitespace-nowrap transition-colors duration-150 lg:border-transparent lg:px-2.5"
          :class="
            active === s.id
              ? 'border-primary bg-primary-mist font-medium text-primary-deep'
              : 'border-line text-dim hover:text-ink lg:hover:bg-mist'
          "
          :aria-current="active === s.id ? 'true' : undefined"
          @click.prevent="go(s.id)"
        >
          <span class="hidden w-4 font-mono text-xs lg:inline" aria-hidden="true">{{ i + 1 }}</span>
          <span>{{ s.label }}</span>
          <span
            v-if="errorCounts[s.id] > 0"
            class="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 font-mono text-[11px] font-semibold text-white"
          >
            {{ errorCounts[s.id] }}
            <span class="sr-only">個錯誤</span>
          </span>
        </a>
      </li>
    </ul>
  </nav>
</template>
