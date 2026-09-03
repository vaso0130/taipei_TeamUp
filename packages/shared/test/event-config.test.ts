import { describe, expect, it } from 'vitest'
import { EventConfigSchema, EventSeedSchema } from '../src/index.js'

/**
 * Generic fixture — deliberately NOT modeled on any real event, so no
 * real-event rule values leak into code (spec rule: event rules live in
 * seed files only).
 */
const validEvent = {
  slug: 'sample-event',
  name: '範例活動',
  description: 'schema 測試用',
  startsAt: '2026-01-10T09:00:00+08:00',
  endsAt: '2026-01-11T18:00:00+08:00',
  recruitClosesAt: '2026-01-05T23:59:59+08:00',
  minMembers: 2,
  maxMembers: 8,
  exclusiveMembership: false,
  requiredContacts: 0,
  requiresAdultCheck: false,
  status: 'open',
}

describe('EventConfigSchema', () => {
  it('accepts a valid config and applies defaults', () => {
    const parsed = EventConfigSchema.parse(validEvent)
    expect(parsed.termTeam).toBe('隊伍')
    expect(parsed.termMember).toBe('成員')
    expect(parsed.retentionDays).toBe(90)
  })

  it('rejects maxMembers < minMembers', () => {
    const result = EventConfigSchema.safeParse({
      ...validEvent,
      minMembers: 6,
      maxMembers: 3,
    })
    expect(result.success).toBe(false)
  })

  it('rejects requiredContacts exceeding maxMembers', () => {
    const result = EventConfigSchema.safeParse({
      ...validEvent,
      requiredContacts: validEvent.maxMembers + 1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects endsAt before startsAt', () => {
    const result = EventConfigSchema.safeParse({
      ...validEvent,
      startsAt: '2026-01-11T18:00:00+08:00',
      endsAt: '2026-01-10T09:00:00+08:00',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-kebab-case slug', () => {
    const result = EventConfigSchema.safeParse({ ...validEvent, slug: 'Bad Slug!' })
    expect(result.success).toBe(false)
  })
})

describe('EventSeedSchema', () => {
  const option = (key: string) => ({ key, label: `標籤 ${key}` })

  it('accepts a valid seed', () => {
    const result = EventSeedSchema.safeParse({
      event: validEvent,
      roles: [option('alpha'), option('beta')],
      skills: [option('gamma')],
    })
    expect(result.success).toBe(true)
  })

  it('rejects duplicate role keys', () => {
    const result = EventSeedSchema.safeParse({
      event: validEvent,
      roles: [option('alpha'), option('alpha')],
      skills: [],
    })
    expect(result.success).toBe(false)
  })

  it('rejects option keys that are not snake_case', () => {
    const result = EventSeedSchema.safeParse({
      event: validEvent,
      roles: [option('Not-Valid')],
      skills: [],
    })
    expect(result.success).toBe(false)
  })
})
