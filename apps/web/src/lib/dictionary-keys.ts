/**
 * Machine keys for role/skill options are generated from the label and
 * never shown as an editable field (docs/design/admin-events.md §3 ⑤).
 * Rules: Latin letters/digits → snake_case; otherwise `role_01`-style
 * counters; unique within one dictionary; existing rows keep their key.
 * The result always satisfies shared's `optionKey` (`^[a-z][a-z0-9_]*$`).
 */

export type DictionaryKind = 'role' | 'skill'

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Longest key we generate: keeps URLs/JSON readable; suffixes stay within it. */
const MAX_BASE_LENGTH = 40

function latinBase(label: string): string {
  const base = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/_+$/g, '')
  return base
}

function counterKey(kind: DictionaryKind, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const key = `${kind}_${String(n).padStart(2, '0')}`
    if (!taken.has(key)) return key
  }
}

export function generateOptionKey(
  label: string,
  taken: Iterable<string>,
  kind: DictionaryKind,
): string {
  const used = new Set(taken)
  let base = latinBase(label)
  // A digit-leading or empty base is not a valid key: fall back to counters.
  if (base && /^[0-9]/.test(base)) base = `${kind}_${base}`
  if (!base || !KEY_RE.test(base)) return counterKey(kind, used)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`
    if (!used.has(candidate)) return candidate
  }
}

export const isValidOptionKey = (key: string) => KEY_RE.test(key)
