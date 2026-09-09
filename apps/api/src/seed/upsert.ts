import { and, eq, notInArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { DictionaryOption, EventConfig, EventSeed } from '@teamup/shared'
import type { Db } from '../db/client.js'
import { eventRoleOptions, eventSkillOptions, events } from '../db/schema.js'

type DictionaryTable = typeof eventRoleOptions | typeof eventSkillOptions

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * What happens to dictionary rows whose key is absent from the seed:
 * - `deactivate`: the seed CLI's idempotent default — participant/team
 *   rows may still reference the key, so it is switched off, not removed.
 * - `delete`: the admin editor's explicit removal; the service has already
 *   verified nobody references the key (ADR-035).
 */
export type MissingKeyPolicy = 'deactivate' | 'delete'

/** Column values for an events row, minus id/createdAt. */
export function eventRowValues(e: EventConfig) {
  return {
    slug: e.slug,
    name: e.name,
    description: e.description,
    startsAt: new Date(e.startsAt),
    endsAt: new Date(e.endsAt),
    recruitClosesAt: new Date(e.recruitClosesAt),
    minMembers: e.minMembers,
    maxMembers: e.maxMembers,
    exclusiveMembership: e.exclusiveMembership,
    requiredContacts: e.requiredContacts,
    requiresAdultCheck: e.requiresAdultCheck,
    termTeam: e.termTeam,
    termMember: e.termMember,
    status: e.status,
    retentionDays: e.retentionDays,
    maxCustomTags: e.maxCustomTags,
    customTagMaxLength: e.customTagMaxLength,
    updatedAt: new Date(),
  }
}

/** Reconcile one dictionary table with the seed's option list. */
export async function writeDictionary(
  tx: Tx,
  table: DictionaryTable,
  eventId: string,
  options: DictionaryOption[],
  missing: MissingKeyPolicy,
) {
  const keys = options.map((o) => o.key)
  const absent =
    keys.length > 0
      ? and(eq(table.eventId, eventId), notInArray(table.key, keys))
      : eq(table.eventId, eventId)
  if (missing === 'delete') {
    await tx.delete(table).where(absent)
  } else {
    await tx.update(table).set({ isActive: false }).where(absent)
  }
  for (const opt of options) {
    const values = {
      eventId,
      key: opt.key,
      label: opt.label,
      category: opt.category ?? null,
      sortOrder: opt.sortOrder,
      isActive: opt.isActive,
    }
    await tx
      .insert(table)
      .values({ id: uuidv7(), ...values })
      .onConflictDoUpdate({ target: [table.eventId, table.key], set: values })
  }
}

/** Both dictionaries of one event. */
export async function writeDictionaries(
  tx: Tx,
  eventId: string,
  seed: EventSeed,
  missing: MissingKeyPolicy,
) {
  await writeDictionary(tx, eventRoleOptions, eventId, seed.roles, missing)
  await writeDictionary(tx, eventSkillOptions, eventId, seed.skills, missing)
}

/**
 * Idempotent per-event upsert used by the seed CLI, integration tests and
 * the admin editor's update path (with `missingKeys: 'delete'`). One code
 * path for both entry points — the form can never write something the
 * seed CLI would not, and vice versa.
 */
export async function upsertSeed(
  db: Db,
  seed: EventSeed,
  opts: { missingKeys?: MissingKeyPolicy } = {},
): Promise<void> {
  const missing = opts.missingKeys ?? 'deactivate'
  await db.transaction(async (tx) => {
    const values = eventRowValues(seed.event)
    const inserted = await tx
      .insert(events)
      .values({ id: uuidv7(), ...values })
      .onConflictDoUpdate({ target: events.slug, set: values })
      .returning({ id: events.id })
    const eventId = inserted[0]?.id
    if (!eventId) throw new Error(`upsert failed for event ${seed.event.slug}`)
    await writeDictionaries(tx, eventId, seed, missing)
  })
}
