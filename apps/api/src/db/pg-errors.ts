const PG_UNIQUE_VIOLATION = '23505'

/**
 * Whether an error (or anything in its `cause` chain) is a PostgreSQL
 * unique-constraint violation. Drizzle wraps driver errors in
 * DrizzleQueryError with the original pg error as `cause`, so checking
 * only the top-level `code` silently misses in production — every
 * duplicate then surfaces as a 500 instead of its domain error.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
