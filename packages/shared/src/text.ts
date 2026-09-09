import { z } from 'zod'

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
// Same set minus the whitespace controls a multi-line field legitimately
// carries (TAB U+0009, LF U+000A, CR U+000D).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export const containsControlChars = (s: string): boolean => CONTROL_CHARS.test(s)

/** Control characters other than newline / carriage return / tab. */
export const containsForbiddenControlChars = (s: string): boolean =>
  CONTROL_CHARS_EXCEPT_WHITESPACE.test(s)

const CONTROL_CHAR_MESSAGE = '含有不允許的字元'

/**
 * Single-line free text: trimmed, bounded, no control characters at all.
 * `min` defaults to 0 so optional/empty values pass; pass 1 to require.
 */
export const singleLineText = (max: number, min = 0, message = CONTROL_CHAR_MESSAGE) =>
  z
    .string()
    .trim()
    .min(min, message)
    .max(max)
    .refine((s) => !containsControlChars(s), message)

/**
 * Multi-line free text (pitch, blurb, messages): bounded, newlines and
 * tabs allowed, every other control character (NUL included — PostgreSQL
 * rejects it) refused up front.
 */
export const multiLineText = (max: number, min = 0, message = CONTROL_CHAR_MESSAGE) =>
  z
    .string()
    .trim()
    .min(min, message)
    .max(max)
    .refine((s) => !containsForbiddenControlChars(s), message)