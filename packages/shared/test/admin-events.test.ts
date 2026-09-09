import { describe, expect, it } from 'vitest'
import {
  ADMIN_EVENT_ERRORS,
  AdminEventStatusInputSchema,
  CreateEventInputSchema,
  DuplicateEventInputSchema,
  EVENT_SLUG_PATTERN,
  EVENT_STATUS_TRANSITIONS,
  EVENT_STATUSES,
  EventSlugSchema,
  LISTED_EVENT_STATUSES,
  OPTION_KEY_PATTERN,
} from '../src/index.js'

/** Generic fixture — no real-event rule values (spec rule). */
const draftSeed = {
  event: {
    slug: 'sample-event',
    name: '範例活動',
    startsAt: '2026-01-10T09:00:00+08:00',
    endsAt: '2026-01-11T18:00:00+08:00',
    recruitClosesAt: '2026-01-05T23:59:59+08:00',
    minMembers: 2,
    maxMembers: 8,
    exclusiveMembership: false,
    requiredContacts: 0,
    requiresAdultCheck: false,
    status: 'draft',
  },
  roles: [{ key: 'alpha', label: '角色 A' }],
  skills: [{ key: 'beta', label: '技能 B' }],
}

describe('CreateEventInputSchema', () => {
  it('accepts a draft seed', () => {
    expect(CreateEventInputSchema.safeParse(draftSeed).success).toBe(true)
  })

  it('rejects any other status, pointing at event.status', () => {
    const result = CreateEventInputSchema.safeParse({
      ...draftSeed,
      event: { ...draftSeed.event, status: 'open' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'event.status')).toBe(true)
    }
  })
})

describe('status inputs', () => {
  it('accepts every known status and nothing else', () => {
    for (const status of EVENT_STATUSES) {
      expect(AdminEventStatusInputSchema.safeParse({ status }).success).toBe(true)
    }
    expect(AdminEventStatusInputSchema.safeParse({ status: 'deleted' }).success).toBe(false)
  })

  it('declares the documented transition graph', () => {
    expect(EVENT_STATUS_TRANSITIONS).toEqual({
      draft: ['open'],
      open: ['closed'],
      closed: ['open', 'archived'],
      archived: [],
    })
    expect(LISTED_EVENT_STATUSES).toEqual(['open', 'closed'])
  })
})

describe('DuplicateEventInputSchema', () => {
  it('requires a kebab-case slug and a non-blank name', () => {
    expect(DuplicateEventInputSchema.safeParse({ slug: 'copy-1', name: ' 複本 ' }).success).toBe(true)
    expect(DuplicateEventInputSchema.safeParse({ slug: 'Copy', name: '複本' }).success).toBe(false)
    expect(DuplicateEventInputSchema.safeParse({ slug: 'copy-1', name: '   ' }).success).toBe(false)
  })
})

describe('shared identifiers', () => {
  it('exposes the slug/key rules the editor generates against', () => {
    expect(EVENT_SLUG_PATTERN.test('event-202609-ab12')).toBe(true)
    expect(EVENT_SLUG_PATTERN.test('-leading')).toBe(false)
    expect(OPTION_KEY_PATTERN.test('spring_framework')).toBe(true)
    expect(OPTION_KEY_PATTERN.test('1st')).toBe(false)
    expect(EventSlugSchema.safeParse('a'.repeat(101)).success).toBe(false)
  })

  it('lists every error code once', () => {
    const codes = Object.values(ADMIN_EVENT_ERRORS)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes).toContain('dictionary_key_in_use')
  })
})
