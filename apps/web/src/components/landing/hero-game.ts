/**
 * 「湊隊」— the landing-board easter-egg game as a pure state machine
 * (docs/design/landing-game.md). No DOM, no timers of its own: HeroMap.vue
 * feeds it `tick(dt)` from the frame loop and pointer results from its
 * hit-tests, and renders whatever `hud()` says.
 *
 * Every rule that describes a team (how many stations, what a team and a
 * member are called, which roles exist) is injected through `rules` from
 * the event configuration; the fallbacks below are the seed schema defaults,
 * not a rule of any particular event.
 */

export interface GameWorld {
  readonly nodes: ReadonlyArray<{ x: number; y: number }>
  /** Nearest-neighbour chain of exactly `want` free nodes, or null. */
  pickRoute(want: number): number[] | null
}

export interface GameRules {
  minStations: number
  maxStations: number
  termTeam: string
  termMember: string
  /** Active role labels in sortOrder; empty when no event data. */
  roleLabels: string[]
}

/** Subset of the Web Storage API; the caller hands in sessionStorage (or a memory object in tests). */
export interface GameStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type GameState = 'idle' | 'round' | 'success' | 'fail'
export type SnapResult = 'ok' | 'wrong' | 'complete'
export type StopReason = 'user' | 'idle' | 'no_targets'

export type GameEvent =
  | { type: 'start' }
  | { type: 'stop'; reason: StopReason }
  | { type: 'round'; targets: number[]; color: string }
  | { type: 'snap'; node: number }
  | { type: 'wrong'; node: number }
  | { type: 'success'; gain: number; elapsedMs: number; targets: number[]; color: string }
  | { type: 'fail'; connected: number[]; color: string }

export interface GameHudState {
  state: GameState
  stations: number
  timeLeftMs: number
  limitMs: number
  score: number
  streak: number
  best: number
  wins: number
  hint: string
  /** 「把 N 位{termMember}連起來」 */
  subtitle: string
  targets: readonly number[]
  /** Number of targets connected so far (0 = none, 1 = start grabbed). */
  progress: number
  color: string
  /** Role labels decorate the targets once enough teams have formed. */
  showRoles: boolean
  roleLabelFor: (targetIndex: number) => string | null
}

export interface HeroGame {
  readonly state: GameState
  readonly idleMs: number
  readonly grabbed: boolean
  start(): void
  stop(reason?: StopReason): void
  tick(dt: number): void
  /** Pointer went down on `nodeIndex`; true when it is the start or the last connected station. */
  onGrab(nodeIndex: number): boolean
  onSnap(nodeIndex: number): SnapResult
  onRelease(): void
  /** Any interaction — resets the idle clock. */
  touch(): void
  hud(): GameHudState
}

export interface CreateGameOptions {
  world: GameWorld
  rules?: Partial<GameRules>
  /** Wall clock for idle detection (ms). */
  now?: () => number
  random?: () => number
  storage?: GameStorage
  colorForIndex?: (index: number) => string
  onEvent?: (event: GameEvent) => void
}

/**
 * Seed defaults (`EventConfigSchema` terms; 4/5 is the seed default team
 * size, see landing-game.md) — used only when no event data is available.
 */
export const DEFAULT_RULES: GameRules = {
  minStations: 4,
  maxStations: 5,
  termTeam: '隊伍',
  termMember: '成員',
  roleLabels: [],
}

/** All pacing and scoring constants live here (spec: 難度與節奏, 計分). */
export const GAME = {
  /** Round time limit: BASE + PER_STATION × stations … */
  LIMIT_BASE_MS: 6000,
  LIMIT_PER_STATION_MS: 1500,
  /** … minus STREAK_CUT every STREAK_STEP consecutive wins … */
  STREAK_STEP: 2,
  STREAK_CUT_MS: 500,
  /** … never below FLOOR_BASE + FLOOR_PER_STATION × stations. */
  FLOOR_BASE_MS: 4000,
  FLOOR_PER_STATION_MS: 1000,
  /** Difficulty: +1 station every STREAK_STEP wins, up to rules.maxStations. */
  SCORE_PER_STATION: 10,
  SCORE_PER_REMAINING_S: 2,
  STREAK_BONUS_FROM: 3,
  STREAK_BONUS: 10,
  /** How long the success / fail state lingers before the next round. */
  SUCCESS_MS: 1200,
  FAIL_MS: 1200,
  /** Shuffled targets keep at least this distance between consecutive stations. */
  MIN_TARGET_GAP_PX: 60,
  SHUFFLE_ATTEMPTS: 20,
  /** Role labels appear next to targets after this many teams formed. */
  ROLES_AFTER_WINS: 3,
  IDLE_MS: 30_000,
  STORAGE_KEY: 'teamup.landingGame.best',
} as const

export const HINT_FIRST = '按住起點，依序拉到閃爍的人'
export const HINT_FAIL = '差一點，再來一局'
export const hintSuccess = (termTeam: string, gain: number) => `成${termTeam}！+${gain}`

export function stationsFor(rules: GameRules, streak: number): number {
  const min = Math.max(1, rules.minStations)
  const max = Math.max(min, rules.maxStations)
  return Math.min(max, min + Math.floor(streak / GAME.STREAK_STEP))
}

export function limitFor(stations: number, streak: number): number {
  const base = GAME.LIMIT_BASE_MS + GAME.LIMIT_PER_STATION_MS * stations
  const cut = Math.floor(streak / GAME.STREAK_STEP) * GAME.STREAK_CUT_MS
  const floor = GAME.FLOOR_BASE_MS + GAME.FLOOR_PER_STATION_MS * stations
  return Math.max(base - cut, floor)
}

export function gainFor(stations: number, remainingMs: number, streakAfter: number): number {
  const remaining = Math.max(0, Math.round(remainingMs / 1000))
  const bonus = streakAfter >= GAME.STREAK_BONUS_FROM ? GAME.STREAK_BONUS : 0
  return stations * GAME.SCORE_PER_STATION + remaining * GAME.SCORE_PER_REMAINING_S + bonus
}

function minGap(order: readonly number[], nodes: GameWorld['nodes']): number {
  let gap = Infinity
  for (let i = 1; i < order.length; i++) {
    const a = nodes[order[i - 1]!]!
    const b = nodes[order[i]!]!
    gap = Math.min(gap, Math.hypot(a.x - b.x, a.y - b.y))
  }
  return gap
}

/**
 * Nearest-neighbour chain, then shuffled so the line criss-crosses, keeping
 * consecutive stations ≥ MIN_TARGET_GAP_PX apart when any permutation
 * allows it (otherwise the best attempt wins).
 */
export function pickTargets(world: GameWorld, want: number, random: () => number): number[] | null {
  let chain: number[] | null = null
  for (let n = want; n >= 2 && !chain; n--) chain = world.pickRoute(n)
  if (!chain) return null
  let best = chain
  let bestGap = minGap(chain, world.nodes)
  for (let attempt = 0; attempt < GAME.SHUFFLE_ATTEMPTS && bestGap < GAME.MIN_TARGET_GAP_PX; attempt++) {
    const order = chain.slice()
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const tmp = order[i]!
      order[i] = order[j]!
      order[j] = tmp
    }
    const gap = minGap(order, world.nodes)
    if (gap > bestGap) {
      best = order
      bestGap = gap
    }
  }
  return best
}

function readBest(storage: GameStorage | undefined): number {
  if (!storage) return 0
  try {
    const n = Number.parseInt(storage.getItem(GAME.STORAGE_KEY) ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

export function createGame(opts: CreateGameOptions): HeroGame {
  const rules: GameRules = { ...DEFAULT_RULES, ...opts.rules }
  const now = opts.now ?? (() => Date.now())
  const random = opts.random ?? Math.random
  const colorForIndex = opts.colorForIndex ?? (() => '#ffffff')
  const emit = (e: GameEvent) => opts.onEvent?.(e)

  let state: GameState = 'idle'
  let targets: number[] = []
  let connected = 0
  let grabbed = false
  let stations = stationsFor(rules, 0)
  let limitMs = 0
  let timeLeftMs = 0
  let phaseT = 0
  let score = 0
  let streak = 0
  let wins = 0
  let best = readBest(opts.storage)
  let hint = HINT_FIRST
  let color = colorForIndex(0)
  let roundCounter = 0
  let lastActivity = now()

  function persistBest() {
    try {
      opts.storage?.setItem(GAME.STORAGE_KEY, String(best))
    } catch {
      /* storage unavailable (private mode): best lives in memory only */
    }
  }

  function nextRound() {
    stations = stationsFor(rules, streak)
    const picked = pickTargets(opts.world, stations, random)
    if (!picked) {
      // Not enough free people on a tiny board: leave the game (from start() we are still idle).
      state = 'idle'
      targets = []
      connected = 0
      grabbed = false
      emit({ type: 'stop', reason: 'no_targets' })
      return
    }
    targets = picked
    stations = targets.length
    connected = 0
    grabbed = false
    limitMs = limitFor(stations, streak)
    timeLeftMs = limitMs
    phaseT = 0
    color = colorForIndex(roundCounter++)
    state = 'round'
    emit({ type: 'round', targets: targets.slice(), color })
  }

  function succeed() {
    grabbed = false
    streak += 1
    wins += 1
    const gain = gainFor(stations, timeLeftMs, streak)
    score += gain
    if (score > best) {
      best = score
      persistBest()
    }
    hint = hintSuccess(rules.termTeam, gain)
    state = 'success'
    phaseT = 0
    emit({ type: 'success', gain, elapsedMs: limitMs - timeLeftMs, targets: targets.slice(), color })
  }

  function fail() {
    grabbed = false
    streak = 0
    hint = HINT_FAIL
    state = 'fail'
    phaseT = 0
    timeLeftMs = 0
    emit({ type: 'fail', connected: targets.slice(0, connected), color })
  }

  function stop(reason: StopReason = 'user') {
    if (state === 'idle') return
    state = 'idle'
    targets = []
    connected = 0
    grabbed = false
    emit({ type: 'stop', reason })
  }

  return {
    get state() {
      return state
    },
    get grabbed() {
      return grabbed
    },
    idleMs: GAME.IDLE_MS,

    start() {
      if (state !== 'idle') return
      score = 0
      streak = 0
      wins = 0
      roundCounter = 0
      hint = HINT_FIRST
      lastActivity = now()
      emit({ type: 'start' })
      nextRound()
    },

    stop,

    tick(dt) {
      if (state === 'idle') return
      if (now() - lastActivity >= GAME.IDLE_MS) {
        stop('idle')
        return
      }
      if (state === 'round') {
        timeLeftMs -= dt
        if (timeLeftMs <= 0) fail()
        return
      }
      phaseT += dt
      if (state === 'success' && phaseT >= GAME.SUCCESS_MS) nextRound()
      else if (state === 'fail' && phaseT >= GAME.FAIL_MS) nextRound()
    },

    onGrab(nodeIndex) {
      lastActivity = now()
      if (state !== 'round') return false
      if (nodeIndex === targets[0]) {
        // The start is always grabbable; re-grabbing it restarts the line.
        connected = 1
        grabbed = true
        return true
      }
      if (connected > 1 && nodeIndex === targets[connected - 1]) {
        grabbed = true
        return true
      }
      emit({ type: 'wrong', node: nodeIndex })
      return false
    },

    onSnap(nodeIndex) {
      lastActivity = now()
      if (state !== 'round' || !grabbed) return 'wrong'
      if (nodeIndex === targets[connected]) {
        connected += 1
        emit({ type: 'snap', node: nodeIndex })
        if (connected === targets.length) {
          succeed()
          return 'complete'
        }
        return 'ok'
      }
      emit({ type: 'wrong', node: nodeIndex })
      return 'wrong'
    },

    onRelease() {
      lastActivity = now()
      grabbed = false
    },

    touch() {
      lastActivity = now()
    },

    hud() {
      const showRoles = wins >= GAME.ROLES_AFTER_WINS && rules.roleLabels.length > 0
      return {
        state,
        stations,
        timeLeftMs: Math.max(0, timeLeftMs),
        limitMs,
        score,
        streak,
        best,
        wins,
        hint,
        subtitle: `把 ${stations} 位${rules.termMember}連起來`,
        targets,
        progress: connected,
        color,
        showRoles,
        roleLabelFor: (i) => (showRoles ? rules.roleLabels[i % rules.roleLabels.length]! : null),
      }
    },
  }
}
