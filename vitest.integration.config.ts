import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/integration/**/*.int.test.ts'],
    // One shared database: files must not race each other's writes.
    fileParallelism: false,
  },
})
