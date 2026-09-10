<script setup lang="ts">
/**
 * Night-time MRT network, drawn on a 2D canvas (docs/design/landing-and-event-layer.md §1).
 *
 * The world itself (drifting people, auto routes, drawing) lives in
 * hero-world.ts; this component owns the canvas, the rAF loop, visibility /
 * reduced-motion handling, and the pointer layer of the easter egg
 * (docs/design/landing-game.md): pulling lines between people in demo mode
 * and, after a triple-click / `G` / long-press, the 湊隊 game driven by
 * hero-game.ts with GameHud.vue on top.
 *
 * Pointer layering: the canvas always receives pointer events at the bottom
 * of the hero; LandingPage makes the copy wrapper `pointer-events: none` and
 * HeroCopy re-enables them only on the text glyph boxes and the CTA, so the
 * CTA is clickable in every state and blank board is always interactive.
 *
 * No dependencies, rAF only, paused when off-screen or the tab is hidden,
 * static picture (no interaction) under prefers-reduced-motion. Decorative:
 * aria-hidden; the HUD is real DOM.
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { EventSummary } from '@teamup/shared'
import { dotColorForIndex } from '../../lib/colors.js'
import { useEventStore } from '../../stores/event.js'
import GameHud from './GameHud.vue'
import {
  DEFAULT_RULES,
  GAME,
  createGame,
  type GameEvent,
  type GameHudState,
  type GameRules,
  type HeroGame,
} from './hero-game.js'
import {
  WORLD,
  createHeroWorld,
  drawRouteGeometry,
  drawRoundel,
  traceHop,
  type HeroWorld,
  type Point,
} from './hero-world.js'

const emit = defineEmits<{ 'game-active': [active: boolean] }>()

// ---- tuning ----
const MAX_DPR = 2
const RESIZE_DEBOUNCE_MS = 200

// Interaction (docs/design/landing-game.md: 底層 / 觸發)
const SNAP_RADIUS_MOUSE = 14
const SNAP_RADIUS_TOUCH = 22
/** Demo-mode user line: at most this many stations (the game uses its own N). */
const USER_MAX_STATIONS = 5
const USER_HOLD_MS = WORLD.HOLD_MS
const USER_FADE_MS = WORLD.FADE_MS
const DEMO_LINE = 'rgba(255, 255, 255, 0.6)'
const TRIPLE_TAP_COUNT = 3
const TRIPLE_TAP_MS = 600
const LONG_PRESS_MS = 600
const LONG_PRESS_MOVE_PX = 8
const MIN_GAME_WIDTH = 360
/** Wait at most this long for event rules before starting with defaults. */
const RULES_TIMEOUT_MS = 1500

// Overlay visuals
const HOVER_RING_R = 6
const PULSE_MS = 300
const WRONG_FLASH_MS = 200
const BLINK_MS = 800
const TOAST_MS = GAME.SUCCESS_MS
const WRONG_COLOR = '#f07575'
const BOARD_FG = '#f7f8f6'
const FONT_SANS = "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif"
const LABEL_FONT = `11px ${FONT_SANS}`
const TOAST_FONT = `700 28px ${FONT_SANS}`

const canvasRef = ref<HTMLCanvasElement | null>(null)
const eventStore = useEventStore()
/** Keep targets this far clear of overlays (nodes drift a few px between rounds). */
const BLOCKER_MARGIN_PX = 16

let ctx: CanvasRenderingContext2D | null = null
let width = 0
let height = 0
let world: HeroWorld | null = null
let rafId = 0
let lastTs = 0
let inView = true
let reduced = false
let resizeTimer: ReturnType<typeof setTimeout> | undefined
let observer: IntersectionObserver | null = null
let motionQuery: MediaQueryList | null = null

/** Dev-only counters so a test can assert the loop really stops. */
const stats = { frames: 0, running: false, routes: 0, nodes: 0, reduced: false }

// ---- interaction state ----
interface Drag {
  pointerId: number
  path: number[]
  x: number
  y: number
  touch: boolean
}
interface UserRoute {
  nodes: number[]
  color: string
  t: number
}
interface Flash {
  from: Point
  to: Point
  t: number
}
interface RouteFx {
  nodes: number[]
  color: string
  t: number
  label?: string
}

let drag: Drag | null = null
let hover = -1
let userRoute: UserRoute | null = null
const pulses = new Map<number, number>()
let wrongFlash: Flash | null = null
let lastWrongNode = -1
let successFx: RouteFx | null = null
let failFx: RouteFx | null = null
let tapTimes: number[] = []
let longPress: { timer: ReturnType<typeof setTimeout>; x: number; y: number; pointerId: number } | null = null

// ---- game state ----
let game: HeroGame | null = null
let gameTargets: number[] = []
let blinkT = 0
const gameActive = ref(false)
const rulesPending = ref(false)
const hud = ref<GameHudState | null>(null)
const termTeam = ref(DEFAULT_RULES.termTeam)
const isHot = ref(false)
const isDragging = ref(false)
let hudKey = ''

// ---- helpers ----

function point(e: PointerEvent): Point {
  const canvas = canvasRef.value
  if (!canvas) return { x: e.clientX, y: e.clientY }
  const rect = canvas.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

const radiusFor = (touch: boolean) => (touch ? SNAP_RADIUS_TOUCH : SNAP_RADIUS_MOUSE)

function lineColor(): string {
  return game && gameActive.value ? game.hud().color : DEMO_LINE
}

/** A node the player may start a line from right now. */
function grabbable(index: number): boolean {
  if (!game || game.state !== 'round') {
    // Demo mode: anyone not already on an auto route or the fading user line.
    return !gameActive.value && !world!.busyNodes().has(index) && !userRoute?.nodes.includes(index)
  }
  const h = game.hud()
  return index === h.targets[0] || (h.progress > 1 && index === h.targets[h.progress - 1])
}

function refreshHud() {
  if (!game || !gameActive.value) return
  const h = game.hud()
  const key = [h.state, Math.ceil(h.timeLeftMs / 100), h.score, h.streak, h.best, h.hint, h.stations, h.progress, h.wins].join('|')
  if (key === hudKey) return
  hudKey = key
  hud.value = h
}

// ---- game wiring ----

/**
 * Nodes the pointer cannot reach — under the HUD panel, the CTA, or outside
 * the viewport — are reserved so the game never picks them as targets. A DOM
 * hit-test per node (n ≤ 70, once per round) covers every overlay at once.
 */
function blockedNodes(): number[] {
  const canvas = canvasRef.value
  if (!canvas || !world || typeof document.elementFromPoint !== 'function') return []
  const c = canvas.getBoundingClientRect()
  const m = BLOCKER_MARGIN_PX
  const offsets = [
    [0, 0],
    [-m, 0],
    [m, 0],
    [0, -m],
    [0, m],
  ] as const
  const out: number[] = []
  world.nodes.forEach((n, i) => {
    const blocked = offsets.some(([dx, dy]) => document.elementFromPoint(c.left + n.x + dx, c.top + n.y + dy) !== canvas)
    if (blocked) out.push(i)
  })
  return out
}

function syncGameReserved() {
  world?.setReserved([...blockedNodes(), ...gameTargets])
}

function onGameEvent(e: GameEvent) {
  switch (e.type) {
    case 'round':
      gameTargets = e.targets
      world?.freeze(gameTargets)
      syncGameReserved()
      lastWrongNode = -1
      break
    case 'success':
      successFx = { nodes: e.targets, color: e.color, t: 0, label: `成${termTeam.value}！ ${(e.elapsedMs / 1000).toFixed(1)}s` }
      endDrag()
      gameTargets = []
      syncGameReserved() // before the next round picks its targets
      break
    case 'fail':
      failFx = e.connected.length >= 2 ? { nodes: e.connected, color: e.color, t: 0 } : null
      endDrag()
      gameTargets = []
      syncGameReserved()
      break
    case 'stop':
      leaveGame()
      break
    default:
      break
  }
}

async function loadRules(): Promise<GameRules> {
  const summaries = await eventStore.ensureSummaries()
  const time = (iso: string) => new Date(iso).getTime()
  const first: EventSummary | undefined = summaries
    .filter((s) => s.status === 'open')
    .sort((a, b) => time(a.recruitClosesAt) - time(b.recruitClosesAt))[0]
  if (!first) return DEFAULT_RULES
  const detail = await eventStore.ensureLoaded(first.slug)
  if (!detail) return DEFAULT_RULES
  return {
    minStations: detail.event.minMembers,
    maxStations: detail.event.maxMembers,
    termTeam: detail.event.termTeam,
    termMember: detail.event.termMember,
    roleLabels: detail.roles
      .filter((r) => r.isActive)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => r.label),
  }
}

function sessionStore() {
  try {
    const s = window.sessionStorage
    s.getItem(GAME.STORAGE_KEY)
    return s
  } catch {
    return undefined
  }
}

async function enterGame() {
  if (gameActive.value || reduced || !world || width < MIN_GAME_WIDTH) return
  gameActive.value = true
  emit('game-active', true)
  endDrag()
  userRoute = null
  world.setSpawnPaused(true)
  rulesPending.value = true
  hud.value = null
  hudKey = ''

  const rules = await Promise.race<GameRules>([
    loadRules().catch(() => DEFAULT_RULES),
    new Promise((resolve) => setTimeout(() => resolve(DEFAULT_RULES), RULES_TIMEOUT_MS)),
  ])
  if (!gameActive.value || !world) return
  rulesPending.value = false
  termTeam.value = rules.termTeam
  await nextTick() // HUD rendered with its final height
  if (!gameActive.value || !world) return
  syncGameReserved()
  const storage = sessionStore()
  game = createGame({
    world,
    rules,
    colorForIndex: dotColorForIndex,
    onEvent: onGameEvent,
    ...(storage ? { storage } : {}),
  })
  game.start()
  refreshHud()
}

function exitGame() {
  if (game && game.state !== 'idle') game.stop('user')
  else leaveGame()
}

/** Common teardown: from the game's stop event or a cancelled entry. */
function leaveGame() {
  if (!gameActive.value) return
  gameActive.value = false
  rulesPending.value = false
  emit('game-active', false)
  game = null
  gameTargets = []
  hud.value = null
  hudKey = ''
  successFx = null
  failFx = null
  wrongFlash = null
  endDrag()
  world?.unfreeze()
  world?.setReserved([])
  world?.setSpawnPaused(false)
}

// ---- pointer layer ----

function endDrag() {
  drag = null
  isDragging.value = false
  if (!gameActive.value) {
    world?.unfreeze()
    world?.setReserved(userRoute?.nodes ?? [])
  }
}

function flashWrong(from: Point, to: Point) {
  wrongFlash = { from, to, t: 0 }
}

function cancelLongPress() {
  if (longPress) clearTimeout(longPress.timer)
  longPress = null
}

function onPointerDown(e: PointerEvent) {
  if (reduced || !world || !e.isPrimary) return
  const canvas = canvasRef.value
  if (!canvas) return
  const touch = e.pointerType === 'touch'
  const p = point(e)
  game?.touch()
  const hit = world.nearestNode(p.x, p.y, radiusFor(touch))

  if (game && gameActive.value) {
    if (hit < 0) return
    if (game.state !== 'round') return
    if (!game.onGrab(hit)) {
      flashWrong(p, world.nodes[hit]!)
      return
    }
    const h = game.hud()
    drag = { pointerId: e.pointerId, path: h.targets.slice(0, h.progress), x: p.x, y: p.y, touch }
    isDragging.value = true
    canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
    return
  }

  if (hit >= 0) {
    if (!grabbable(hit)) return
    drag = { pointerId: e.pointerId, path: [hit], x: p.x, y: p.y, touch }
    isDragging.value = true
    world.freeze(drag.path)
    pulses.set(hit, PULSE_MS)
    canvas.setPointerCapture(e.pointerId)
    e.preventDefault()
    return
  }

  // Blank board: triple-click (mouse) or long-press (touch) enters the game.
  // preventDefault keeps the browser from moving focus (the HUD takes it) and
  // from starting a text selection drag across the copy.
  e.preventDefault()
  if (touch) {
    cancelLongPress()
    longPress = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        longPress = null
        void enterGame()
      }, LONG_PRESS_MS),
    }
    return
  }
  const now = performance.now()
  tapTimes = tapTimes.filter((t) => now - t <= TRIPLE_TAP_MS)
  tapTimes.push(now)
  if (tapTimes.length >= TRIPLE_TAP_COUNT) {
    tapTimes = []
    void enterGame()
  }
}

function onPointerMove(e: PointerEvent) {
  if (reduced || !world) return
  const p = point(e)
  const touch = e.pointerType === 'touch'

  if (longPress && longPress.pointerId === e.pointerId) {
    if (Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > LONG_PRESS_MOVE_PX) cancelLongPress()
  }

  if (drag) {
    if (e.pointerId !== drag.pointerId) return
    drag.x = p.x
    drag.y = p.y
    game?.touch()
    const exclude = new Set(drag.path)
    const hit = world.nearestNode(p.x, p.y, radiusFor(drag.touch), exclude)
    if (hit < 0) {
      lastWrongNode = -1
      return
    }
    if (game && gameActive.value) {
      const r = game.onSnap(hit)
      if (r === 'wrong') {
        if (lastWrongNode !== hit) {
          const last = world.nodes[drag.path[drag.path.length - 1]!]!
          flashWrong(last, world.nodes[hit]!)
          lastWrongNode = hit
        }
        return
      }
      pulses.set(hit, PULSE_MS)
      // On 'complete' the success event has already ended the drag.
      if (drag) drag.path.push(hit)
      if (r === 'complete') endDrag()
      return
    }
    if (drag.path.length >= USER_MAX_STATIONS) return
    if (world.busyNodes().has(hit)) return
    drag.path.push(hit)
    pulses.set(hit, PULSE_MS)
    world.freeze(drag.path)
    return
  }

  if (touch) return // no hover state on touch
  const hit = world.nearestNode(p.x, p.y, radiusFor(false))
  hover = hit >= 0 && grabbable(hit) ? hit : -1
  isHot.value = hover >= 0
}

function onPointerUp(e: PointerEvent) {
  cancelLongPress()
  if (!drag || e.pointerId !== drag.pointerId) return
  if (game && gameActive.value) {
    game.onRelease()
    endDrag()
    return
  }
  const path = drag.path
  drag = null
  isDragging.value = false
  world?.unfreeze()
  if (path.length >= 2) {
    userRoute = { nodes: path, color: DEMO_LINE, t: 0 }
    world?.setReserved(path)
  } else {
    world?.setReserved([])
  }
}

function onPointerLeave() {
  hover = -1
  isHot.value = false
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
  const target = e.target as HTMLElement | null
  if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return
  if (e.key === 'Escape' && gameActive.value) {
    exitGame()
    return
  }
  if ((e.key === 'g' || e.key === 'G') && !gameActive.value && inView) {
    void enterGame()
  }
}

// ---- per-frame interaction update & overlay ----

function stepOverlay(dt: number) {
  blinkT = (blinkT + dt) % BLINK_MS
  for (const [i, t] of pulses) {
    if (t - dt <= 0) pulses.delete(i)
    else pulses.set(i, t - dt)
  }
  if (wrongFlash) {
    wrongFlash.t += dt
    if (wrongFlash.t >= WRONG_FLASH_MS) wrongFlash = null
  }
  if (userRoute) {
    userRoute.t += dt
    if (userRoute.t >= USER_HOLD_MS + USER_FADE_MS) {
      userRoute = null
      if (!drag) world?.setReserved([])
    }
  }
  if (successFx) {
    successFx.t += dt
    if (successFx.t >= TOAST_MS) successFx = null
  }
  if (failFx) {
    failFx.t += dt
    if (failFx.t >= GAME.FAIL_MS) failFx = null
  }
  if (game) {
    game.tick(dt)
    refreshHud()
  }
}

function pointsOf(indices: readonly number[]): Point[] {
  const w = world!
  return indices.map((i) => w.nodes[i]!)
}

function ring(c: CanvasRenderingContext2D, p: Point, r: number, style: string, lw: number) {
  c.beginPath()
  c.arc(p.x, p.y, r, 0, Math.PI * 2)
  c.strokeStyle = style
  c.lineWidth = lw
  c.stroke()
}

function drawTargets(c: CanvasRenderingContext2D) {
  if (!game || !world || game.state !== 'round' || gameTargets.length === 0) return
  const h = game.hud()
  const blink = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((blinkT / BLINK_MS) * Math.PI * 2))
  c.font = LABEL_FONT
  c.textBaseline = 'middle'
  for (let k = 0; k < gameTargets.length; k++) {
    const n = world.nodes[gameTargets[k]!]!
    const connected = k < h.progress
    if (!connected) {
      c.globalAlpha = blink
      ring(c, n, 7, h.color, 2)
      c.globalAlpha = 1
    }
    if (k === 0) {
      c.globalAlpha = 0.8
      ring(c, n, 12, BOARD_FG, 1)
      c.globalAlpha = 1
      c.fillStyle = 'rgba(247, 248, 246, 0.85)'
      c.textAlign = 'center'
      c.fillText('起點', n.x, n.y - 20)
    }
    c.fillStyle = 'rgba(247, 248, 246, 0.85)'
    c.textAlign = 'right'
    c.fillText(String(k + 1), n.x - 10, n.y - 9)
    const role = h.roleLabelFor(k)
    if (role) {
      c.fillStyle = 'rgba(255, 255, 255, 0.7)'
      c.textAlign = 'left'
      c.fillText(role, n.x + 11, n.y + 9)
    }
  }
}

function drawOverlay(c: CanvasRenderingContext2D) {
  if (!world) return

  if (userRoute) {
    const alpha = userRoute.t < USER_HOLD_MS ? 1 : Math.max(0, 1 - (userRoute.t - USER_HOLD_MS) / USER_FADE_MS)
    drawRouteGeometry(c, pointsOf(userRoute.nodes), userRoute.color, {
      completeHops: userRoute.nodes.length - 1,
      partial: 0,
      alpha,
      pulse: userRoute.t < USER_HOLD_MS ? Math.sin(userRoute.t / 220) * 0.9 : 0,
      originRoundel: true,
      destRoundel: true,
    })
  }

  if (failFx) {
    drawRouteGeometry(c, pointsOf(failFx.nodes), failFx.color, {
      completeHops: failFx.nodes.length - 1,
      partial: 0,
      alpha: Math.max(0, 1 - failFx.t / GAME.FAIL_MS),
      pulse: 0,
      originRoundel: true,
      destRoundel: false,
    })
  }

  drawTargets(c)

  if (drag) {
    const color = lineColor()
    const pts = pointsOf(drag.path)
    if (pts.length >= 2) {
      drawRouteGeometry(c, pts, color, {
        completeHops: pts.length - 1,
        partial: 0,
        alpha: 1,
        pulse: 0,
        originRoundel: true,
        destRoundel: false,
      })
    } else if (pts[0]) {
      drawRoundel(c, pts[0], color, 6)
    }
    // Live segment from the last station to the pointer.
    const last = pts[pts.length - 1]!
    c.lineWidth = 3
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.strokeStyle = color
    c.globalAlpha = 0.85
    c.beginPath()
    traceHop(c, last, { x: drag.x, y: drag.y }, 1)
    c.stroke()
    c.globalAlpha = 1
  }

  for (const [i, t] of pulses) {
    const n = world.nodes[i]
    if (!n) continue
    const k = 1 - t / PULSE_MS
    c.globalAlpha = 1 - k
    ring(c, n, 6 + k * 10, BOARD_FG, 1.5)
    c.globalAlpha = 1
  }

  if (wrongFlash) {
    c.globalAlpha = 1 - wrongFlash.t / WRONG_FLASH_MS
    c.lineWidth = 3
    c.strokeStyle = WRONG_COLOR
    c.beginPath()
    traceHop(c, wrongFlash.from, wrongFlash.to, 1)
    c.stroke()
    ring(c, wrongFlash.to, 8, WRONG_COLOR, 2)
    c.globalAlpha = 1
  }

  if (successFx) {
    const k = successFx.t / TOAST_MS
    const pulse = Math.sin(successFx.t / 120) * 1.2
    drawRouteGeometry(c, pointsOf(successFx.nodes), successFx.color, {
      completeHops: successFx.nodes.length - 1,
      partial: 0,
      alpha: k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4),
      pulse,
      originRoundel: true,
      destRoundel: true,
    })
    if (successFx.label) {
      c.font = TOAST_FONT
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.globalAlpha = Math.min(1, k * 4) * Math.max(0, 1 - Math.max(0, k - 0.5) * 2)
      c.fillStyle = BOARD_FG
      c.fillText(successFx.label, width / 2, height / 2 - 24 * k)
      c.globalAlpha = 1
    }
  }

  if (hover >= 0 && !drag) {
    const n = world.nodes[hover]
    if (n) ring(c, n, HOVER_RING_R, 'rgba(255, 255, 255, 0.9)', 1.5)
  }
}

// ---- loop control ----

function frame(ts: number) {
  rafId = 0
  if (!stats.running || !world || !ctx) return
  const dt = lastTs ? Math.min(ts - lastTs, 100) : 16
  lastTs = ts
  world.step(dt)
  stepOverlay(dt)
  world.draw(ctx)
  drawOverlay(ctx)
  stats.routes = world.routes.length
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
  // Node indices change with the field: drop any interaction in flight.
  if (gameActive.value) exitGame()
  endDrag()
  userRoute = null
  pulses.clear()
  wrongFlash = null
  hover = -1
  isHot.value = false
  if (world) world.resize(width, height)
  else world = createHeroWorld({ width, height, colorForIndex: dotColorForIndex })
  stats.nodes = world.nodes.length
  if (reduced) world.drawStatic(ctx)
  else world.draw(ctx)
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
    if (gameActive.value) exitGame()
    endDrag()
    userRoute = null
    syncRunning()
    if (world && ctx) world.drawStatic(ctx)
  } else {
    world?.clearRoutes()
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
  window.addEventListener('keydown', onKeyDown)
  syncRunning()

  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>
    w.__heroMapStats = stats
    w.__heroGame = {
      active: () => gameActive.value,
      state: () => game?.state ?? 'idle',
      grabbed: () => game?.grabbed ?? false,
      /** Hit-test a viewport point with the given radius (node index or -1). */
      hit: (clientX: number, clientY: number, r: number) => {
        const rect = canvasRef.value?.getBoundingClientRect()
        if (!rect || !world) return -1
        return world.nearestNode(clientX - rect.left, clientY - rect.top, r)
      },
      hud: () => game?.hud() ?? null,
      /** Target centres in viewport coordinates, in order. */
      targets: () => {
        const rect = canvasRef.value?.getBoundingClientRect()
        if (!rect || !world) return []
        return gameTargets.map((i) => {
          const n = world!.nodes[i]!
          return { x: rect.left + n.x, y: rect.top + n.y }
        })
      },
      /** Any free node not part of the current targets, for "wrong station" tests. */
      decoy: () => {
        const rect = canvasRef.value?.getBoundingClientRect()
        if (!rect || !world) return null
        const set = new Set(gameTargets)
        const idx = world.nodes.findIndex((_, i) => !set.has(i))
        if (idx < 0) return null
        const n = world.nodes[idx]!
        return { x: rect.left + n.x, y: rect.top + n.y }
      },
      nodes: () => {
        const rect = canvasRef.value?.getBoundingClientRect()
        if (!rect || !world) return []
        const busy = world.busyNodes()
        return world.nodes.map((n, i) => ({ x: rect.left + n.x, y: rect.top + n.y, busy: busy.has(i) }))
      },
    }
  }
})

onBeforeUnmount(() => {
  stats.running = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  clearTimeout(resizeTimer)
  cancelLongPress()
  observer?.disconnect()
  observer = null
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKeyDown)
  motionQuery?.removeEventListener('change', onMotionChange)
  motionQuery = null
  ctx = null
  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>
    delete w.__heroMapStats
    delete w.__heroGame
  }
})
</script>

<template>
  <div class="hero-map relative h-full w-full">
    <canvas
      ref="canvasRef"
      class="hero-canvas block h-full w-full"
      :class="{ 'is-hot': isHot, 'is-dragging': isDragging, 'is-game': gameActive }"
      aria-hidden="true"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @pointerleave="onPointerLeave"
      @contextmenu.prevent
    ></canvas>
    <GameHud v-if="gameActive" :hud="hud" :term-team="termTeam" :pending="rulesPending" @exit="exitGame" />
  </div>
</template>

<style scoped>
.hero-canvas {
  /* Page still scrolls over the board on touch; the game takes the gesture. */
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.hero-canvas.is-hot {
  cursor: grab;
}
.hero-canvas.is-dragging {
  cursor: grabbing;
}
.hero-canvas.is-game {
  touch-action: none;
}
</style>
