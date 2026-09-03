import { defineConfig } from '@playwright/test'

/**
 * Browser E2E. Smoke tests run against the seed read-only mode (no
 * database needed); the full-journey spec self-skips unless
 * DATABASE_URL is set (CI provides a postgres service container).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
  },
  webServer: [
    {
      command: 'node dist/server.cjs',
      cwd: 'apps/api',
      url: 'http://localhost:8080/healthz',
      reuseExistingServer: !process.env.CI,
      env: { ...(process.env as Record<string, string>), PORT: '8080' },
    },
    {
      command: 'pnpm --filter @teamup/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
    },
  ],
})
