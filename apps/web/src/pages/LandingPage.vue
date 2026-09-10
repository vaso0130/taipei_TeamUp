<script setup lang="ts">
/**
 * Landing `/`: the night MRT board, full viewport, nothing else. The CTA
 * leads to `/events`. Spec: docs/design/landing-and-event-layer.md §1.
 * The route carries meta.fullBleed so App.vue drops the page column.
 *
 * The board hosts the 湊隊 easter egg (docs/design/landing-game.md): while
 * it is active the copy dims to 35% and the LED sweep stops; the CTA stays
 * clickable throughout (see the pointer-events note in HeroCopy.vue).
 */
import { ref, watch } from 'vue'
import HeroCopy from '../components/landing/HeroCopy.vue'
import HeroMap from '../components/landing/HeroMap.vue'

const gameActive = ref(false)
/** Once the game has run, the LED sweep stays off so leaving does not replay it. */
const ledOff = ref(false)
watch(gameActive, (active) => {
  if (active) ledOff.value = true
})
</script>

<template>
  <!--
    Fixed ink ground in both themes (the one dark surface on the site).
    Height = viewport minus the header, so the board fills the first screen
    edge to edge; the copy sits bottom-left like a platform display.
  -->
  <section class="hero-board relative flex flex-col justify-end overflow-hidden" aria-labelledby="hero-title">
    <div class="absolute inset-0">
      <HeroMap @game-active="gameActive = $event" />
    </div>
    <div
      class="hero-copy-wrap relative mx-auto w-full max-w-5xl px-5 pb-12 pt-24 sm:px-8 sm:pb-16 lg:px-10"
      :class="{ 'is-dimmed': gameActive, 'is-led-off': ledOff }"
    >
      <HeroCopy />
    </div>
  </section>
</template>

<style scoped>
.hero-board {
  background-color: #16302b;
  min-height: calc(100dvh - 3.75rem); /* header height */
}
@supports not (height: 100dvh) {
  .hero-board {
    min-height: calc(100vh - 3.75rem);
  }
}

/* Copy sits above the canvas but lets the pointer through except on text and CTA. */
.hero-copy-wrap {
  pointer-events: none;
  transition: opacity 300ms ease;
}
.hero-copy-wrap.is-dimmed {
  opacity: 0.35;
}
/* While playing, the dimmed text lets the pointer reach the board; the CTA keeps it. */
.hero-copy-wrap.is-dimmed :deep(.hero-text),
.hero-copy-wrap.is-dimmed :deep(.hero-eyebrow) {
  pointer-events: none;
}
.hero-copy-wrap.is-led-off :deep(.led-line),
.hero-copy-wrap.is-led-off :deep(.hero-cta-row) {
  animation: none;
}
</style>
