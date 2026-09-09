import type { EventDetail, EventSummary } from '@teamup/shared'

/**
 * Read access to event configuration. Two implementations:
 * - DbEventRepository: PostgreSQL via Drizzle (production)
 * - SeedEventRepository: read-only, backed by seed JSON files (local
 *   dev without a database, and tests) — see ADR-004.
 *
 * Draft events are never exposed through this interface; archived events
 * are readable by slug but absent from the list. Admin read/write access
 * lives in EventAdminRepository (admin-repository.ts).
 */
export interface EventRepository {
  listEvents(): Promise<EventSummary[]>
  getEventBySlug(slug: string): Promise<EventDetail | null>
}
