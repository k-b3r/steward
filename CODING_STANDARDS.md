# Coding Standards

Project layer on top of the global [k-b3r/agent-config standards](https://github.com/k-b3r/agent-config/blob/main/CODING_STANDARDS.md): same sections and tags, only what's specific to this repo. Generic rules live there, not here. This file wins on conflict. When in doubt, match surrounding code.

## Workflow

- `tool` Canonical check: `pnpm check` (format, lint, depcruise, knip, typecheck, unit tests), run by the lefthook pre-push hook.
- `tool` CI: `k-b3r/agent-config` `ci-typescript.yml` (static checks incl. `repo-checks` and gitleaks, unit, integration, e2e) + `pr-review.yml` (agent review and gate). `pnpm exec repo-checks audit` fails if any of it is unwired.

## Architecture

Flat shape (see `CONTEXT.md`). Pure decision code is these files in `src/`; everything else is shell:

- `src/transitions.ts` job state machine, `src/allocate.ts` slot allocation, `src/linear-map.ts` Linear JSON to `WorkItem`, `src/retry-policy.ts` backoff and failure kinds. These are the `pureCorePaths`: no clock, randomness, fetch or `process`; time and ids come in as arguments.
- `src/platform/` config (zod), redacting logger, clock, delay, http, git helpers. No domain types.
- `src/db/` Drizzle schema and migrations. `src/linear.ts` the `WorkFeed` implementation. `src/runner/` `AgentRunner`, echo stub, transcript writer.
- `src/api/index.ts` and `src/worker/index.ts` are entry points: the only files that read `process.env`.
- Instances: nothing is a global singleton; the `INSTANCE` value prefixes every external name.

- `tool` Module boundaries: `.dependency-cruiser.cjs` (shared `baseRules`) + ESLint.

## Testing

- `tool` Integration tests read only `TEST_DATABASE_URL` (`repo-checks test-db-env`).
