/**
 * Runs first in the app bundle (imported at the top of main.ts) and
 * stamps the theme class on <html> before Vue mounts, so a stored dark
 * preference does not flash light. The OS preference itself is already
 * honoured at first paint by the CSS media block in main.css; a true
 * pre-bundle inline script would need a CSP hash (script-src is 'self').
 */
import { applyThemeClass, readThemePreference } from './lib/theme.js'

applyThemeClass(readThemePreference())
