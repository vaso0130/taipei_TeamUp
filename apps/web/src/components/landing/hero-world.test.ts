import { describe, expect, it } from 'vitest'
import { WORLD, createHeroWorld, nodeCountFor } from './hero-world.js'

/** Deterministic LCG so node layout and route picks are reproducible. */
function seeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

const color = (i: number) => `c${i}`

describe('hero-world', () => {
  it('node count follows the width formula (40 at 375px, capped at 70)', () => {
    expect(nodeCountFor(375)).toBe(40)
    expect(nodeCountFor(200)).toBe(40)
    expect(nodeCountFor(735)).toBe(70)
    expect(nodeCountFor(1440)).toBe(70)
  })

  it('builds nodes inside the board and keeps them inside while drifting', () => {
    const world = createHeroWorld({ width: 800, height: 600, colorForIndex: color, random: seeded(1) })
    expect(world.nodes).toHaveLength(nodeCountFor(800))
    for (let i = 0; i < 600; i++) world.step(100) // one minute
    for (const n of world.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(800)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })

  it('spawns 4–5 station routes in cyclic colours and walks them through drawing → hold → fade', () => {
    const world = createHeroWorld({ width: 800, height: 600, colorForIndex: color, random: seeded(2) })
    world.spawnRoute()
    const r = world.routes[0]!
    expect(r.nodes.length).toBeGreaterThanOrEqual(WORLD.ROUTE_MIN_NODES)
    expect(r.nodes.length).toBeLessThanOrEqual(WORLD.ROUTE_MAX_NODES)
    expect(r.color).toBe('c0')
    expect(r.phase).toBe('drawing')
    world.setSpawnPaused(true) // isolate this route
    world.step((r.nodes.length - 1) * WORLD.SEGMENT_MS)
    expect(r.phase).toBe('hold')
    world.step(WORLD.HOLD_MS)
    expect(r.phase).toBe('fade')
    world.step(WORLD.FADE_MS)
    expect(world.routes).toHaveLength(0)
  })

  it('never exceeds MAX_ROUTES and pauses spawning when asked', () => {
    const world = createHeroWorld({ width: 800, height: 600, colorForIndex: color, random: seeded(3) })
    for (let i = 0; i < 300; i++) {
      world.step(100)
      expect(world.routes.length).toBeLessThanOrEqual(WORLD.MAX_ROUTES)
    }
    world.clearRoutes()
    world.setSpawnPaused(true)
    for (let i = 0; i < 100; i++) world.step(100)
    expect(world.routes).toHaveLength(0)
    world.setSpawnPaused(false)
    for (let i = 0; i < 50; i++) world.step(100)
    expect(world.routes.length).toBeGreaterThan(0)
  })

  it('pickRoute(want) returns exactly `want` distinct free nodes, or null when the board is short', () => {
    const world = createHeroWorld({ width: 800, height: 600, colorForIndex: color, random: seeded(4) })
    const six = world.pickRoute(6)!
    expect(six).toHaveLength(6)
    expect(new Set(six).size).toBe(6)
    expect(world.pickRoute(world.nodes.length + 1)).toBeNull()
    // frozen and reserved nodes are off limits to the auto routes
    world.freeze([six[0]!])
    world.setReserved([six[1]!])
    for (let i = 0; i < 20; i++) {
      const picked = world.pickRoute(5)!
      expect(picked).not.toContain(six[0])
      expect(picked).not.toContain(six[1])
    }
  })

  it('frozen nodes stop drifting until unfrozen; reserved ones keep moving', () => {
    const world = createHeroWorld({ width: 800, height: 600, colorForIndex: color, random: seeded(5) })
    const a = { ...world.nodes[0]! }
    const b = { ...world.nodes[1]! }
    world.freeze([0])
    world.setReserved([1])
    world.step(1000)
    expect(world.nodes[0]!.x).toBe(a.x)
    expect(world.nodes[0]!.y).toBe(a.y)
    expect(world.nodes[1]!.x).not.toBe(b.x)
    world.unfreeze()
    world.step(1000)
    expect(world.nodes[0]!.x).not.toBe(a.x)
  })

  it('nearestNode honours the radius and the exclusion set', () => {
    const world = createHeroWorld({ width: 800, height: 600, colorForIndex: color, random: seeded(6) })
    const n = world.nodes[7]!
    expect(world.nearestNode(n.x + 5, n.y, 14)).toBe(7)
    expect(world.nearestNode(n.x + 5, n.y, 14, new Set([7]))).not.toBe(7)
    expect(world.nearestNode(-500, -500, 14)).toBe(-1)
  })

  it('resize rebuilds the field and clears routes and freezes', () => {
    const world = createHeroWorld({ width: 375, height: 600, colorForIndex: color, random: seeded(7) })
    world.spawnRoute()
    world.freeze([0])
    world.resize(1440, 800)
    expect(world.width).toBe(1440)
    expect(world.nodes).toHaveLength(70)
    expect(world.routes).toHaveLength(0)
    const before = world.nodes[0]!.x
    world.step(1000)
    expect(world.nodes[0]!.x).not.toBe(before)
  })
})
