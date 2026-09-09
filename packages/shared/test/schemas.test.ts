import { describe, expect, it } from 'vitest'
import {
  ApplySchema,
  ContactsSchema,
  CreateTeamSchema,
  EventConfigSchema,
  InviteSchema,
  ParticipationInputSchema,
  SCHEMA_LIMITS,
  SendMessageSchema,
  UpdateTeamSchema,
  containsControlChars,
  containsForbiddenControlChars,
} from '../src/index.js'

const NUL = String.fromCharCode(0)
const ESC = String.fromCharCode(27)
const DEL = String.fromCharCode(127)

const validEvent = {
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
  status: 'open',
}

describe('control-character helpers', () => {
  it('distinguishes forbidden controls from legitimate whitespace controls', () => {
    expect(containsControlChars('a\nb')).toBe(true)
    expect(containsForbiddenControlChars('a\nb\tc\r')).toBe(false)
    for (const bad of [NUL, ESC, DEL, String.fromCharCode(8)]) {
      expect(containsForbiddenControlChars(`x${bad}y`)).toBe(true)
    }
  })
})

describe('free-text request fields refuse control characters', () => {
  it('multi-line fields keep newlines/tabs but refuse NUL and friends', () => {
    expect(CreateTeamSchema.safeParse({ name: '隊', pitch: '第一行\n第二行\t縮排' }).success).toBe(true)
    expect(CreateTeamSchema.safeParse({ name: '隊', pitch: `壞${NUL}字` }).success).toBe(false)
    expect(UpdateTeamSchema.safeParse({ pitch: `x${ESC}[31m` }).success).toBe(false)
    expect(ApplySchema.safeParse({ message: `hi${NUL}` }).success).toBe(false)
    expect(ApplySchema.safeParse({ message: 'hi\nthere' }).success).toBe(true)
    expect(
      InviteSchema.safeParse({ userId: '01890000-0000-7000-8000-000000000000', message: `a${DEL}` })
        .success,
    ).toBe(false)
    expect(SendMessageSchema.safeParse({ body: `hello${NUL}` }).success).toBe(false)
    expect(SendMessageSchema.safeParse({ body: 'hello\nworld' }).success).toBe(true)
    expect(ParticipationInputSchema.safeParse({ intent: 'browsing', blurb: `自介${NUL}` }).success).toBe(false)
    expect(ParticipationInputSchema.safeParse({ intent: 'browsing', blurb: '自介\n第二行' }).success).toBe(true)
  })

  it('single-line fields (team name, custom tags) refuse every control character', () => {
    expect(CreateTeamSchema.safeParse({ name: '換行\n隊' }).success).toBe(false)
    expect(CreateTeamSchema.safeParse({ name: `tab\t隊` }).success).toBe(false)
    expect(
      ParticipationInputSchema.safeParse({ intent: 'browsing', customTags: ['Rust', `Go${NUL}`] }).success,
    ).toBe(false)
    expect(
      ParticipationInputSchema.safeParse({ intent: 'browsing', customTags: ['Rust\nlang'] }).success,
    ).toBe(false)
    expect(ParticipationInputSchema.safeParse({ intent: 'browsing', customTags: ['Rust'] }).success).toBe(true)
  })
})

describe('event config cannot exceed what request schemas can carry', () => {
  it('requiredContacts is capped at the same ceiling as the contacts request', () => {
    const tooMany = SCHEMA_LIMITS.maxContacts + 1
    const event = EventConfigSchema.safeParse({
      ...validEvent,
      minMembers: tooMany,
      maxMembers: tooMany,
      requiredContacts: tooMany,
    })
    expect(event.success).toBe(false)

    const atCeiling = EventConfigSchema.safeParse({
      ...validEvent,
      minMembers: SCHEMA_LIMITS.maxContacts,
      maxMembers: SCHEMA_LIMITS.maxContacts,
      requiredContacts: SCHEMA_LIMITS.maxContacts,
    })
    expect(atCeiling.success).toBe(true)
    // …and a request can actually express that many contacts.
    const contacts = Array.from({ length: SCHEMA_LIMITS.maxContacts }, (_, i) => ({
      userId: `01890000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      rank: i + 1,
    }))
    expect(ContactsSchema.safeParse({ contacts }).success).toBe(true)
    expect(
      ContactsSchema.safeParse({
        contacts: [{ userId: contacts[0]!.userId, rank: SCHEMA_LIMITS.maxContacts + 1 }],
      }).success,
    ).toBe(false)
  })

  it('custom-tag ceilings are shared between event config and participation input', () => {
    expect(
      EventConfigSchema.safeParse({ ...validEvent, maxCustomTags: SCHEMA_LIMITS.maxCustomTags + 1 })
        .success,
    ).toBe(false)
    expect(
      EventConfigSchema.safeParse({
        ...validEvent,
        customTagMaxLength: SCHEMA_LIMITS.maxCustomTagLength + 1,
      }).success,
    ).toBe(false)
    const tags = Array.from({ length: SCHEMA_LIMITS.maxCustomTags }, (_, i) => `t${i}`)
    expect(ParticipationInputSchema.safeParse({ intent: 'browsing', customTags: tags }).success).toBe(true)
    expect(
      ParticipationInputSchema.safeParse({ intent: 'browsing', customTags: [...tags, 'one-more'] })
        .success,
    ).toBe(false)
    expect(
      ParticipationInputSchema.safeParse({
        intent: 'browsing',
        customTags: ['x'.repeat(SCHEMA_LIMITS.maxCustomTagLength + 1)],
      }).success,
    ).toBe(false)
  })

  it('key lists accept up to the dictionary ceiling', () => {
    const keys = Array.from({ length: SCHEMA_LIMITS.maxDictionaryOptions }, (_, i) => `k${i}`)
    expect(CreateTeamSchema.safeParse({ name: '隊', neededSkills: keys }).success).toBe(true)
    expect(CreateTeamSchema.safeParse({ name: '隊', neededSkills: [...keys, 'extra'] }).success).toBe(false)
    expect(ParticipationInputSchema.safeParse({ intent: 'browsing', skills: keys }).success).toBe(true)
  })
})
