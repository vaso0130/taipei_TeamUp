<script setup lang="ts">
// 真・深色模式 — easter egg. A flashlight follows the cursor and the
// rest of the page falls into actual darkness. Zero dependencies (the
// CSP allows no external libs): one fixed overlay with a radial
// gradient hole. pointer-events stays off so the site remains usable
// in the dark, which is of course the joke.
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ enabled: boolean }>()

const x = ref(0)
const y = ref(0)

function move(e: PointerEvent) {
  x.value = e.clientX
  y.value = e.clientY
}

onMounted(() => {
  x.value = window.innerWidth / 2
  y.value = window.innerHeight / 2
  window.addEventListener('pointermove', move, { passive: true })
  window.addEventListener('pointerdown', move, { passive: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerdown', move)
})
</script>

<template>
  <Transition name="real-dark">
    <div
      v-if="enabled"
      class="pointer-events-none fixed inset-0 z-[999]"
      aria-hidden="true"
      :style="{
        backgroundImage: `radial-gradient(circle 240px at ${x}px ${y}px,
          rgba(255, 244, 214, 0.05) 0%,
          transparent 30%,
          rgba(0, 0, 0, 0.55) 62%,
          rgba(0, 0, 0, 0.93) 82%,
          rgba(0, 0, 0, 0.985) 100%)`,
      }"
    ></div>
  </Transition>
</template>

<style scoped>
.real-dark-enter-active,
.real-dark-leave-active {
  transition: opacity 0.6s ease;
}
.real-dark-enter-from,
.real-dark-leave-to {
  opacity: 0;
}
</style>
