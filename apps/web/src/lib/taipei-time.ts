/**
 * Event times are entered and displayed in Asia/Taipei and stored as ISO
 * 8601 with an explicit offset. Taiwan has no daylight saving, so the
 * offset is a constant +08:00 — no time-zone database needed.
 */
const OFFSET_HOURS = 8
const OFFSET_MS = OFFSET_HOURS * 60 * 60 * 1000
export const TAIPEI_OFFSET = '+08:00'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Wall-clock parts of `t` (epoch ms) in Taipei, via a UTC-shifted Date. */
function taipeiParts(t: number) {
  const d = new Date(t + OFFSET_MS)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: WEEKDAYS[d.getUTCDay()]!,
  }
}

/** ISO string → `datetime-local` value (`YYYY-MM-DDTHH:mm`) in Taipei; '' when unparsable. */
export function isoToTaipeiLocal(iso: string | undefined | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const p = taipeiParts(t)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`
}

/**
 * `datetime-local` value (Taipei wall clock) → ISO with +08:00. Returns ''
 * for an empty or malformed value so zod's datetime check reports it as a
 * field error instead of the page throwing.
 */
export function taipeiLocalToIso(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim())
  if (!m) return ''
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}${TAIPEI_OFFSET}`
  return Number.isNaN(Date.parse(iso)) ? '' : iso
}

/** 「星期四」 for a Taipei-local or ISO value; '' when unparsable. */
export function weekdayLabel(value: string): string {
  const t = Date.parse(taipeiLocalToIso(value) || value)
  if (Number.isNaN(t)) return ''
  return `星期${taipeiParts(t).weekday}`
}

/** 「10/30（四）23:59」 — compact Taipei rendering for summaries. */
export function formatTaipeiShort(value: string, withTime = true): string {
  const t = Date.parse(taipeiLocalToIso(value) || value)
  if (Number.isNaN(t)) return ''
  const p = taipeiParts(t)
  const date = `${p.month}/${p.day}（${p.weekday}）`
  return withTime ? `${date}${pad2(p.hour)}:${pad2(p.minute)}` : date
}

/** Whole days from `from` to `to` (rounded; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(taipeiLocalToIso(from) || from)
  const b = Date.parse(taipeiLocalToIso(to) || to)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / (24 * 60 * 60 * 1000))
}

/** `YYYYMM` of the current Taipei month — for default slugs. */
export function taipeiYearMonth(now = Date.now()): string {
  const p = taipeiParts(now)
  return `${p.year}${pad2(p.month)}`
}
