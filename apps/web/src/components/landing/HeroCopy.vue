<script setup lang="ts">
/**
 * Platform-display copy for the landing hero: an amber mono eyebrow, three
 * lines that light up left→right like an LED board (stepped clip-path, one
 * every 0.9 s), then the brand word. Under prefers-reduced-motion every
 * line is simply there. Colours are fixed on the ink board, independent of
 * the site theme — see the scoped tokens below.
 */
import { RouterLink } from 'vue-router'

const LINES = ['正在找神隊友嗎？', '你來對地方了。', '快來看看誰正在等你來組隊']
</script>

<template>
  <div class="hero-copy">
    <p class="hero-eyebrow">
      <!-- small roundel: the station mark -->
      <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
        <circle cx="8" cy="8" r="2.5" fill="currentColor" />
      </svg>
      <span>下一站：組隊</span>
    </p>

    <p
      v-for="(line, i) in LINES"
      :key="line"
      class="led-line hero-line"
      :style="{ '--i': i }"
    >
      {{ line }}
    </p>

    <h1 id="hero-title" class="led-line hero-brand" :style="{ '--i': LINES.length }">
      <span class="font-brand">台北配</span>
      <span class="hero-brand-sub">配.taipei</span>
    </h1>

    <p class="hero-cta-row">
      <RouterLink :to="{ name: 'events' }" class="btn hero-cta">
        看看進行中的活動
        <svg
          class="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </RouterLink>
    </p>
  </div>
</template>

<style scoped>
/*
 * Board palette — deliberately not theme tokens: the hero is the one dark
 * surface on the site in both themes. All pairings ≥ 7:1 on #16302b.
 */
.hero-copy {
  --board-fg: #f7f8f6;
  --board-dim: #b5c7c1;
  --board-led: #f0b64a;
  color: var(--board-fg);
}

.hero-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--board-led);
}

.hero-line {
  margin-top: 0.75rem;
  font-size: clamp(1.375rem, 1rem + 1.6vw, 2rem);
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0.01em;
  text-wrap: balance;
}
.hero-line + .hero-line {
  margin-top: 0.25rem;
}

.hero-brand {
  margin-top: 1.5rem;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 1rem;
  font-size: clamp(3.25rem, 2rem + 5vw, 5.5rem);
  font-weight: 900;
  line-height: 1.05;
  letter-spacing: 0.02em;
}
.hero-brand-sub {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  font-weight: 400;
  letter-spacing: 0.18em;
  color: var(--board-dim);
}

/* LED sweep: a stepped clip reveal reads as columns of diodes lighting. */
.led-line {
  animation: led-scan 0.6s steps(16, end) both;
  animation-delay: calc(var(--i) * 0.9s);
}
@keyframes led-scan {
  from {
    clip-path: inset(0 100% 0 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}

.hero-cta-row {
  margin-top: 2rem;
  animation: cta-in 0.5s ease both;
  animation-delay: 3.4s;
}
@keyframes cta-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.hero-cta {
  background-color: var(--board-fg);
  color: #16302b;
  padding-left: 1.5rem;
  padding-right: 1.25rem;
}
.hero-cta:hover {
  background-color: #ffffff;
}
.hero-cta:focus-visible {
  outline-color: var(--board-led);
}

@media (prefers-reduced-motion: reduce) {
  .led-line,
  .hero-cta-row {
    animation: none;
  }
}
</style>
