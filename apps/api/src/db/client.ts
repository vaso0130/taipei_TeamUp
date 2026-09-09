import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>

export const DEFAULT_POOL_MAX = 10

export interface DbOptions {
  /** Pool size; production reads DB_POOL_MAX. */
  poolMax?: number
}

export function createDb(databaseUrl: string, options: DbOptions = {}) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
  })
  return drizzle(pool, { schema })
}
