/**
 * The night MRT board's "world": drifting people (nodes), auto-generated
 * routes in MRT line colours, and the drawing routines that render both.
 * Pure TypeScript — no DOM, no rAF — so HeroMap.vue can own the canvas and
 * events, hero-game.ts can pick targets from it, and both are unit-testable.
 *
 * Behaviour and every constant match the original in-component animation
 * (docs/design/landing-and-event-layer.md §1). Additions for the easter egg
 * (docs/design/landing-game.md): `freeze()` (frozen nodes stop drifting),
 * `setReserved()` (nodes the auto routes must leave alone), `setSpawnPaused()`
 * and `nearestNode()` for hit-testing.
 */

export interface Point {
  x: number
  y: number
}
export interface WorldNode extends Point {
  vx: number
  vy: number
}
export type RoutePhase = 'drawing' | 'hold' | 'fade'
export interface WorldRoute {
  nodes: number[]
  color: string
  phase: RoutePhase
  /** Milliseconds elapsed in the current phase. */
  t: number
}

// ---- tuning (values from the design spec) ----
export const WORLD = {
  SEGMENT_MS: 180,
  HOLD_MS: 1800,
  FADE_MS: 600,
  SPAWN_MIN_MS: 2500,
  SPAWN_MAX_MS: 4000,
  MAX_ROUTES: 3,
  /** Demo animation chain length (an animation constant, not a team rule). */
  ROUTE_MIN_NODES: 4,
  ROUTE_MAX_NODES: 5,
  NODE_MIN: 40,
  NODE_MAX: 70,
  DRIFT_MIN_PX_S: 3,
  DRIFT_MAX_PX_S: 8,
  STATIC_ROUTES: 3,
} as const

// Hero palette is fixed (the board does not follow the light/dark theme).
export const BOARD = {
  BG: '#16302b',
  NODE_RGB: '255, 255, 255',
  NODE_ALPHA: 0.42,
  NODE_RADIUS: 2.4,
  NODE_RING_WIDTH: 1,
  LINE_WIDTH: 3,
} as const

export interface HeroWorldOptions {
  width: number
  height: number
  colorForIndex: (index: number) => string
  /** Injectable for deterministic tests; defaults to Math.random. */
  random?: () => number
}

export interface RouteDrawOptions {
  completeHops: number
  /** 0–1 progress of the hop after `completeHops`. */
  partial: number
  alpha: number
  /** Extra roundel radius (hold-phase breathing). */
  pulse: number
  originRoundel: boolean
  destRoundel: boolean
}

export interface HeroWorld {
  readonly width: number
  readonly height: number
  readonly nodes: readonly WorldNode[]
  readonly routes: readonly WorldRoute[]
  /** Rebuild the node field for a new size (also clears routes). */
  resize(width: number, height: number): void
  step(dt: number): void
  draw(ctx: CanvasRenderingContext2D): void
  /** Reduced motion: one still frame with a few routes already connected. */
  drawStatic(ctx: CanvasRenderingContext2D): void
  clearRoutes(): void
  spawnRoute(phase?: RoutePhase): void
  /**
   * Greedy nearest-neighbour chain from a random free seed. Without `want`
   * it picks the demo length (4–5); with `want` it returns exactly that many
   * or null when not enough free nodes exist.
   */
  pickRoute(want?: number): number[] | null
  /** Frozen nodes stop drifting and are skipped by the auto routes. */
  freeze(indices: Iterable<number>): void
  unfreeze(): void
  /** Reserved nodes keep drifting but the auto routes leave them alone. */
  setReserved(indices: Iterable<number>): void
  setSpawnPaused(paused: boolean): void
  /** Index of the closest node within `radius`, or -1. */
  nearestNode(x: number, y: number, radius: number, exclude?: ReadonlySet<number>): number
  /** Nodes currently part of any auto route. */
  busyNodes(): Set<number>
}

export function nodeCountFor(w: number): number {
  return Math.max(WORLD.NODE_MIN, Math.min(WORLD.NODE_MAX, WORLD.NODE_MIN + Math.floor((w - 375) / 12)))
}

// ---- drawing primitives (shared with the interaction overlay) ----

/**
 * Octilinear hop a→b: a 45° diagonal then a straight run (transit-map
 * geometry). Traces the first `progress` (0–1) of the hop's length.
 */
export function traceHop(c: CanvasRenderingContext2D, a: Point, b: Point, progress: number) {
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

export function drawRoundel(c: CanvasRenderingContext2D, n: Point, color: string, r: number) {
  c.beginPath()
  c.arc(n.x, n.y, r, 0, Math.PI * 2)
  c.fillStyle = '#ffffff'
  c.fill()
  c.beginPath()
  c.arc(n.x, n.y, r * 0.55, 0, Math.PI * 2)
  c.fillStyle = color
  c.fill()
}

export function drawStation(c: CanvasRenderingContext2D, n: Point, color: string) {
  c.beginPath()
  c.arc(n.x, n.y, 3, 0, Math.PI * 2)
  c.fillStyle = '#ffffff'
  c.fill()
  c.lineWidth = 1.5
  c.strokeStyle = color
  c.stroke()
}

/** A route through `pts`: octilinear hops, intermediate stations, terminal roundels. */
export function drawRouteGeometry(
  c: CanvasRenderingContext2D,
  pts: readonly Point[],
  color: string,
  o: RouteDrawOptions,
) {
  const hops = pts.length - 1
  const completeHops = Math.min(hops, o.completeHops)
  c.globalAlpha = o.alpha

  c.lineWidth = BOARD.LINE_WIDTH
  c.lineCap = 'round'
  c.lineJoin = 'round'
  c.strokeStyle = color
  c.beginPath()
  for (let i = 0; i < completeHops; i++) traceHop(c, pts[i]!, pts[i + 1]!, 1)
  if (completeHops < hops && o.partial > 0) {
    traceHop(c, pts[completeHops]!, pts[completeHops + 1]!, o.partial)
  }
  c.stroke()

  // Intermediate stations appear as the train reaches them.
  for (let i = 1; i < Math.min(completeHops + 1, hops); i++) {
    drawStation(c, pts[i]!, color)
  }
  // Terminals: origin lit from the start, destination when the line arrives.
  if (o.originRoundel) drawRoundel(c, pts[0]!, color, 6 + o.pulse)
  if (o.destRoundel && completeHops >= hops) drawRoundel(c, pts[hops]!, color, 6 + o.pulse)
  c.globalAlpha = 1
}

// ---- world ----

export function createHeroWorld(opts: HeroWorldOptions): HeroWorld {
  const random = opts.random ?? Math.random
  const rand = (min: number, max: number) => min + random() * (max - min)

  let width = Math.max(1, opts.width)
  let height = Math.max(1, opts.height)
  let nodes: WorldNode[] = []
  let routes: WorldRoute[] = []
  let routeCounter = 0
  let spawnIn = 0
  let spawnPaused = false
  let frozen = new Set<number>()
  let reserved = new Set<number>()

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
      const speed = rand(WORLD.DRIFT_MIN_PX_S, WORLD.DRIFT_MAX_PX_S)
      nodes.push({
        x: (c + 0.5) * cw + rand(-0.4, 0.4) * cw,
        y: (r + 0.5) * ch + rand(-0.4, 0.4) * ch,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
      })
    }
    routes = []
    frozen = new Set()
    reserved = new Set()
    spawnIn = rand(WORLD.SPAWN_MIN_MS, WORLD.SPAWN_MAX_MS) * 0.3 // first route arrives early
  }

  function busyNodes(): Set<number> {
    const set = new Set<number>()
    for (const r of routes) for (const i of r.nodes) set.add(i)
    return set
  }

  /** Busy for the purpose of picking a new auto route: routed, frozen or reserved. */
  function unavailableNodes(): Set<number> {
    const set = busyNodes()
    for (const i of frozen) set.add(i)
    for (const i of reserved) set.add(i)
    return set
  }

  function pickRoute(want?: number): number[] | null {
    const busy = unavailableNodes()
    const free = nodes.map((_, i) => i).filter((i) => !busy.has(i))
    const count = want ?? Math.floor(rand(WORLD.ROUTE_MIN_NODES, WORLD.ROUTE_MAX_NODES + 1))
    if (free.length < count) return null
    const chain = [free[Math.floor(random() * free.length)]!]
    const used = new Set(chain)
    while (chain.length < count) {
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
    if (want !== undefined) return chain.length === want ? chain : null
    return chain.length >= WORLD.ROUTE_MIN_NODES ? chain : null
  }

  function spawnRoute(phase: RoutePhase = 'drawing') {
    const picked = pickRoute()
    if (!picked) return
    routes.push({ nodes: picked, color: opts.colorForIndex(routeCounter++), phase, t: 0 })
  }

  function step(dt: number) {
    const s = dt / 1000
    for (let i = 0; i < nodes.length; i++) {
      if (frozen.has(i)) continue
      const n = nodes[i]!
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
      const drawMs = (r.nodes.length - 1) * WORLD.SEGMENT_MS
      if (r.phase === 'drawing' && r.t >= drawMs) {
        r.phase = 'hold'
        r.t -= drawMs
      } else if (r.phase === 'hold' && r.t >= WORLD.HOLD_MS) {
        r.phase = 'fade'
        r.t -= WORLD.HOLD_MS
      }
    }
    routes = routes.filter((r) => !(r.phase === 'fade' && r.t >= WORLD.FADE_MS))

    if (spawnPaused) return
    spawnIn -= dt
    if (spawnIn <= 0) {
      if (routes.length < WORLD.MAX_ROUTES) spawnRoute()
      spawnIn = rand(WORLD.SPAWN_MIN_MS, WORLD.SPAWN_MAX_MS)
    }
  }

  function drawRoute(c: CanvasRenderingContext2D, r: WorldRoute) {
    const hops = r.nodes.length - 1
    let completeHops = hops
    let partial = 0
    if (r.phase === 'drawing') {
      completeHops = Math.min(hops, Math.floor(r.t / WORLD.SEGMENT_MS))
      partial = (r.t % WORLD.SEGMENT_MS) / WORLD.SEGMENT_MS
    }
    drawRouteGeometry(
      c,
      r.nodes.map((i) => nodes[i]!),
      r.color,
      {
        completeHops,
        partial,
        alpha: r.phase === 'fade' ? Math.max(0, 1 - r.t / WORLD.FADE_MS) : 1,
        pulse: r.phase === 'hold' ? Math.sin(r.t / 220) * 0.9 : 0,
        originRoundel: true,
        destRoundel: true,
      },
    )
  }

  function draw(c: CanvasRenderingContext2D) {
    c.fillStyle = BOARD.BG
    c.fillRect(0, 0, width, height)

    // Unconnected people: hollow station rings, not stars.
    const busy = busyNodes()
    c.strokeStyle = `rgba(${BOARD.NODE_RGB}, ${BOARD.NODE_ALPHA})`
    c.lineWidth = BOARD.NODE_RING_WIDTH
    c.beginPath()
    for (let i = 0; i < nodes.length; i++) {
      if (busy.has(i)) continue
      const n = nodes[i]!
      c.moveTo(n.x + BOARD.NODE_RADIUS, n.y)
      c.arc(n.x, n.y, BOARD.NODE_RADIUS, 0, Math.PI * 2)
    }
    c.stroke()

    for (const r of routes) drawRoute(c, r)
  }

  function drawStatic(c: CanvasRenderingContext2D) {
    routes = []
    for (let i = 0; i < WORLD.STATIC_ROUTES; i++) spawnRoute('hold')
    draw(c)
  }

  function nearestNode(x: number, y: number, radius: number, exclude?: ReadonlySet<number>): number {
    let best = -1
    let bestD = radius * radius
    for (let i = 0; i < nodes.length; i++) {
      if (exclude?.has(i)) continue
      const n = nodes[i]!
      const d = (n.x - x) ** 2 + (n.y - y) ** 2
      if (d <= bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  buildNodes()

  return {
    get width() {
      return width
    },
    get height() {
      return height
    },
    get nodes() {
      return nodes
    },
    get routes() {
      return routes
    },
    resize(w, h) {
      width = Math.max(1, w)
      height = Math.max(1, h)
      buildNodes()
    },
    step,
    draw,
    drawStatic,
    clearRoutes() {
      routes = []
    },
    spawnRoute,
    pickRoute,
    freeze(indices) {
      frozen = new Set(indices)
    },
    unfreeze() {
      frozen = new Set()
    },
    setReserved(indices) {
      reserved = new Set(indices)
    },
    setSpawnPaused(paused) {
      spawnPaused = paused
    },
    nearestNode,
    busyNodes,
  }
}
