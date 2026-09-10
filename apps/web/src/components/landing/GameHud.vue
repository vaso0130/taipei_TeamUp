<script setup lang="ts">
/**
 * Small panel for the 湊隊 easter egg (docs/design/landing-game.md §HUD):
 * countdown, score line, hint. Fixed hero palette (the board never follows
 * the site theme). Receives focus on mount so Esc works right away; the
 * `role=status` region announces team formed / round lost only.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { HINT_FIRST, type GameHudState } from './hero-game.js'

const props = defineProps<{
  hud: GameHudState | null
  termTeam: string
  /** Rules still loading from the event store. */
  pending: boolean
}>()
const emit = defineEmits<{ exit: [] }>()

const panel = ref<HTMLElement | null>(null)
onMounted(() => panel.value?.focus({ preventScroll: true }))

/** Under this many milliseconds left the countdown turns amber. */
const URGENT_MS = 2000

const seconds = computed(() => {
  const ms = props.hud?.state === 'round' ? props.hud.timeLeftMs : (props.hud?.limitMs ?? 0)
  return (Math.max(0, ms) / 1000).toFixed(1)
})
const urgent = computed(() => props.hud?.state === 'round' && props.hud.timeLeftMs <= URGENT_MS)

/** Screen-reader announcements: one per success / fail, never the countdown. */
const announcement = ref('')
watch(
  () => [props.hud?.state, props.hud?.wins] as const,
  ([state], [prev]) => {
    if (state === prev || !props.hud) return
    if (state === 'success') announcement.value = `成${props.termTeam}！分數 ${props.hud.score}，連續 ${props.hud.streak}`
    else if (state === 'fail') announcement.value = '差一點，再來一局'
  },
)
</script>

<template>
  <section
    ref="panel"
    class="game-hud"
    tabindex="-1"
    aria-label="湊隊小遊戲"
    @keydown.esc.prevent="emit('exit')"
  >
    <div class="game-hud-row">
      <h2 class="game-hud-title">湊隊</h2>
      <button type="button" class="game-hud-exit" @click="emit('exit')">離開</button>
    </div>
    <p v-if="hud" class="game-hud-sub">{{ hud.subtitle }}</p>
    <p v-else class="game-hud-sub">{{ pending ? '準備中…' : '' }}</p>
    <p class="game-hud-time" :class="{ 'is-urgent': urgent }" aria-hidden="true">
      {{ hud ? seconds : '--.-' }}<span class="game-hud-unit">s</span>
    </p>
    <dl class="game-hud-score">
      <div><dt>分數</dt><dd>{{ hud?.score ?? 0 }}</dd></div>
      <div><dt>連續</dt><dd>{{ hud?.streak ?? 0 }}</dd></div>
      <div><dt>最佳</dt><dd>{{ hud?.best ?? 0 }}</dd></div>
    </dl>
    <p class="game-hud-hint">{{ hud?.hint ?? HINT_FIRST }}</p>
    <p class="game-hud-note">需要滑鼠或觸控；Esc 離開</p>
    <p class="sr-only" role="status">{{ announcement }}</p>
  </section>
</template>

<style scoped>
.game-hud {
  --board-fg: #f7f8f6;
  --board-dim: #b5c7c1;
  --board-led: #f0b64a;
  position: absolute;
  top: 1rem;
  right: 1rem;
  z-index: 2;
  width: 220px;
  padding: 0.625rem 0.875rem 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.75rem;
  background-color: rgba(22, 48, 43, 0.85);
  color: var(--board-fg);
  font-size: 0.8125rem;
  line-height: 1.4;
}
/* The panel is a focus landing spot, not a control: a quiet amber edge, no thick ring. */
.game-hud:focus {
  outline: none;
}
.game-hud:focus-visible {
  outline: none;
  border-color: rgba(240, 182, 74, 0.6);
}
@media (max-width: 639px) {
  .game-hud {
    top: 0;
    right: 0;
    left: 0;
    width: auto;
    border-radius: 0 0 0.75rem 0.75rem;
    border-top: 0;
  }
}

.game-hud-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.game-hud-title {
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.game-hud-exit {
  min-height: 44px;
  min-width: 44px;
  padding: 0 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 0.5rem;
  color: var(--board-fg);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease;
}
.game-hud-exit:hover {
  border-color: var(--board-fg);
  background-color: rgba(255, 255, 255, 0.08);
}
.game-hud-exit:focus-visible {
  outline-color: var(--board-led);
}

.game-hud-sub {
  min-height: 1.2em;
  color: var(--board-dim);
}
.game-hud-time {
  margin-top: 0.125rem;
  font-family: var(--font-mono);
  font-size: 1.75rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  color: var(--board-fg);
  transition: color 150ms ease;
}
.game-hud-time.is-urgent {
  color: var(--board-led);
}
.game-hud-unit {
  margin-left: 0.125rem;
  font-size: 0.875rem;
  font-weight: 400;
  color: var(--board-dim);
}
/* 分數・連續・最佳 as three columns so any digit count fits 220px. */
.game-hud-score {
  margin-top: 0.375rem;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}
.game-hud-score dt {
  font-size: 0.6875rem;
  color: var(--board-dim);
}
.game-hud-score dd {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.2;
  color: var(--board-fg);
}
.game-hud-hint {
  margin-top: 0.375rem;
  min-height: 1.4em;
  color: var(--board-fg);
}
.game-hud-note {
  margin-top: 0.125rem;
  font-size: 0.6875rem;
  color: var(--board-dim);
}
</style>
