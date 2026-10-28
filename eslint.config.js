import { baseConfig } from '@k-b3r/agent-config/eslint'

export default [
  ...baseConfig({
    tsconfigRootDir: import.meta.dirname,
    // Composition roots: the only files that read process.env.
    entryPoints: ['src/api/index.ts', 'src/worker/index.ts'],
    // The injectable delay; the only place allowed to sleep.
    delayModules: ['src/platform/delay.ts', 'dashboard/src/delay.ts'],
    // Pure decision code (no clock, randomness, fetch, process). Uncomment once the
    // architecture fit check has modules; pure code defaults to a module's domain/ (list files instead if the repo lays it out differently, and record that in CODING_STANDARDS.md).
    pureCorePaths: [
      'src/transitions.ts',
      'src/allocate.ts',
      'src/linear-map.ts',
      'src/retry-policy.ts',
      'src/intake-policy.ts',
    ],
  }),
  // Repo-specific blocks (framework plugins, extra bans) go here.
]
