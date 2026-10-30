# Status

A running document. It says what steward can do today, what is left to do, and what nobody has
decided or checked yet. Update it in the same pull request that changes the answer. Do not let
it drift: a stale line here is worse than no line.

Last updated: 2026-10-29, after pull requests #22 to #25 (main `60ba869`).

Other documents hold the reasons. This one holds the state.

- `project-brief.md`: what steward must do, and the phases.
- `architecture.md`: how the parts fit.
- `decisions.md`: every decision, with the evidence behind it.
- `security.md`: what is protected and how.
- `agent-config-improvements.md`: friction found in the shared standards and templates.

## In one paragraph

Steward turns tracker tickets into jobs and runs them in a safe order. Phase 1 is done: the
whole control loop works, from reading Linear to a finished job, with a stand-in "echo" runner
instead of a real coding agent. No real agent has run yet. Nothing is pushed to GitHub and
nothing is written back to Linear. The next big step is phase 2: a Podman container with a real
Claude Code run.

## What works today

Tests: 534 unit tests and 72 integration tests pass. CI, the review gate and a branch ruleset
protect `main`. No Dependabot alerts are open.

### Control logic (pure code, no side effects)

- State machine for a job: `proposed`, `queued`, `claiming`, `running`, `done`, `failed`,
  `cancelled`, `declined`, and the PR states. Every legal move is a table, tested edge by edge.
- Slots: a job holds a slot only while `claiming` or `running`. Default `SLOT_COUNT=3`.
- Retry policy: `infra` failures back off and retry up to `MAX_ATTEMPTS`. `agent` failures are
  not retried automatically. `setup` failures never retry. `failed` is the dead letter.
- Intake policy: Todo and Backlog become proposals. In Progress becomes queued work. The first
  poll is a baseline, and a burst over `MAX_ENQUEUE_PER_POLL` becomes proposals too.

### Data and queue

- Postgres is the source of truth: tables `jobs`, `job_events`, `slots`, `pending_actions`.
  Migrations are generated and checked by `drizzle-kit`.
- BullMQ carries only job ids. Retry and backoff live in code, not in the queue.
- A reconciler runs at start and repairs state after a crash. It assumes one worker process.
- `processJob` claims a slot, makes a git worktree, runs the runner, and cleans up. A worktree
  left behind by a crash is now cleared before a retry (PR #24).

### Tracker and runner

- Linear client (read only) and intake. Verified against a real workspace for `In Progress`
  tickets only.
- Echo runner: it writes a transcript and nothing else. It stands in for a real agent.
- Transcripts: `transcript.jsonl` (redacted) and `raw.jsonl` (never served), per job.
- Git: one clone per instance, one worktree per job, cut from `origin/<BASE_BRANCH>`. An
  existing branch is continued and the base is merged into it. A fetch that cannot succeed
  (no remote, no base branch, `Repository not found`) fails as `setup` at once.

### API and dashboard

- Hono API on `127.0.0.1` with a bearer token, Host and Origin checks, and `ALLOWED_HOSTS` for a
  proxy or tunnel. Routes: list and read jobs, a live log (SSE), retry, cancel, confirm,
  decline, reconsider, and approve or reject an action.
- Commands (`jobs-commands.ts`) and queries (`jobs-queries.ts`) are separate from the HTTP
  layer. `contract.ts` is checked against their types.
- Dashboard (Vite and React) served from the API's own origin when `DASHBOARD_DIR` is set.

### Deploy and tooling

- Quadlet files for Postgres and two Redis servers, rendered per instance by `deploy/render.sh`.
- One folder per instance: `~/steward-instances/<instance>/` with `.env`, `repo/`, `runs/`,
  `quadlet/`, `backups/` (PR #23).
- `pnpm repo:setup` clones the repo an instance works on and pins its git identity.
- `pnpm dev:api` and `pnpm dev:worker` find the instance's env file on their own.
- One instance runs on this box, with real proposals waiting. Dry run is off.

## What does not exist yet

| Area                                            | State                           |
| ----------------------------------------------- | ------------------------------- |
| Real agent run in a container                   | not started (phase 2)           |
| Validator: typecheck, lint, test, diff policy   | not started (phase 3)           |
| Claim, empty commit, draft PR, push             | not started (phase 4)           |
| Linear writes, notifications                    | not started (phase 4)           |
| GitHub poller: reviews, comments, checks, merge | not started (phase 5)           |
| Retention sweep, branch cleanup                 | not started (phase 5)           |
| Second agent (OpenCode), test semaphore         | not started (phase 6)           |
| Operator MCP and per-job agent tools            | planned, not written            |
| Build script and host systemd units             | missing: `dist/` does not exist |

Confirming a proposal today only moves it to `queued` and starts the echo runner. It does not
touch Linear or GitHub.

## To do

### Now (small, concrete)

1. Choose the build: add `.js` to every relative import, or emit with esbuild. Add the script.
   Until then the host units cannot start.
2. Run the git fetch with `LC_ALL=C`. The setup check reads git's English messages.
3. Add a test that `/v1/*` still needs a token when `DASHBOARD_DIR` is set.
4. Make the two test containers Quadlet units. They stop after a reboot and the integration
   tests then fail in a confusing way.
5. Settle the failing `pr-upkeep` and `auto-merge` workflows. They need a GitHub App (an
   `appId`), and fail on every push to `main`. Configure the App or remove the workflows.
6. Housekeeping: close Dependabot's vite 8 pull request, delete merged branches
   (`decisions`, `two-roots`, `fix-leftover-worktree`, `deps-vitest-4`, and the old `stack/*`).
7. First real run on the live instance: stop the old dev API on port 3000, start the worker,
   then the API, and confirm or decline the proposals.
8. Enable user lingering (`loginctl enable-linger`) once the host units work.

### Next

- Layering: `jobs-runs.ts` and `jobs-recovery.ts`, so `processJob` and the reconciler stop
  calling the store directly.
- Small fixes: a reason in the body of a 403 Host or Origin error; readable assistant text and
  tool names in the dashboard (not raw JSON); a debug log when a static file cannot be read;
  a test that `redactConfig` leaves `ALLOWED_HOSTS` alone; the `stryker.config.json` mutate glob
  points at `src/modules`, which does not exist; `instanceNames().unit` does not match the
  real unit names.
- Write `docs/agent-tools.md`: the operator MCP, the per-job tool contract, and the probes.
- Build the operator MCP (stdio, adapters over the commands and queries). Agents must never be
  given the `/v1` API, because they could approve their own actions.

### Phase 2 (real agent)

- Run probes first (proposed list): the stream-json shapes of Claude Code, a unix-socket MCP
  inside a rootless container, and a server on port 3000 in a container while the host holds
  port 3000.
- Podman worker image and launch, with CPU, memory and process limits. No host networking, and
  no published ports.
- Claude Code runner and a mapper from its events to transcript entries.
- Hand a merge conflict to the runner, with a guard for a second conflict.
- Per-job MCP with `get_task`, `post_progress`, `draft_comment` (creates a pending action) and
  `finish`.

### Later

- Phase 3: validator, retries at most 2.
- Phase 4: claim, draft PR, push, Linear writes with approval, notifications, `jobs.branch`,
  a git identity check before every push.
- Phase 5: GitHub poller, retention sweep (`RUN_RETENTION_DAYS`), branch cleanup.
- Phase 6: second agent (OpenCode) and a box-wide semaphore for test runs.
- Work instance: only after one full ticket to draft PR cycle on the personal instance.

## Not yet answered

These need a decision from a person.

1. **Build.** `.js` extensions or esbuild? Not chosen. `decisions.md` open item 1.
2. **Leaving In Progress.** On the personal instance, does the owner move a ticket on, or does
   steward do it when a draft is ready? Assumed: the owner.
3. **Unsaved work.** Does an agent commit as it goes? A crash recovery clears the worktree and
   drops uncommitted edits. Phase 2 must choose.
4. **Merge conflicts.** The echo runner cannot resolve one, so the job fails as `agent` today.
   What does the real runner do, and when does it give up?
5. **Network for job containers.** Which outside hosts may an agent reach? Only the model API,
   or also package registries? Not decided.
6. **Notifications.** Self-hosted ntfy is chosen. Still open: how a phone button reaches an API
   that listens only on `127.0.0.1`.
7. **`ask_human`.** It needs a new `awaiting_input` state. Deferred.
8. **Auth failures in a fetch.** Only `Repository not found` fails at once. Other auth messages
   are retried as `infra`. The split by wording is accepted, not loved.
9. **How many jobs at once.** The cap is 3 per instance. A second instance would double it. The
   machine has 15 GiB of memory, so the total needs a limit.

## Not yet checked

Each of these needs a run on the real box.

- Boot with lingering enabled, and the host units under systemd (blocked by the missing build).
- Container start order: a service is "active" before Postgres accepts connections.
- Redis AOF persistence after a hard kill. Only a clean restart was tested.
- Linear: `Todo` and `Backlog` tickets, a second page of results, a null description, and
  `isMe` with more than one user. Only `In Progress` tickets were tried.
- GitHub accepts a draft PR whose branch has only an empty commit.
- The syntax of ntfy action buttons.
- Claude Code stream-json event shapes, and a unix-socket MCP inside a rootless container.
- Stryker with vitest 5 has only unit-level support upstream. This repo uses vitest 4.

## Known limits

- `ALLOWED_STATUSES` is read and validated but nothing uses it. It limits tracker moves, and
  steward makes none until phase 4.
- The dashboard route skips the Host check and the token. Nothing secret may go in
  `DASHBOARD_DIR`. A symlink inside it can point outside.
- The reconciler assumes one worker per instance.
- User systemd units on this machine do not enforce sandbox settings. The container is the real
  boundary.
- The agent review checks each commit. It blocks a commit that mixes a refactor with a change
  of behaviour, so keep one change per commit.

## How to keep this file true

- Change a line here in the pull request that changes the fact.
- Move an item from "To do" to "What works today" only when it is on `main` and tested.
- Move a question out of "Not yet answered" into `decisions.md`, with its evidence, when
  someone answers it. Leave a one-line pointer here until the next update.
- Put the date at the top. If the date is old, check the file before you trust it.
