import { existsSync } from 'node:fs'
import path from 'node:path'
import { config } from 'dotenv'

/**
 * Load .env.local for local development (repo root or package dir).
 * Real environments (Cloud Run) inject env vars directly — existing
 * values are never overridden. Never loaded by tests.
 */
export function loadLocalEnv(): void {
  for (const candidate of [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '../../.env.local'),
  ]) {
    if (existsSync(candidate)) {
      config({ path: candidate, override: false })
      return
    }
  }
}
