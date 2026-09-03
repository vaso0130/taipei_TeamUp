// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export const containsControlChars = (s: string): boolean => CONTROL_CHARS.test(s)
