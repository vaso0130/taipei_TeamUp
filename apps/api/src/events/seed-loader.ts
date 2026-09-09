import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { EventSeedSchema, type EventSeed } from '@teamup/shared'

export const DEFAULT_SEED_DIR = 'seeds/events'

export function resolveSeedDir(seedDir?: string): string {
  return path.resolve(process.cwd(), seedDir ?? process.env.EVENT_SEED_DIR ?? DEFAULT_SEED_DIR)
}

export interface EventSeedFile {
  /** File name without the `.json` extension (template key). */
  key: string
  seed: EventSeed
}

/**
 * Load and validate every event seed file in a directory, keeping the
 * file name (the admin template key). Throws with the file name and zod
 * issues when a seed is invalid — a broken seed must fail loudly, never
 * half-load.
 */
export function loadEventSeedFiles(seedDir?: string): EventSeedFile[] {
  const dir = resolveSeedDir(seedDir)
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
  if (files.length === 0) {
    throw new Error(`no event seed files found in ${dir}`)
  }

  const seeds: EventSeedFile[] = []
  const slugs = new Set<string>()
  for (const file of files) {
    const raw = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
    const result = EventSeedSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(`invalid event seed ${file}: ${result.error.message}`)
    }
    const { slug } = result.data.event
    if (slugs.has(slug)) {
      throw new Error(`duplicate event slug "${slug}" (${file})`)
    }
    slugs.add(slug)
    seeds.push({ key: file.slice(0, -'.json'.length), seed: result.data })
  }
  return seeds
}

/** Load and validate every event seed file in a directory. */
export function loadEventSeeds(seedDir?: string): EventSeed[] {
  return loadEventSeedFiles(seedDir).map((f) => f.seed)
}
