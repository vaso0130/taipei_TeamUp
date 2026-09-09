/**
 * Theme persistence shared by the pre-paint boot script and the header
 * toggle. Three states: explicit dark, explicit light, or "follow the
 * system" when nothing is stored.
 */
export const THEME_KEY = 'tpe-theme'

export type ThemePreference = 'dark' | 'light' | null

export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null
  }
}

export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** Effective theme: stored choice wins, otherwise the OS setting. */
export function resolveDark(pref: ThemePreference = readThemePreference()): boolean {
  return pref === null ? systemPrefersDark() : pref === 'dark'
}

/**
 * Reflect the choice on <html>. `.dark` drives the token swap; `.light`
 * only exists to override the prefers-color-scheme media block when the
 * user explicitly picked light on a dark OS.
 */
export function applyThemeClass(pref: ThemePreference) {
  const root = document.documentElement
  const dark = resolveDark(pref)
  root.classList.toggle('dark', dark)
  root.classList.toggle('light', pref === 'light')
}
