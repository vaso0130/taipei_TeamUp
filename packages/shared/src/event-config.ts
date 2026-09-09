import { z } from 'zod'

/**
 * Event configuration schemas — the heart of the "everything is event
 * config, nothing is hardcoded" rule. Both the API (seed validation,
 * request validation) and the web app (types) consume these.
 */

export const EVENT_STATUSES = ['draft', 'open', 'closed', 'archived'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

/**
 * Schema ceilings shared by event config and request schemas. These are
 * NOT event rules — they are the largest values the wire format can
 * express. Every per-event value (requiredContacts, maxCustomTags, …)
 * is constrained to fit inside them, so an event can never be configured
 * beyond what the request schemas accept.
 */
export const SCHEMA_LIMITS = {
  /** Upper bound for events.requiredContacts and contact ranks. */
  maxContacts: 100,
  /** Upper bound for the size of a role/skill dictionary and for key lists. */
  maxDictionaryOptions: 100,
  /** Upper bound for events.maxCustomTags and the tag list. */
  maxCustomTags: 20,
  /** Upper bound for events.customTagMaxLength and each tag. */
  maxCustomTagLength: 30,
} as const

/** Machine keys: lowercase snake_case, e.g. `frontend`, `civic_knowledge`. */
const optionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'key must be lowercase snake_case')

/** URL slugs: lowercase kebab-case, e.g. `codefest-2026-fall`. */
const eventSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase kebab-case')

/** A dictionary entry for roles or skills, scoped to one event. */
export const DictionaryOptionSchema = z.object({
  key: optionKey,
  label: z.string().min(1).max(50),
  /** Display group label, e.g. 工具鏈. Optional; used for skill grouping. */
  category: z.string().min(1).max(50).optional(),
  sortOrder: z.number().int().nonnegative().default(0),
  isActive: z.boolean().default(true),
})
export type DictionaryOption = z.infer<typeof DictionaryOptionSchema>

export const EventConfigSchema = z
  .object({
    slug: eventSlug,
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(''),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    /** After this moment, no new teams / applications are accepted. */
    recruitClosesAt: z.string().datetime({ offset: true }),
    minMembers: z.number().int().min(1),
    maxMembers: z.number().int().min(1),
    /** true → a user may belong to at most one team in this event. */
    exclusiveMembership: z.boolean(),
    /** How many contact persons a team must designate (0 = none). */
    requiredContacts: z.number().int().min(0).max(SCHEMA_LIMITS.maxContacts),
    /** true → ask participants whether they are 18+ on join. */
    requiresAdultCheck: z.boolean(),
    /** UI terminology overrides, e.g. 讀書會 instead of 隊伍. */
    termTeam: z.string().min(1).max(20).default('隊伍'),
    termMember: z.string().min(1).max(20).default('成員'),
    status: z.enum(EVENT_STATUSES),
    /** Days after endsAt before event data is purged. */
    retentionDays: z.number().int().min(1).default(90),
    /**
     * Free-form participant tags (e.g. niche languages the skill
     * dictionary missed). 0 = not allowed. Tags are moderated together
     * with the blurb before becoming public.
     */
    maxCustomTags: z.number().int().min(0).max(SCHEMA_LIMITS.maxCustomTags).default(0),
    customTagMaxLength: z
      .number()
      .int()
      .min(1)
      .max(SCHEMA_LIMITS.maxCustomTagLength)
      .default(16),
  })
  .refine((e) => e.maxMembers >= e.minMembers, {
    message: 'maxMembers must be >= minMembers',
    path: ['maxMembers'],
  })
  .refine((e) => e.requiredContacts <= e.maxMembers, {
    message: 'requiredContacts cannot exceed maxMembers',
    path: ['requiredContacts'],
  })
  .refine((e) => new Date(e.endsAt) > new Date(e.startsAt), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  })
export type EventConfig = z.infer<typeof EventConfigSchema>

const uniqueKeys = (options: { key: string }[], ctx: z.RefinementCtx, path: string) => {
  const seen = new Set<string>()
  for (const [i, opt] of options.entries()) {
    if (seen.has(opt.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate key "${opt.key}"`,
        path: [path, i, 'key'],
      })
    }
    seen.add(opt.key)
  }
}

/** One seed file = one event with its role and skill dictionaries. */
export const EventSeedSchema = z
  .object({
    event: EventConfigSchema,
    roles: z.array(DictionaryOptionSchema).max(SCHEMA_LIMITS.maxDictionaryOptions),
    skills: z.array(DictionaryOptionSchema).max(SCHEMA_LIMITS.maxDictionaryOptions),
  })
  .superRefine((seed, ctx) => {
    uniqueKeys(seed.roles, ctx, 'roles')
    uniqueKeys(seed.skills, ctx, 'skills')
  })
export type EventSeed = z.infer<typeof EventSeedSchema>

/** Public API shape for GET /api/events/:slug — config plus dictionaries. */
export interface EventDetail {
  event: EventConfig
  roles: DictionaryOption[]
  skills: DictionaryOption[]
}

/** Public API shape for GET /api/events list entries. */
export type EventSummary = Pick<
  EventConfig,
  'slug' | 'name' | 'status' | 'startsAt' | 'endsAt' | 'recruitClosesAt'
>
