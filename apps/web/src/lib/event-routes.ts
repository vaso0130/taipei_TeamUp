import type { EventSummary } from '@teamup/shared'

/**
 * Pure helpers behind the event-layer routing rules
 * (docs/design/landing-and-event-layer.md §2). Kept free of router/store
 * imports so the rules can be unit-checked without a browser.
 */

/** Build-time default event; empty string / undefined → none. */
export const ENV_EVENT_SLUG: string | null = import.meta.env.VITE_EVENT_SLUG || null

export const openSlugs = (summaries: readonly EventSummary[]): string[] =>
  summaries.filter((e) => e.status === 'open').map((e) => e.slug)

/**
 * Where a legacy path (`/teams`, `/people`, …) should land, in the spec's
 * three steps: the build-time slug, else the sole open event, else none
 * (caller sends the visitor to the event list).
 */
export function legacyEventSlug(
  envSlug: string | null,
  summaries: readonly EventSummary[] | null,
): string | null {
  if (envSlug) return envSlug
  const open = openSlugs(summaries ?? [])
  return open.length === 1 ? open[0]! : null
}

/**
 * Lenient default for places that need *some* event without the user
 * having picked one (profile default section, admin dashboard): the
 * event the visitor was last in, else the build-time slug, else the
 * first open event, else the first listed event.
 */
export function preferredEventSlug(
  current: string | null,
  envSlug: string | null,
  summaries: readonly EventSummary[] | null,
): string | null {
  if (current) return current
  if (envSlug) return envSlug
  const list = summaries ?? []
  return openSlugs(list)[0] ?? list[0]?.slug ?? null
}

/** Full redirect target for a legacy path once the slug is known. */
export function legacyRedirectPath(slug: string, legacyPath: string): string {
  return `/e/${encodeURIComponent(slug)}${legacyPath}`
}
