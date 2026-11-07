import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/e2e/**/*.spec.ts'],
    // Shared database and Redis: files must not race each other's writes.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
