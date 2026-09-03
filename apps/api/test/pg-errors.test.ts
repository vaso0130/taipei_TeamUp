import { describe, expect, it } from 'vitest'
import { isUniqueViolation } from '../src/db/pg-errors.js'

describe('isUniqueViolation', () => {
  it('detects a bare pg error', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true)
  })

  it('detects the pg error inside a Drizzle wrapper cause chain', () => {
    // Field-tested shape: DrizzleQueryError { cause: pg error }. Checking
    // only the top-level code turned every duplicate into a 500.
    const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' })
    const wrapped = new Error('Failed query: insert into "applications" ...', {
      cause: pgError,
    })
    expect(isUniqueViolation(wrapped)).toBe(true)

    const doubleWrapped = new Error('outer', { cause: wrapped })
    expect(isUniqueViolation(doubleWrapped)).toBe(true)
  })

  it('rejects other errors', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
    expect(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
  })
})
