/**
 * Moderation acceptance eval (spec §9 M5):
 *   high-risk detection rate >= 90%, false-block rate on normal content <= 10%.
 *
 * Runs against the real Vertex AI endpoint — requires:
 *   GCP_PROJECT_ID, MODERATION_MODEL (and gcloud ADC credentials).
 *
 *   pnpm --filter @teamup/api eval:moderation
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { GoogleAuth } from 'google-auth-library'
import { loadLocalEnv } from '../src/env.js'
import { GeminiModerator } from '../src/moderation/gemini.js'
import type { ModerationContext } from '../src/moderation/moderator.js'

loadLocalEnv()

interface EvalCase {
  id: string
  text: string
  expected: 'high' | 'low'
  context: ModerationContext
}

async function main() {
  const projectId = process.env.GCP_PROJECT_ID
  const model = process.env.MODERATION_MODEL
  if (!projectId || !model) {
    console.error('GCP_PROJECT_ID and MODERATION_MODEL are required (plus gcloud ADC login).')
    process.exit(1)
  }

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const moderator = new GeminiModerator({
    projectId,
    location: process.env.MODERATION_LOCATION ?? 'global',
    model,
    timeoutMs: 30000,
    tokenProvider: async () => {
      // EVAL_ACCESS_TOKEN lets environments without ADC run the eval
      // (e.g. token from `gcloud auth print-access-token`).
      if (process.env.EVAL_ACCESS_TOKEN) return process.env.EVAL_ACCESS_TOKEN
      const token = await auth.getAccessToken()
      if (!token) throw new Error('no access token — run: gcloud auth application-default login')
      return token
    },
  })

  const corpus = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'eval/moderation-corpus.json'), 'utf8'),
  ) as { cases: EvalCase[] }

  let scamCaught = 0
  let scamTotal = 0
  let okBlocked = 0
  let okTotal = 0

  for (const c of corpus.cases) {
    let got = 'error'
    // Mirror the production pipeline's retry behavior — a transient
    // timeout is not a verdict.
    for (let attempt = 0; attempt < 3 && got === 'error'; attempt++) {
      try {
        const verdict = await moderator.review(c.text, c.context)
        got = verdict.riskLevel
      } catch (err) {
        console.error(`  ${c.id}: attempt ${attempt + 1} ERROR ${(err as Error).message}`)
      }
    }
    const isScam = c.expected === 'high'
    if (isScam) {
      scamTotal++
      // Blocking either outright (high) or holding for review (medium)
      // both stop the scam from publishing; "caught" = not published.
      if (got === 'high' || got === 'medium') scamCaught++
    } else {
      okTotal++
      if (got === 'high') okBlocked++
    }
    const marker =
      got === 'error'
        ? '✗錯誤'
        : isScam
          ? got === 'low'
            ? '✗漏放'
            : '✓'
          : got === 'high'
            ? '✗誤擋'
            : '✓'
    console.log(`  ${c.id}  expected=${c.expected}  got=${got}  ${marker}`)
  }

  const catchRate = (scamCaught / scamTotal) * 100
  const falseBlockRate = (okBlocked / okTotal) * 100
  console.log('')
  console.log(`高風險攔截率: ${catchRate.toFixed(1)}%（門檻 ≥ 90%）`)
  console.log(`正常內容誤擋率: ${falseBlockRate.toFixed(1)}%（門檻 ≤ 10%）`)

  const pass = catchRate >= 90 && falseBlockRate <= 10
  console.log(pass ? '\n✅ 驗收通過' : '\n❌ 驗收未通過')
  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
