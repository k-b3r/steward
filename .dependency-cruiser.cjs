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
  ],
  options: baseOptions(),
}
