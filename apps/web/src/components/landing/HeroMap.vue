<script setup lang="ts">
/**
 * Night-time MRT network, drawn on a 2D canvas (docs/design/landing-and-event-layer.md §1).
 *
 * White dots are people drifting slowly across the board. Every few seconds
 * a handful of nearby dots are linked into a "route" in one of the MRT line
 * colours — each hop drawn octilinearly (0°/45°/90°, the way transit maps
 * are drawn) at train pace, terminals marked with roundels — held, then
 * faded out so the next route can form. That is the product, animated.
 *
 * No dependencies, rAF only, paused when off-screen or the tab is hidden,
 * static picture under prefers-reduced-motion. Decorative: aria-hidden.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { dotColorForIndex } from '../../lib/colors.js'

interface Node {
  x: number
  y: number
  vx: number
  vy: number
}
type Phase = 'drawing' | 'hold' | 'fade'
interface Route {
  nodes: number[]
  color: string
  phase: Phase
  /** Milliseconds elapsed in the current phase. */
  t: number
}

// ---- tuning (values from the design spec) ----
const SEGMENT_MS = 180
const HOLD_MS = 1800
const FADE_MS = 600
const SPAWN_MIN_MS = 2500
const SPAWN_MAX_MS = 4000
const MAX_ROUTES = 3
const ROUTE_MIN_NODES = 4
const ROUTE_MAX_NODES = 5
const NODE_MIN = 40
const NODE_MAX = 70
const DRIFT_MIN_PX_S = 3
const DRIFT_MAX_PX_S = 8
const MAX_DPR = 2
const RESIZE_DEBOUNCE_MS = 200
const STATIC_ROUTES = 3

// Hero palette is fixed (the board does not follow the light/dark theme).
const BOARD_BG = '#16302b'
const NODE_RGB = '255, 255, 255'
const NODE_ALPHA = 0.42
const NODE_RADIUS = 2.4
const NODE_RING_WIDTH = 1
const LINE_WIDTH = 3

const canvasRef = ref<HTMLCanvasElement | null>(null)

let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
let nodes: Node[] = []
let routes: Route[] = []
let routeCounter = 0
let spawnIn = 0
let rafId = 0
let lastTs = 0
let inView = true
let reduced = false
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let observer: IntersectionObserver | null = null
let motionQuery: MediaQueryList | null = null

/** Dev-only counters so a test can assert the loop really stops. */
const stats = { frames: 0, running: false, routes: 0, nodes: 0, reduced: false }

const rand = (min: number, max: number) => min + Math.random() * (max - min)

// ---- world ----

function nodeCountFor(w: number): number {
  return Math.max(NODE_MIN, Math.min(NODE_MAX, NODE_MIN + Math.floor((w - 375) / 12)))
}

/** Jittered grid: even coverage without the clumps of pure random placement. */
function buildNodes() {
  const n = nodeCountFor(width)
  const cols = Math.max(1, Math.round(Math.sqrt((n * width) / Math.max(height, 1))))
  const rows = Math.max(1, Math.ceil(n / cols))
  const cw = width / cols
  const ch = height / rows
  nodes = []
  for (let i = 0; i < n; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    const angle = rand(0, Math.PI * 2)
    const speed = rand(DRIFT_MIN_PX_S, DRIFT_MAX_PX_S)
    nodes.push({
      x: (c + 0.5) * cw + rand(-0.4, 0.4) * cw,
      y: (r + 0.5) * ch + rand(-0.4, 0.4) * ch,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    })
  }
  routes = []
  spawnIn = rand(SPAWN_MIN_MS, SPAWN_MAX_MS) * 0.3 // first route arrives early
  stats.nodes = nodes.length
}

function busyNodes(): Set<number> {
  const set = new Set<number>()
  for (const r of routes) for (const i of r.nodes) set.add(i)
  return set
}

/** Greedy nearest-neighbour chain from a random free seed: 4–5 nodes. */
function pickRoute(): number[] | null {
  const busy = busyNodes()
  const free = nodes.map((_, i) => i).filter((i) => !busy.has(i))
  const want = Math.floor(rand(ROUTE_MIN_NODES, ROUTE_MAX_NODES + 1))
  if (free.length < want) return null
  const chain = [free[Math.floor(Math.random() * free.length)]!]
  const used = new Set(chain)
  while (chain.length < want) {
    const last = nodes[chain[chain.length - 1]!]!
    let best = -1
    let bestD = Infinity
    for (const i of free) {
      if (used.has(i)) continue
      const n = nodes[i]!
      const d = (n.x - last.x) ** 2 + (n.y - last.y) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best < 0) break
    chain.push(best)
    used.add(best)
  }
  return chain.length >= ROUTE_MIN_NODES ? chain : null
}

function spawnRoute(phase: Phase = 'drawing') {
  const picked = pickRoute()
  if (!picked) return
  routes.push({ nodes: picked, color: dotColorForIndex(routeCounter++), phase, t: 0 })
}

function step(dt: number) {
  const s = dt / 1000
  for (const n of nodes) {
    n.x += n.vx * s
    n.y += n.vy * s
    if (n.x < 0 || n.x > width) {
      n.vx = -n.vx
      n.x = Math.max(0, Math.min(width, n.x))
    }
    if (n.y < 0 || n.y > height) {
      n.vy = -n.vy
      n.y = Math.max(0, Math.min(height, n.y))
    }
  }

  for (const r of routes) {
    r.t += dt
    const drawMs = (r.nodes.length - 1) * SEGMENT_MS
    if (r.phase === 'drawing' && r.t >= drawMs) {
      r.phase = 'hold'
      r.t -= drawMs
    } else if (r.phase === 'hold' && r.t >= HOLD_MS) {
      r.phase = 'fade'
      r.t -= HOLD_MS
    }
  }
  routes = routes.filter((r) => !(r.phase === 'fade' && r.t >= FADE_MS))

  spawnIn -= dt
  if (spawnIn <= 0) {
    if (routes.length < MAX_ROUTES) spawnRoute()
    spawnIn = rand(SPAWN_MIN_MS, SPAWN_MAX_MS)
  }
  stats.routes = routes.length
}

// ---- drawing ----

/**
 * Octilinear hop a→b: a 45° diagonal then a straight run (transit-map
 * geometry). Traces the first `progress` (0–1) of the hop's length.
 */
function traceHop(c: CanvasRenderingContext2D, a: Node, b: Node, progress: number) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const m = Math.min(Math.abs(dx), Math.abs(dy))
  const ex = a.x + Math.sign(dx) * m
  const ey = a.y + Math.sign(dy) * m
  const l1 = m * Math.SQRT2
  const l2 = Math.max(Math.abs(dx), Math.abs(dy)) - m
  const d = progress * (l1 + l2)
  c.moveTo(a.x, a.y)
  if (d <= l1) {
    const k = l1 === 0 ? 1 : d / l1
    c.lineTo(a.x + (ex - a.x) * k, a.y + (ey - a.y) * k)
  } else {
    const k = l2 === 0 ? 1 : (d - l1) / l2
    c.lineTo(ex, ey)
    c.lineTo(ex + (b.x - ex) * k, ey + (b.y - ey) * k)
  }
}

function drawRoundel(c: CanvasRenderingContext2D, n: Node, color: string, r: number) {
  c.beginPath()
  c.arc(n.x, n.y, r, 0, Math.PI * 2)
  c.fillStyle = '#ffffff'
  c.fill()
  c.beginPath()
  c.arc(n.x, n.y, r * 0.55, 0, Math.PI * 2)
  c.fillStyle = color
  c.fill()
}

function drawStation(c: CanvasRenderingContext2D, n: Node, color: string) {
  c.beginPath()
  c.arc(n.x, n.y, 3, 0, Math.PI * 2)
  c.fillStyle = '#ffffff'
  c.fill()
  c.lineWidth = 1.5
  c.strokeStyle = color
  c.stroke()
}

function drawRoute(c: CanvasRenderingContext2D, r: Route) {
  const hops = r.nodes.length - 1
  let completeHops = hops
  let partial = 0
  if (r.phase === 'drawing') {
    completeHops = Math.min(hops, Math.floor(r.t / SEGMENT_MS))
    partial = (r.t % SEGMENT_MS) / SEGMENT_MS
  }
  c.globalAlpha = r.phase === 'fade' ? Math.max(0, 1 - r.t / FADE_MS) : 1

  c.lineWidth = LINE_WIDTH
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.strokeStyle = r.color
  c.beginPath()
  for (let i = 0; i < completeHops; i++) traceHop(c, nodes[r.nodes[i]!]!, nodes[r.nodes[i + 1]!]!, 1)
  if (completeHops < hops && partial > 0) {
    traceHop(c, nodes[r.nodes[completeHops]!]!, nodes[r.nodes[completeHops + 1]!]!, partial)
  }
  c.stroke()

  // Intermediate stations appear as the train reaches them.
  for (let i = 1; i < Math.min(completeHops + 1, hops); i++) {
    drawStation(c, nodes[r.nodes[i]!]!, r.color)
  }
  // Terminals: origin lit from the start, destination when the line arrives.
  const pulse = r.phase === 'hold' ? Math.sin(r.t / 220) * 0.9 : 0
  drawRoundel(c, nodes[r.nodes[0]!]!, r.color, 6 + pulse)
  if (completeHops >= hops) drawRoundel(c, nodes[r.nodes[hops]!]!, r.color, 6 + pulse)
  c.globalAlpha = 1
}

function draw() {
  if (!ctx) return
  const c = ctx
  c.fillStyle = BOARD_BG
  c.fillRect(0, 0, width, height)

  // Unconnected people: hollow station rings, not stars.
  const busy = busyNodes()
  c.strokeStyle = `rgba(${NODE_RGB}, ${NODE_ALPHA})`
  c.lineWidth = NODE_RING_WIDTH
  c.beginPath()
  for (let i = 0; i < nodes.length; i++) {
    if (busy.has(i)) continue
    const n = nodes[i]!
    c.moveTo(n.x + NODE_RADIUS, n.y)
    c.arc(n.x, n.y, NODE_RADIUS, 0, Math.PI * 2)
  }
  c.stroke()

  for (const r of routes) drawRoute(c, r)
}

// ---- loop control ----

function frame(ts: number) {
  rafId = 0
  if (!stats.running) return
  const dt = lastTs ? Math.min(ts - lastTs, 100) : 16
  lastTs = ts
  step(dt)
  draw()
  stats.frames++
  rafId = requestAnimationFrame(frame)
}

function syncRunning() {
  const shouldRun = !reduced && inView && !document.hidden && Boolean(ctx)
  if (shouldRun === stats.running) return
  stats.running = shouldRun
  if (shouldRun) {
    lastTs = 0
    if (!rafId) rafId = requestAnimationFrame(frame)
  } else if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

/** Reduced motion: one still frame with a few routes already connected. */
function drawStatic() {
  routes = []
  for (let i = 0; i < STATIC_ROUTES; i++) spawnRoute('hold')
  draw()
}

function resize() {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  width = Math.max(1, Math.round(rect.width))
  height = Math.max(1, Math.round(rect.height))
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  buildNodes()
  if (reduced) drawStatic()
  else draw()
}

function onResize() {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(resize, RESIZE_DEBOUNCE_MS)
}

function onVisibility() {
  syncRunning()
}

function onMotionChange(e: MediaQueryListEvent) {
  reduced = e.matches
  stats.reduced = reduced
  if (reduced) {
    syncRunning()
    drawStatic()
  } else {
    routes = []
    syncRunning()
  }
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  reduced = motionQuery?.matches ?? false
  stats.reduced = reduced
  motionQuery?.addEventListener('change', onMotionChange)

  resize()

  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.isIntersecting)
        syncRunning()
      },
      { threshold: 0 },
    )
    observer.observe(canvas)
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', onResize)
  syncRunning()

  if (import.meta.env.DEV) {
    ;(window as unknown as Record<string, unknown>).__heroMapStats = stats
  }
})

onBeforeUnmount(() => {
  stats.running = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  clearTimeout(resizeTimer)
  observer?.disconnect()
  observer = null
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('resize', onResize)
  motionQuery?.removeEventListener('change', onMotionChange)
  motionQuery = null
  ctx = null
  if (import.meta.env.DEV) {
    delete (window as unknown as Record<string, unknown>).__heroMapStats
  }
})
</script>

<template>
  <canvas ref="canvasRef" class="block h-full w-full" aria-hidden="true"></canvas>
</template>
