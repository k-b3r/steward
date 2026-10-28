const { baseRules, baseOptions } = require('@k-b3r/agent-config/dependency-cruiser')

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...baseRules({
      // Each feature module's index.ts is its only entry from outside.
      publicApis: [],
      // Heavy or side-effecting packages and the one file allowed to import each.
      heavyDeps: [
        { packages: ['pg'], owner: 'src/platform/db.ts' },
        { packages: ['bullmq', 'ioredis'], owner: 'src/worker/queue.ts' },
      ],
      inner: ['src/platform'],
      // src/processes (flows spanning modules, created when a second caller needs one) goes here too:
      // it may import modules, modules never import it.
      entryPoints: ['src/api', 'src/worker'],
      // Modules lowest tier first. A module imports only lower tiers; every module must be listed.
      // moduleTiers: { dir: 'src/modules', tiers: [['collection'], ['catalog'], ['pricing']] },
    }),
    // Repo-specific rules go here.
    {
      name: 'dashboard-only-contract',
      severity: 'error',
      comment:
        'The browser dashboard reads the API only through src/api/contract.ts (zod schemas and types). It never imports server code.',
      from: { path: '^dashboard/src' },
      to: { path: '^src/', pathNot: '^src/api/contract\\.ts$' },
    },
    {
      name: 'dashboard-no-server-packages',
      severity: 'error',
      comment: 'Node-side packages must not end up in the browser bundle.',
      from: { path: '^dashboard/src' },
      to: { path: 'node_modules/(pg|drizzle-orm|drizzle-kit|bullmq|ioredis|hono|@hono)/' },
    },
    {
      name: 'server-not-to-dashboard',
      severity: 'error',
      comment: 'The orchestrator never depends on the dashboard.',
      from: { path: '^src/' },
      to: { path: '^dashboard/' },
    },
  ],
  options: baseOptions(),
}
