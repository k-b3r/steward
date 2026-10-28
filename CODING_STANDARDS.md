# Coding Standards

Project layer on top of the global [k-b3r/agent-config standards](https://github.com/k-b3r/agent-config/blob/main/CODING_STANDARDS.md): same sections and tags, only what's specific to this repo. Generic rules live there, not here. This file wins on conflict. When in doubt, match surrounding code.

## Workflow

- `tool` Canonical check: `pnpm check` (format, lint, depcruise, knip, typecheck, unit tests), run by the lefthook pre-push hook.
- `tool` CI: `k-b3r/agent-config` `ci-typescript.yml` (static checks incl. `repo-checks` and gitleaks, unit, integration, e2e) + `pr-review.yml` (agent review and gate). `pnpm exec repo-checks audit` fails if any of it is unwired.

- `review` agent-config is the baseline for this repo and for the author's other projects. When it causes friction (a template that fails on day one, a rule that does not fit, a missing check) or misses a bug, add an entry to `docs/agent-config-improvements.md` in the same PR. Do not edit the agent-config checkout from here.
- `review` Delegated work (sub-agents): give each worker a list of files it owns, forbid `git` and dependency changes, and add shared dependencies first. The orchestrator re-runs the checks itself and reads the retry, restart, cancel and cleanup code. A worker's report of green checks is not proof.

## Architecture

Flat shape (see `CONTEXT.md`). Pure decision code is these files in `src/`; everything else is shell:

- `src/transitions.ts` job state machine, `src/allocate.ts` slot allocation, `src/linear-map.ts` Linear JSON to `WorkItem`, `src/retry-policy.ts` backoff and failure kinds. These are the `pureCorePaths`: no clock, randomness, fetch or `process`; time and ids come in as arguments.
- `src/platform/` config (zod), redacting logger, clock, delay, http, git helpers. No domain types.
- `src/db/` Drizzle schema and migrations. `src/linear.ts` the `WorkFeed` implementation. `src/runner/` `AgentRunner`, echo stub, transcript writer.
- `src/entries/*.ts` are the process entry points: the only files that read `process.env`. The wiring lives in `src/composition/`, so `src/api/` is HTTP only and `src/worker/` is queue and run adapters.
- Instances: nothing is a global singleton; the `INSTANCE` value prefixes every external name.

- `tool` Module boundaries: `.dependency-cruiser.cjs` (shared `baseRules`) + ESLint.

## Testing

- `review` Modules with no sibling `*.test.ts` are listed in `agentConfig.untestedExempt` and each has a reason: the database and queue modules (`src/db/**`, `src/platform/db.ts`, `src/worker/{queue,reconcile,process-job}.ts`) are covered by integration tests under `tests/integration/`; `src/api/auth.ts` and `contract.ts` are covered through `src/api/app.test.ts`; `bootstrap.ts`, `delay.ts` and `src/composition/*` and `src/entries/*` are wiring with no logic. A new untested module is not added to the list without a reason here.
- `tool` Integration tests read only `TEST_DATABASE_URL` (`repo-checks test-db-env`).
