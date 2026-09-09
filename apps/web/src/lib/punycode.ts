/**
 * Minimal RFC 3492 decoder for IDN labels ("xn--ej4a" → "配"). Only the
 * decode direction is needed: showing a human-readable sender domain next
 * to the punycode one so a Chinese-speaking user does not mistake
 * "noreply@xn--ej4a.taipei" for phishing.
 */
const BASE = 36
const T_MIN = 1
const T_MAX = 26
const SKEW = 38
const DAMP = 700
const INITIAL_BIAS = 72
const INITIAL_N = 128

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1
  d += Math.floor(d / numPoints)
  let k = 0
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN))
    k += BASE
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW))
}

function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26 // 0-9
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 // a-z
  return BASE
}

function decodeLabel(input: string): string {
  const output: number[] = []
  const lastDash = input.lastIndexOf('-')
  for (let i = 0; i < Math.max(lastDash, 0); i++) {
    const c = input.charCodeAt(i)
    if (c >= 0x80) throw new Error('not basic')
    output.push(c)
  }
  let n = INITIAL_N
  let bias = INITIAL_BIAS
  let i = 0
  let index = lastDash > 0 ? lastDash + 1 : 0
  while (index < input.length) {
    const oldI = i
    let w = 1
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) throw new Error('truncated')
      const digit = digitValue(input.charCodeAt(index++))
      if (digit >= BASE) throw new Error('bad digit')
      i += digit * w
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias
      if (digit < t) break
      w *= BASE - t
    }
    const len = output.length + 1
    bias = adapt(i - oldI, len, oldI === 0)
    n += Math.floor(i / len)
    i %= len
    output.splice(i++, 0, n)
  }
  return String.fromCodePoint(...output)
}

/** Decode every "xn--" label of a domain; returns the input unchanged on failure. */
export function domainToUnicode(domain: string): string {
  try {
    return domain
      .split('.')
      .map((label) =>
        label.toLowerCase().startsWith('xn--') ? decodeLabel(label.slice(4)) : label,
      )
      .join('.')
  } catch {
    return domain
  }
}

/** "noreply@xn--ej4a.taipei" → "noreply@配.taipei" (unchanged when already ASCII-only). */
export function emailToUnicode(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 0) return address
  return `${address.slice(0, at)}@${domainToUnicode(address.slice(at + 1))}`
}
