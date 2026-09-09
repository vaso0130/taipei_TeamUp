<script setup lang="ts">
/**
 * Accessible modal frame: backdrop, role=dialog, initial focus, Tab
 * trap, Esc to close, and focus restored to the opener on close. Content
 * goes in the default slot; pass either `labelledby` (id of a heading in
 * the slot) or `label`.
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  labelledby?: string
  label?: string
  /** Extra classes for the panel (width, max height…). */
  panelClass?: string
  /** Raise above another open dialog. */
  zIndex?: number
}>()
const emit = defineEmits<{ close: [] }>()

const panel = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(): HTMLElement[] {
  if (!panel.value) return []
  return [...panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

function focusInitial() {
  const el = panel.value
  if (!el) return
  const preferred = el.querySelector<HTMLElement>('[data-autofocus]')
  const target = preferred ?? focusables()[0] ?? el
  target.focus({ preventScroll: true })
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
    return
  }
  if (e.key !== 'Tab') return
  const list = focusables()
  if (list.length === 0) {
    e.preventDefault()
    panel.value?.focus()
    return
  }
  const first = list[0]!
  const last = list[list.length - 1]!
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && (active === first || !panel.value?.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !panel.value?.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      focusInitial()
    } else {
      document.removeEventListener('keydown', onKeydown)
      const back = opener
      opener = null
      if (back && back.isConnected) back.focus({ preventScroll: true })
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
    :style="{ zIndex: zIndex ?? 50 }"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="labelledby"
    :aria-label="label"
    @click.self="emit('close')"
  >
    <div
      ref="panel"
      class="card w-full p-6 outline-none"
      :class="panelClass ?? 'max-w-md'"
      tabindex="-1"
    >
      <slot />
    </div>
  </div>
</template>
