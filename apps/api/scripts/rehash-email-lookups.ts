/**
 * One-off, idempotent re-hash of users.email_lookup.
 *
 * Run after any change to the canonical email form (e.g. the M-5
 * alias-collapsing normalization) or a pepper rotation: for every user
 * row, decrypt the stored email, recompute HMAC(normalize(email),
 * EMAIL_HMAC_PEPPER) and update the row when it differs. Rows already
 * carrying the current value are untouched, so re-running is safe.
 *
 * Two rows collapsing onto one canonical address (e.g. `a.b@gmail.com`
 * and `ab@gmail.com` both registered before the change) are NOT merged:
 * the first row keeps the address, the conflict is printed for a human
 * to resolve (usually: the later, emptier account is deleted by its
 * owner or an admin).
 *
 *   pnpm --filter @teamup/api rehash:email-lookups            # apply
 *   pnpm --filter @teamup/api rehash:email-lookups -- --dry   # report only
 *
 * Requires DATABASE_URL, EMAIL_HMAC_PEPPER and the KEK settings
 * (KEK_PROVIDER + LOCAL_KEK_BASE64 | KMS_KEY_NAME) of the environment
 * whose rows are being re-hashed.
 */
import { eq } from 'drizzle-orm'
import { emailLookupHmac, lookupEquals } from '../src/crypto/email.js'
import { FieldCipher } from '../src/crypto/envelope.js'
import { buildKekFromEnv, requireEnv } from '../src/crypto/kek-from-env.js'
import { createDb } from '../src/db/client.js'
import { isUniqueViolation } from '../src/db/pg-errors.js'
import { users } from '../src/db/schema.js'
import { loadLocalEnv } from '../src/env.js'

loadLocalEnv()

async function main() {
  const dryRun = process.argv.includes('--dry')
  const databaseUrl = requireEnv('DATABASE_URL')
  const pepper = requireEnv('EMAIL_HMAC_PEPPER')
  const cipher = new FieldCipher(buildKekFromEnv())
  const db = createDb(databaseUrl, { poolMax: 2 })

  let scanned = 0
  let updated = 0
  let unchanged = 0
  let conflicts = 0
  let failures = 0
  try {
    const rows = await db
      .select({ id: users.id, emailCiphertext: users.emailCiphertext, emailLookup: users.emailLookup })
      .from(users)
    for (const row of rows) {
      scanned++
      let email: string
      try {
        email = await cipher.decrypt(row.emailCiphertext)
      } catch (err) {
        failures++
        console.error(`user ${row.id}: cannot decrypt email (${err instanceof Error ? err.name : 'error'})`)
        continue
      }
      const wanted = emailLookupHmac(email, pepper)
      if (lookupEquals(wanted, row.emailLookup)) {
        unchanged++
        continue
      }
      if (dryRun) {
        updated++
        console.log(`user ${row.id}: lookup would change`)
        continue
      }
      try {
        await db
          .update(users)
          .set({ emailLookup: wanted, updatedAt: new Date() })
          .where(eq(users.id, row.id))
        updated++
      } catch (err) {
        if (isUniqueViolation(err)) {
          conflicts++
          // Only ids are printed — never the address itself.
          console.error(
            `user ${row.id}: another row already owns the canonical lookup — left unchanged, resolve manually`,
          )
          continue
        }
        throw err
      }
    }
  } finally {
    await db.$client.end()
  }
  console.log(
    `${dryRun ? '[dry run] ' : ''}scanned=${scanned} updated=${updated} unchanged=${unchanged} conflicts=${conflicts} failures=${failures}`,
  )
  if (conflicts > 0 || failures > 0) process.exitCode = 2
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err)
  process.exit(1)
})
