import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Local development only; production migrations run via CI with
    // credentials from Secret Manager.
    url: process.env.DATABASE_URL ?? 'postgres://teamup:localdev@localhost:5432/teamup',
  },
})
