import { and, eq, notInArray } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { DictionaryOption, EventSeed } from '@teamup/shared'
import type { Db } from '../db/client.js'
import { eventRoleOptions, eventSkillOptions, events } from '../db/schema.js'

type DictionaryTable = typeof eventRoleOptions | typeof eventSkillOptions

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

async function upsertDictionary(
  tx: Tx,
  table: DictionaryTable,
  eventId: string,
  options: DictionaryOption[],
) {
  const keys = options.map((o) => o.key)
  // Keys removed from the seed are deactivated, not deleted — existing
  // participant/team rows may still reference them.
  await tx
    .update(table)
    .set({ isActive: false })
    .where(
      keys.length > 0
        ? and(eq(table.eventId, eventId), notInArray(table.key, keys))
        : eq(table.eventId, eventId),
    )
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

/** Idempotent per-event upsert used by the seed CLI and integration tests. */
export async function upsertSeed(db: Db, seed: EventSeed): Promise<void> {
  await db.transaction(async (tx) => {
    const e = seed.event
    const values = {
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
    const inserted = await tx
      .insert(events)
      .values({ id: uuidv7(), ...values })
      .onConflictDoUpdate({ target: events.slug, set: values })
      .returning({ id: events.id })
    const eventId = inserted[0]?.id
    if (!eventId) throw new Error(`upsert failed for event ${e.slug}`)

    await upsertDictionary(tx, eventRoleOptions, eventId, seed.roles)
    await upsertDictionary(tx, eventSkillOptions, eventId, seed.skills)
  })
}
