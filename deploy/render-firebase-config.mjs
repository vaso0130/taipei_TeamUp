#!/usr/bin/env node
/**
 * Render firebase.json for deployment.
 *
 * The committed firebase.json keeps the API origin as the placeholder
 * `__API_ORIGIN__` so the public repo never carries deployment-specific
 * hosts. This script substitutes the origin from VITE_API_BASE_URL (or
 * API_ORIGIN) and writes firebase.deploy.json (gitignored), which is then
 * passed to `firebase deploy --config firebase.deploy.json`.
 *
 * Usage:
 *   VITE_API_BASE_URL=https://api.example.run.app node deploy/render-firebase-config.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Local convenience: pick up .env.local without overriding real env vars.
const envLocal = path.join(root, '.env.local')
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
}

const raw = process.env.API_ORIGIN ?? process.env.VITE_API_BASE_URL
if (!raw) {
  console.error('render-firebase-config: set VITE_API_BASE_URL (or API_ORIGIN) to the API origin')
  process.exit(1)
}
let origin
try {
  origin = new URL(raw).origin
} catch {
  console.error(`render-firebase-config: "${raw}" is not a valid URL`)
  process.exit(1)
}
if (!origin.startsWith('https://')) {
  console.error('render-firebase-config: API origin must be https')
  process.exit(1)
}

const template = readFileSync(path.join(root, 'firebase.json'), 'utf8')
if (!template.includes('__API_ORIGIN__')) {
  console.error('render-firebase-config: firebase.json has no __API_ORIGIN__ placeholder')
  process.exit(1)
}
const out = path.join(root, 'firebase.deploy.json')
writeFileSync(out, template.replaceAll('__API_ORIGIN__', origin))
console.log(`wrote ${path.relative(root, out)} (connect-src ${origin})`)
