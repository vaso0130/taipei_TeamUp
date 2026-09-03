/**
 * One-off latency probe for name screening (team names / nicknames):
 * how long does the moderator take on short name inputs? Drives the
 * NAME_MODERATION_TIMEOUT_MS default.
 *
 *   pnpm --filter @teamup/api exec tsx scripts/measure-name-latency.ts
 */
import { GoogleAuth } from 'google-auth-library'
import { loadLocalEnv } from '../src/env.js'
import { GeminiModerator } from '../src/moderation/gemini.js'

loadLocalEnv()

const NAMES = [
  '路過的鍵盤俠',
  '台北秘密結社',
  '加LINE領補助金',
  'Rust 新手村',
  '代辦貸款找我',
  '幹話製造機',
  '資工大四求撿',
  '點我拿投資名額 bit.ly/x8',
  '柴犬本柴',
  '午夜除錯俱樂部',
]

async function main() {
  const projectId = process.env.GCP_PROJECT_ID
  const model = process.env.MODERATION_MODEL
  if (!projectId || !model) throw new Error('GCP_PROJECT_ID and MODERATION_MODEL required')
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  const moderator = new GeminiModerator({
    projectId,
    location: process.env.MODERATION_LOCATION ?? 'global',
    model,
    timeoutMs: 30000,
    tokenProvider: async () => {
      if (process.env.EVAL_ACCESS_TOKEN) return process.env.EVAL_ACCESS_TOKEN
      const token = await auth.getAccessToken()
      if (!token) throw new Error('no ADC token')
      return token
    },
  })

  const latencies: number[] = []
  for (const name of NAMES) {
    const start = Date.now()
    try {
      const verdict = await moderator.review(name, { contentType: 'name' })
      const ms = Date.now() - start
      latencies.push(ms)
      console.log(`${ms}ms  ${verdict.riskLevel.padEnd(6)} ${verdict.rationale ?? ''}  <- ${name}`)
    } catch (err) {
      console.log(`ERROR after ${Date.now() - start}ms  <- ${name}: ${(err as Error).message}`)
    }
  }
  latencies.sort((a, b) => a - b)
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
  console.log(
    `\nn=${latencies.length} avg=${avg}ms p50=${latencies[Math.floor(latencies.length / 2)]}ms max=${latencies[latencies.length - 1]}ms`,
  )
}

void main()
