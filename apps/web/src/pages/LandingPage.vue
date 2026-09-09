<script setup lang="ts">
/**
 * Landing `/`: the night MRT board, full viewport, nothing else. The CTA
 * leads to `/events`. Spec: docs/design/landing-and-event-layer.md §1.
 * The route carries meta.fullBleed so App.vue drops the page column.
 */
import HeroCopy from '../components/landing/HeroCopy.vue'
import HeroMap from '../components/landing/HeroMap.vue'
</script>

<template>
  <!--
    Fixed ink ground in both themes (the one dark surface on the site).
    Height = viewport minus the header, so the board fills the first screen
    edge to edge; the copy sits bottom-left like a platform display.
  -->
  <section class="hero-board relative flex flex-col justify-end overflow-hidden" aria-labelledby="hero-title">
    <div class="absolute inset-0">
      <HeroMap />
    </div>
    <div class="relative mx-auto w-full max-w-5xl px-5 pb-12 pt-24 sm:px-8 sm:pb-16 lg:px-10">
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
</style>
