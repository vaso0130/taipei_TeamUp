import { createDb } from '../db/client.js'
import { loadLocalEnv } from '../env.js'
import { loadEventSeeds, resolveSeedDir } from '../events/seed-loader.js'
import { upsertSeed } from './upsert.js'

loadLocalEnv()

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      'DATABASE_URL is not set. Start the local database (docker compose up -d), ' +
        'run migrations (pnpm --filter @teamup/api db:migrate), then retry.',
    )
    process.exit(1)
  }

  const seeds = loadEventSeeds()
  console.log(`seeding ${seeds.length} event(s) from ${resolveSeedDir()}`)

  const db = createDb(databaseUrl)
  try {
    for (const seed of seeds) {
      await upsertSeed(db, seed)
      console.log(
        `  ✓ ${seed.event.slug} (${seed.roles.length} roles, ${seed.skills.length} skills)`,
      )
    }
  } finally {
    await db.$client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
