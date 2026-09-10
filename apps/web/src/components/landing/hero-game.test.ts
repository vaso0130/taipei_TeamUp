import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULES,
  GAME,
  HINT_FAIL,
  HINT_FIRST,
  createGame,
  gainFor,
  limitFor,
  pickTargets,
  stationsFor,
  type GameEvent,
  type GameRules,
  type GameStorage,
  type GameWorld,
} from './hero-game.js'

/** A 10×10 grid of people 100px apart; pickRoute hands out the first `want` free indices. */
function gridWorld(spacing = 100, size = 10): GameWorld {
  const nodes: { x: number; y: number }[] = []
  for (let i = 0; i < size * size; i++) nodes.push({ x: (i % size) * spacing, y: Math.floor(i / size) * spacing })
  return {
    nodes,
    pickRoute: (want) => (want <= nodes.length ? nodes.map((_, i) => i).slice(0, want) : null),
  }
}

function memoryStorage(initial: Record<string, string> = {}): GameStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v
    },
  }
}

interface Harness {
  game: ReturnType<typeof createGame>
  events: GameEvent[]
  clock: { now: number }
  storage: ReturnType<typeof memoryStorage>
}

function harness(rules: Partial<GameRules> = {}, world: GameWorld = gridWorld()): Harness {
  const events: GameEvent[] = []
  const clock = { now: 1_000_000 }
  const storage = memoryStorage()
  const game = createGame({
    world,
    rules,
    now: () => clock.now,
    random: () => 0.5, // deterministic shuffles
    storage,
    colorForIndex: (i) => `c${i}`,
    onEvent: (e) => events.push(e),
  })
  return { game, events, clock, storage }
}

/** Connect every target in order, ticking `beforeMs` first. Returns the snap results. */
function playRound(h: Harness, beforeMs = 0) {
  const { game } = h
  if (beforeMs) game.tick(beforeMs)
  const targets = [...game.hud().targets]
  expect(game.onGrab(targets[0]!)).toBe(true)
  const results = targets.slice(1).map((t) => game.onSnap(t))
  return { targets, results }
}

describe('formulas (spec: 難度與節奏, 計分)', () => {
  it('stations start at minStations and climb by one every two wins, capped at maxStations', () => {
    const rules: GameRules = { ...DEFAULT_RULES, minStations: 3, maxStations: 6 }
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((s) => stationsFor(rules, s))).toEqual([3, 3, 4, 4, 5, 5, 6, 6, 6])
  })

  it('defaults to the seed 4/5 without event data', () => {
    expect(stationsFor(DEFAULT_RULES, 0)).toBe(4)
    expect(stationsFor(DEFAULT_RULES, 99)).toBe(5)
  })

  it('time limit = 6s + 1.5s × stations, −0.5s per two wins, floored at 4s + 1s × stations', () => {
    expect(limitFor(4, 0)).toBe(12_000)
    expect(limitFor(5, 2)).toBe(13_000)
    expect(limitFor(5, 3)).toBe(13_000)
    // floor for 3 stations is 7000; base 10500 − 4000 (16 wins) would be 6500
    expect(limitFor(3, 14)).toBe(7_000)
    expect(limitFor(3, 16)).toBe(7_000)
  })

  it('score = stations × 10 + rounded remaining seconds × 2, +10 from the third consecutive win', () => {
    expect(gainFor(4, 10_000, 1)).toBe(60)
    expect(gainFor(4, 10_499, 1)).toBe(60) // rounds down
    expect(gainFor(4, 10_500, 1)).toBe(62) // rounds up
    expect(gainFor(4, 0, 2)).toBe(40)
    expect(gainFor(4, 0, 3)).toBe(50)
  })
})

describe('target picking', () => {
  it('reuses the nearest-neighbour chain and keeps consecutive targets ≥ 60px apart when possible', () => {
    // 1D chain 30px apart: any adjacent pair in chain order is too close, but
    // a shuffle can separate them (e.g. 0,2,4,1,3 → gaps 60,60,90,60).
    const nodes = [0, 1, 2, 3, 4].map((i) => ({ x: i * 30, y: 0 }))
    const world: GameWorld = { nodes, pickRoute: (want) => [0, 1, 2, 3, 4].slice(0, want) }
    let seed = 7
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    const targets = pickTargets(world, 5, random)!
    expect([...targets].sort()).toEqual([0, 1, 2, 3, 4])
    for (let i = 1; i < targets.length; i++) {
      expect(Math.abs(nodes[targets[i]!]!.x - nodes[targets[i - 1]!]!.x)).toBeGreaterThanOrEqual(60)
    }
  })

  it('falls back to fewer stations when the board cannot supply enough free people', () => {
    const world: GameWorld = { nodes: gridWorld().nodes, pickRoute: (want) => (want > 3 ? null : [0, 1, 2].slice(0, want)) }
    expect(pickTargets(world, 5, () => 0.5)).toHaveLength(3)
  })

  it('returns null when not even two people are free', () => {
    expect(pickTargets({ nodes: [], pickRoute: () => null }, 4, () => 0.5)).toBeNull()
  })
})

describe('state machine', () => {
  it('starts idle, enters a round on start() with the first-round hint', () => {
    const h = harness()
    expect(h.game.state).toBe('idle')
    h.game.start()
    const hud = h.game.hud()
    expect(h.game.state).toBe('round')
    expect(hud.stations).toBe(4)
    expect(hud.targets).toHaveLength(4)
    expect(hud.limitMs).toBe(12_000)
    expect(hud.timeLeftMs).toBe(12_000)
    expect(hud.hint).toBe(HINT_FIRST)
    expect(hud.progress).toBe(0)
    expect(hud.color).toBe('c0')
    expect(h.events.map((e) => e.type)).toEqual(['start', 'round'])
  })

  it('start() is a no-op while running; stop() returns to idle and emits once', () => {
    const h = harness()
    h.game.start()
    h.game.start()
    expect(h.events.filter((e) => e.type === 'start')).toHaveLength(1)
    h.game.stop()
    h.game.stop()
    expect(h.game.state).toBe('idle')
    expect(h.game.hud().targets).toHaveLength(0)
    expect(h.events.filter((e) => e.type === 'stop')).toEqual([{ type: 'stop', reason: 'user' }])
  })

  it('only the start (or the last connected station) can be grabbed; others flash wrong', () => {
    const h = harness()
    h.game.start()
    const [start, second, third] = h.game.hud().targets
    expect(h.game.onGrab(second!)).toBe(false)
    expect(h.events.at(-1)).toEqual({ type: 'wrong', node: second })
    expect(h.game.onGrab(start!)).toBe(true)
    expect(h.game.hud().progress).toBe(1)
    expect(h.game.onSnap(second!)).toBe('ok')
    h.game.onRelease()
    expect(h.game.grabbed).toBe(false)
    // re-pull from the last connected station
    expect(h.game.onGrab(second!)).toBe(true)
    expect(h.game.onSnap(third!)).toBe('ok')
    expect(h.game.hud().progress).toBe(3)
    // re-grabbing the start restarts the line
    expect(h.game.onGrab(start!)).toBe(true)
    expect(h.game.hud().progress).toBe(1)
  })

  it('snapping the wrong station is rejected without breaking the line', () => {
    const h = harness()
    h.game.start()
    const [start, second, third] = h.game.hud().targets
    h.game.onGrab(start!)
    expect(h.game.onSnap(third!)).toBe('wrong')
    expect(h.game.onSnap(99)).toBe('wrong')
    expect(h.game.hud().progress).toBe(1)
    expect(h.game.state).toBe('round')
    expect(h.game.onSnap(second!)).toBe('ok')
  })

  it('snapping without a grab does nothing', () => {
    const h = harness()
    h.game.start()
    const [, second] = h.game.hud().targets
    expect(h.game.onSnap(second!)).toBe('wrong')
    expect(h.events.some((e) => e.type === 'snap' || e.type === 'wrong')).toBe(false)
  })

  it('completing the chain scores stations × 10 + remaining seconds × 2 and starts a streak', () => {
    const h = harness()
    h.game.start()
    const { results } = playRound(h, 2_000) // 10 s left
    expect(results).toEqual(['ok', 'ok', 'complete'])
    expect(h.game.state).toBe('success')
    const hud = h.game.hud()
    expect(hud.score).toBe(4 * 10 + 10 * 2)
    expect(hud.streak).toBe(1)
    expect(hud.wins).toBe(1)
    expect(hud.best).toBe(60)
    expect(hud.hint).toBe('成隊伍！+60')
    const success = h.events.find((e) => e.type === 'success')
    expect(success).toMatchObject({ type: 'success', gain: 60, elapsedMs: 2_000, color: 'c0' })
  })

  it('the next round begins after SUCCESS_MS with a new colour; difficulty rises every two wins to maxStations', () => {
    const h = harness()
    h.game.start()
    const seen: number[] = []
    for (let round = 0; round < 6; round++) {
      seen.push(h.game.hud().stations)
      playRound(h)
      h.game.tick(GAME.SUCCESS_MS - 1)
      expect(h.game.state).toBe('success')
      h.game.tick(1)
      expect(h.game.state).toBe('round')
    }
    expect(seen).toEqual([4, 4, 5, 5, 5, 5])
    expect(h.game.hud().color).toBe('c6')
    // third win onwards adds the streak bonus
    const gains = h.events.filter((e) => e.type === 'success').map((e) => (e.type === 'success' ? e.gain : 0))
    expect(gains[0]).toBe(4 * 10 + 12 * 2)
    expect(gains[1]).toBe(4 * 10 + 12 * 2)
    expect(gains[2]).toBe(5 * 10 + 13 * 2 + 10) // streak 2 → 5 stations, limit 13 500 − 500 = 13 000; bonus from the 3rd win
  })

  it('shorter limits with the streak, never below the floor', () => {
    const h = harness({ minStations: 3, maxStations: 3 })
    h.game.start()
    const limits: number[] = []
    for (let round = 0; round < 18; round++) {
      limits.push(h.game.hud().limitMs)
      playRound(h)
      h.game.tick(GAME.SUCCESS_MS)
    }
    expect(limits[0]).toBe(10_500)
    expect(limits[2]).toBe(10_000)
    expect(limits[4]).toBe(9_500)
    expect(limits[14]).toBe(7_000)
    expect(limits[16]).toBe(7_000) // floor holds
  })

  it('running out of time fails the round, resets the streak and restarts after FAIL_MS', () => {
    const h = harness()
    h.game.start()
    playRound(h)
    h.game.tick(GAME.SUCCESS_MS)
    playRound(h)
    h.game.tick(GAME.SUCCESS_MS)
    expect(h.game.hud().stations).toBe(5)
    const [start, second] = h.game.hud().targets
    h.game.onGrab(start!)
    h.game.onSnap(second!)
    h.game.tick(h.game.hud().limitMs)
    expect(h.game.state).toBe('fail')
    const hud = h.game.hud()
    expect(hud.streak).toBe(0)
    expect(hud.wins).toBe(2)
    expect(hud.hint).toBe(HINT_FAIL)
    expect(hud.timeLeftMs).toBe(0)
    expect(h.events.at(-1)).toMatchObject({ type: 'fail', connected: [start, second] })
    h.game.tick(GAME.FAIL_MS)
    expect(h.game.state).toBe('round')
    expect(h.game.hud().stations).toBe(4) // back to the first-round size
    expect(h.game.hud().score).toBeGreaterThan(0) // score is kept
  })

  it('stops itself after IDLE_MS without interaction; any interaction resets the clock', () => {
    const h = harness()
    h.game.start()
    h.clock.now += GAME.IDLE_MS - 1
    h.game.tick(16)
    expect(h.game.state).toBe('round')
    h.game.touch()
    h.clock.now += GAME.IDLE_MS - 1
    h.game.tick(16)
    expect(h.game.state).toBe('round')
    h.clock.now += 1
    h.game.tick(16)
    expect(h.game.state).toBe('idle')
    expect(h.events.at(-1)).toEqual({ type: 'stop', reason: 'idle' })
    expect(h.game.idleMs).toBe(GAME.IDLE_MS)
  })

  it('leaves the game when the board cannot supply targets', () => {
    const h = harness({}, { nodes: [], pickRoute: () => null })
    h.game.start()
    expect(h.game.state).toBe('idle')
    expect(h.events.map((e) => e.type)).toEqual(['start', 'stop'])
    expect(h.events.at(-1)).toEqual({ type: 'stop', reason: 'no_targets' })
  })
})

describe('event rules injection (最高原則：活動規則不寫死)', () => {
  const bookclub: Partial<GameRules> = {
    minStations: 3,
    maxStations: 6,
    termTeam: '讀書會',
    termMember: '書友',
    roleLabels: ['導讀人', '場地與時間協調', '筆記手'],
  }

  it('uses minMembers/maxMembers and the event terminology', () => {
    const h = harness(bookclub)
    h.game.start()
    expect(h.game.hud().stations).toBe(3)
    expect(h.game.hud().subtitle).toBe('把 3 位書友連起來')
    expect(h.game.hud().limitMs).toBe(10_500)
    playRound(h, 500) // 10 s left
    expect(h.game.hud().hint).toBe('成讀書會！+50')
  })

  it('climbs to the event maximum and stays there', () => {
    const h = harness(bookclub)
    h.game.start()
    const seen: number[] = []
    for (let round = 0; round < 9; round++) {
      seen.push(h.game.hud().stations)
      playRound(h)
      h.game.tick(GAME.SUCCESS_MS)
    }
    expect(seen).toEqual([3, 3, 4, 4, 5, 5, 6, 6, 6])
  })

  it('shows role labels cyclically after three teams formed; never without role data', () => {
    const h = harness(bookclub)
    h.game.start()
    for (let round = 0; round < 3; round++) {
      expect(h.game.hud().showRoles).toBe(false)
      expect(h.game.hud().roleLabelFor(0)).toBeNull()
      playRound(h)
      h.game.tick(GAME.SUCCESS_MS)
    }
    const hud = h.game.hud()
    expect(hud.showRoles).toBe(true)
    expect([0, 1, 2, 3, 4].map((i) => hud.roleLabelFor(i))).toEqual(['導讀人', '場地與時間協調', '筆記手', '導讀人', '場地與時間協調'])

    const plain = harness({ minStations: 3, maxStations: 6 })
    plain.game.start()
    for (let round = 0; round < 3; round++) {
      playRound(plain)
      plain.game.tick(GAME.SUCCESS_MS)
    }
    expect(plain.game.hud().showRoles).toBe(false)
  })

  it('falls back to seed defaults (4/5, 隊伍/成員) without event data', () => {
    const h = harness()
    h.game.start()
    expect(h.game.hud().stations).toBe(4)
    expect(h.game.hud().subtitle).toBe('把 4 位成員連起來')
    playRound(h)
    expect(h.game.hud().hint).toMatch(/^成隊伍！\+\d+$/)
  })
})

describe('best score storage (session only, injected)', () => {
  it('reads the previous best from storage and writes a new one only when beaten', () => {
    const storage = memoryStorage({ [GAME.STORAGE_KEY]: '70' })
    const game = createGame({ world: gridWorld(), storage, random: () => 0.5 })
    game.start()
    expect(game.hud().best).toBe(70)
    game.tick(11_000) // 1 s left → 40 + 2 = 42 < 70
    const targets = [...game.hud().targets]
    game.onGrab(targets[0]!)
    for (const t of targets.slice(1)) game.onSnap(t)
    expect(game.hud().score).toBe(42)
    expect(game.hud().best).toBe(70)
    expect(storage.data[GAME.STORAGE_KEY]).toBe('70')
    game.tick(GAME.SUCCESS_MS)
    const next = [...game.hud().targets]
    game.onGrab(next[0]!)
    for (const t of next.slice(1)) game.onSnap(t)
    expect(game.hud().score).toBeGreaterThan(70)
    expect(storage.data[GAME.STORAGE_KEY]).toBe(String(game.hud().score))
  })

  it('ignores garbage in storage and survives a throwing storage', () => {
    const bad = memoryStorage({ [GAME.STORAGE_KEY]: 'nope' })
    expect(createGame({ world: gridWorld(), storage: bad }).hud().best).toBe(0)
    const throwing: GameStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const game = createGame({ world: gridWorld(), storage: throwing, random: () => 0.5 })
    game.start()
    const targets = [...game.hud().targets]
    game.onGrab(targets[0]!)
    for (const t of targets.slice(1)) game.onSnap(t)
    expect(game.hud().best).toBe(game.hud().score)
  })

  it('a new session starts from zero when no storage is given', () => {
    const game = createGame({ world: gridWorld() })
    expect(game.hud().best).toBe(0)
  })
})
