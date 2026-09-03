import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEventSeeds } from '../src/events/seed-loader.js'

const fixtures = (name: string) => path.join('test', 'fixtures', name)

describe('loadEventSeeds', () => {
  it('loads and validates the real seed files shipped in the repo', () => {
    const seeds = loadEventSeeds()
    expect(seeds.length).toBeGreaterThan(0)
    for (const seed of seeds) {
      // Cross-field invariants are enforced by the schema; reaching here
      // means every shipped seed is internally consistent.
      expect(seed.event.maxMembers).toBeGreaterThanOrEqual(seed.event.minMembers)
      expect(seed.event.requiredContacts).toBeLessThanOrEqual(seed.event.maxMembers)
    }
  })

  it('throws on an invalid seed file, naming the file', () => {
    expect(() => loadEventSeeds(fixtures('bad-seeds'))).toThrowError(/invalid event seed/)
  })

  it('throws when the directory contains no seed files', () => {
    expect(() => loadEventSeeds(fixtures('empty-seeds'))).toThrowError(/no event seed files/)
  })
})
