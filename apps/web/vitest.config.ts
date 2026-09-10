import { defineConfig } from 'vitest/config'

/** Unit tests for pure TS modules (hero-world, hero-game); no DOM needed. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
