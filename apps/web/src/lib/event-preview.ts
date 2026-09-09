import type { DictionaryOption, EventDetail, EventSeed } from '@teamup/shared'
import { ApiError } from '../api/client.js'

/**
 * Draft preview for administrators (docs/design/landing-and-event-layer.md §3).
 *
 * `GET /api/events/:slug` hides drafts (404). When the visitor is an
 * admin, the store falls back to the admin endpoint and renders the seed
 * as if it were the public detail. These are pure functions so the
 * fallback decision and the conversion are checkable without Pinia.
 */

/** Only a public 404 seen by an admin is worth a second, privileged request. */
export function shouldTryDraftPreview(err: unknown, isAdmin: boolean): boolean {
  return isAdmin && err instanceof ApiError && err.status === 404
}

const bySortOrder = (a: DictionaryOption, b: DictionaryOption) =>
  a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)

/** Mirror of the API's public projection: active options only, sorted. */
export function detailFromSeed(seed: EventSeed): EventDetail {
  const publicOptions = (options: DictionaryOption[]) =>
    options.filter((o) => o.isActive).sort(bySortOrder)
  return {
    event: { ...seed.event },
    roles: publicOptions(seed.roles),
    skills: publicOptions(seed.skills),
  }
}
