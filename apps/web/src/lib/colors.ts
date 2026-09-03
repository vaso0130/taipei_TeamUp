/**
 * MRT-line inspired dot palette, assigned to skill categories by index —
 * category names are event data, so colors are cyclic, never hardcoded
 * per category.
 */
const DOT_COLORS = [
  '#c92a2a', // 紅
  '#1971c2', // 藍
  '#2b8a3e', // 綠
  '#c2410c', // 橘
  '#8b5e3c', // 棕
  '#0b7285', // 藍綠
] as const

export function dotColorForIndex(index: number): string {
  return DOT_COLORS[index % DOT_COLORS.length]!
}
