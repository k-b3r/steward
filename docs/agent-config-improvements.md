# Improvements for agent-config

A running list of changes to `k-b3r/agent-config` that came out of real work in this repo. Add an entry when the standard, a template, a skill or a tool caused friction, or when it missed a bug.

Each entry has: what happened, the proposed change, where in agent-config it goes, and a status. Statuses: `open`, `filed` (with PR link), `done`, `dropped` (with reason).

Rule of thumb from the README: add a rule once the same correction was needed twice. Mark an entry `seen: 1` or `seen: 2+` so the list shows which ones qualify.

## Template and init-repo

### 2026-10-27: a fresh repo fails `pnpm check` on the first run (seen: 1, open)

- **What happened.** Right after `/init-repo`, `pnpm test` exits 1 with "No test files found". The step 8 promise ("`pnpm check` must pass") is false until the first test exists. `knip` also failed on the template's own `tsx` devDependency, which nothing used yet.
- **Proposed.** Add `passWithNoTests: true` to `vitest.config.ts`, or ship one trivial test. Drop `tsx` from the template, or add a script that uses it.
- **Where.** `skills/init-repo/templates/typescript/` plus a `CHANGELOG.md` entry.

### 2026-10-27: knip hints on a fresh repo (seen: 1, open)

- **What happened.** `knip.json` entry `tests/**/*.ts` and the `src/workers/*/index.ts` pattern produce "no matches" and "redundant entry" hints. They are noise on day one.
- **Proposed.** Ship the entries the template can really match, or document that the hints are expected until the repo has files.
- **Where.** `templates/typescript/knip.json`, `skills/init-repo/SKILL.md` step 5.

### 2026-10-27: no example for the flat shape (seen: 1, open)

- **What happened.** The template's ESLint and dependency-cruiser examples all assume the module shape (`src/modules/*/domain/**`, `moduleTiers`). A repo that the fit check calls flat had to invent its `pureCorePaths` as a file list and record it in `CODING_STANDARDS.md` by hand.
- **Proposed.** Add a commented flat example next to the module one, and a line in step 5 that says what to fill in for the flat answer.
- **Where.** `templates/typescript/eslint.config.js`, `.dependency-cruiser.cjs`, `skills/init-repo/SKILL.md` step 5.

### 2026-10-27: generated files are not asked about (seen: 1, open)

- **What happened.** The repo uses Drizzle migrations. `agentConfig.generatedPaths` was not set, so a generated migration counts toward the 800-line PR limit. Nothing in `/init-repo` asks about generators.
- **Proposed.** Step 5 asks "does this repo generate files (ORM migrations, API clients, lockfiles)?" and fills `generatedPaths` and `regenerate-paths`.
- **Where.** `skills/init-repo/SKILL.md` step 5.

### 2026-10-27: an existing .gitignore is only merged by hand (seen: 1, open)

- **What happened.** A GitHub-created repo already had a long `.gitignore`. The template's lines were merged manually.
- **Proposed.** A small script in the skill that appends only the missing template lines, as step 4 already describes in words.
- **Where.** `skills/init-repo/` (script), step 4.

## Standards and tooling

### 2026-10-27: integration tests that drop schemas can run on the wrong database (seen: 1, open)

- **What happened.** The standard says integration tests read only `TEST_DATABASE_URL`, and `repo-checks test-db-env` checks the variable name. A test that resets the database by dropping schemas has no check that the URL points at a test database. The guard hook only knows "test database" by its own rules.
- **Proposed.** A shared helper, or a `repo-checks` rule, that refuses a `TEST_DATABASE_URL` whose database name lacks `test`. Steward has a local version of this guard in each integration test file; the shared one would replace them.
- **Where.** `scripts/repo-checks.mjs` or a small exported helper in `configs/`.

### 2026-10-27: example ticket keys leak into generated tests (seen: 1, open)

- **What happened.** A sub-agent wrote fixtures with a `BUY-` prefix, which is the example key used in the skills. This repo must hold no real team keys. A reviewer fixed it by hand.
- **Proposed.** Say in `ship-ticket` and the testing section that fixtures use a neutral prefix (`TST-`) and `example.com` hosts. Optionally add a `repo-checks` rule that flags known real keys from a local, untracked list.
- **Where.** `CODING_STANDARDS.md` Testing, `skills/ship-ticket/SKILL.md`.

## Delegated work (sub-agents)

### 2026-10-27: "all green" reports from sub-agents hid real bugs (seen: 1, open)

- **What happened.** Cheap sub-agents wrote the code and reported passing tests, lint and typecheck. Review against the spec still found real defects, each fixed test-first:
  - A transcript writer corrupted the next entry after a crash cut the last line, and created a world-readable file.
  - A queue used the job id as the delivery id. BullMQ ignores an add when the id exists, even for a finished or running job, so every retry (enqueued from inside the running handler) was silently dropped.
  - A retry always failed because the failed attempt left its git branch behind.
  - A cancel was undone, because the worker's failure handler took the legal `cancelled → queued` retry edge.
  - An integration test's database reset could run on a database not named "test".
- **Pattern.** Every one was a state-over-time bug: retries, restarts, crashes, concurrency, cleanup. Unit tests that run each path once do not find them.
- **Proposed.**
  1. A short "delegated work" section in the standards: the orchestrator reads the code for retry, restart, cancel and cleanup paths, and re-runs the checks itself. It does not trust the report.
  2. Review rule: for any queue, retry or cancel logic, ask "what happens if this runs a second time, or while the first run is still active?"
  3. Add review-seeds for the cases above (a re-enqueue with an existing id, a failure handler that can undo a cancel).
- **Where.** `CODING_STANDARDS.md` (Resilience, new Delegated work), `review-seeds/seeds/`.

### 2026-10-27: a sub-agent's pane stays open after it finishes (seen: 1, open)

- **What happened.** Interactive sub-agents that never call their exit tool leave idle panes, and the "looks finished" message arrives before the real report. Four panes stayed open until closed by hand.
- **Proposed.** Put "when finished, call `subagent_done`" in the standard spawn prompt. A mid-work progress message can arrive in place of a final report, so the orchestrator should verify from the files, not from the message.
- **Where.** The global pi instructions (`~/.pi/agent/AGENTS.md`) and `skills/dispatch-tickets/SKILL.md`. Not strictly agent-config; note it there if it fits.

### 2026-10-27: parallel agents on one checkout need file ownership (seen: 1, open)

- **What happened.** Six agents in one checkout worked without conflicts because each prompt named the files it owned and forbade `git`, `pnpm add` and edits to shared files. One agent was the only one allowed to touch `package.json`. Dependencies added up front by the orchestrator avoided clashes later.
- **Proposed.** Write this as a recipe in `dispatch-tickets` or a new short skill: ownership list, shared-file owner, no git for workers, dependencies first, orchestrator commits one piece at a time.
- **Where.** `skills/dispatch-tickets/SKILL.md`.

## Open questions for later

- Does `ci-typescript.yml` run integration tests with a database service? Not checked in this repo yet. Check before relying on `integration.yml`.
- Can `pr-review.yml` use a second model as a fallback at the session limit? Not possible with `claude-code-action` today (checked: it takes `model` and an OAuth token only). Revisit if the limit hurts.
