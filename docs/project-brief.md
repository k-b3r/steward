# Project: steward: personal agent orchestrator

Status: WIP draft, revised after a grill-me pass. Open items are at the end.

Build a self-hosted orchestrator that turns Linear tickets into draft GitHub PRs via coding agents in sandboxed containers. It runs on one Linux box (Ubuntu 24.04, Ryzen 5600, 16 GB RAM), local only. It is a personal tool and must contain no employer code, ticket text, team keys, or secrets.

## Standards

Follow `k-b3r/agent-config` (`CODING_STANDARDS.md`). Start the repo with `/init-repo`: ESLint (shared config), dependency-cruiser, knip, lefthook, `repo-checks`, reusable CI, agent review. `pnpm check` and `pnpm exec repo-checks audit` must pass. Contract tests are never edited. PRs stay under 800 lines. Work on branches, never on `main`.

Fit check (record in `CONTEXT.md`):

- Orchestrator: question 1, fewer than 3 features with their own data. **Flat**: one module, pure files beside shell files. No `moduleTiers`. Split into modules when a phase adds features with their own data.
- Dashboard (later): question 3, a framework app. Follow the framework's conventions.

## Stack

TypeScript (strict, ESM), Node 22, pnpm, Hono (+ `@hono/node-server`), Drizzle + Postgres, BullMQ + Redis, Vitest, ESLint, zod. The orchestrator is plain code. No LLM in the control loop.

## Instances

One instance per context (work, personal). Nothing is a global singleton.

- `INSTANCE` env var (zod-validated) prefixes systemd units (`steward@<instance>`), Quadlet containers, ports, database names, and the runs dir (`~/steward/runs/<instance>/<job-id>/`).
- Each instance has its own Postgres and two Redis containers (BullMQ, per-slot test use). Never share Redis between roles or instances.
- Each instance has its own git author name/email and `gh` account in config. Before any push, check `git config` and `gh auth status` match the instance. Mismatch fails the job with kind `setup`.
- Work config and env live outside the repo.
- `SLOT_COUNT` per instance (zod, default 3). The allocator takes the count as an argument. A box-wide test semaphore (`flock` under `/run/steward/`) comes in phase 6.

## Interfaces

```ts
type WorkItem = {
  source: string
  externalId: string
  identifier: string
  title: string
  body: string
  branch?: string
  labels: string[]
  url: string
  status: string
}
interface WorkFeed {
  poll(): AsyncIterable<WorkItem>
}
interface StatusReporter {
  reportState(job: Job, state: JobState): Promise<void>
} // stub in phase 1, TODO(phase-4)
interface AgentRunner {
  start(job: Job): Promise<{ sessionId: string }>
  resume(sessionId: string, feedback: string): Promise<void>
  cancel(jobId: string): Promise<void>
}
```

Linear types never leave the Linear adapter. The state machine only knows `WorkItem`.

## Source of truth

Postgres is the truth for jobs, events and slots. BullMQ only delivers job IDs and runs delayed jobs; the worker re-reads everything from Postgres. Retry policy (`attempts`, `maxAttempts`, `nextRunAt`, backoff) lives in our pure code, not in BullMQ. A reconciler runs on startup:

- requeue `queued` jobs missing from Redis
- fail `running` jobs with no live worker (kind `infra`)
- free slots held by jobs that are final or failed

## Intake (Linear)

Linear is the trigger only. After a job row exists the orchestrator ignores the ticket. Cancel and retry go through the API.

Filter: team key from config, assignee `isMe`, status in `Todo`, `Backlog`, `In Progress`. No labels on tickets.

- `Todo` / `Backlog`: becomes `proposed`. You get a plain summary (identifier, title, first 300 characters of the body, labels, URL; no model). Confirm moves the ticket to `In Progress` in Linear and queues the job. Decline needs a reason and parks the job as `declined` (never processed; can be reconsidered).
- `In Progress`: queued without asking, except the baseline rule below.
- Baseline (B): tickets already `In Progress` on the first poll for a source are `proposed`, not run. A burst above `MAX_ENQUEUE_PER_POLL` also becomes proposals. Cap on open proposals.
- Before claiming, check for an existing open PR (draft or not) whose branch or title has the ticket identifier, not made by this instance. If one exists, skip the ticket: log it, create no job and no proposal.
- Dedupe: unique `source + externalId`. A job row is never recreated.
- Polling: every 30 s with jitter, exponential backoff on 429/5xx.
- Dry-run (default on): log matches and raw JSON, create nothing. With it off, matches become jobs or proposals as above. Do not assume field names; log first, then map.
- API: POST `https://api.linear.app/graphql`, header `Authorization: <key>` (no `Bearer`).

## Job lifecycle

States: `proposed`, `declined`, `queued`, `claiming`, `running`, `pr_open`, `in_review` ⇄ `changes_requested`, `merged`, `done`, `failed`, `cancelled`.

- `proposed → queued | declined`; `declined → proposed`.
- `failed → queued | cancelled`; `cancelled → queued` (retry reuses the row, increments `attempt`). `merged` and `done` are final; retry returns 409.
- `claiming` holds the slot and creates the claim; a claim failure means no agent started.
- One function enforces legal transitions, with tests.

Failure kinds (stored with a free-text `reason` on the `job_events` row):

- `infra`: container start, timeout, OOM, network, Redis/Postgres blip. Retried with exponential backoff, N from config (default 3).
- `agent`: the agent ran but validation failed or no usable result. Handled by the phase 3 capped loop, not generic backoff.
- `setup`: missing repo path, bad config, rejected auth, identity mismatch. Never retried.
  `failed` means retries exhausted: this is the dead-letter. You are notified (phase 4) once per new failure plus a daily reminder. Actions: retry, cancel, retry with feedback (phase 2+).

## Flow per job (phases 3-4)

1. **Claim**: orchestrator pushes an empty commit to `agent/<identifier>` and opens a **draft PR**. The PR is the visible lock. Verify in a scratch repo that GitHub accepts it. Record in `docs/decisions.md`.
2. **Run**: the agent works in a local worktree and commits locally. No credentials in the container.
3. **Validate** (typecheck, lint, tests, diff policy, retries ≤2). Fail: nothing is pushed and the draft stays empty.
4. **Push** the agent's commits once, to the same branch, with the validation report in the PR body.
5. **Notify**: "draft ready". You review and mark it ready yourself.

## Writes to outside systems

- Status move `Todo/Backlog → In Progress`: part of the confirm.
- PR link to the ticket: automatic, if not already linked.
- Comments: drafted in full, shown to you, sent only after approval. Never `auto`.
- Closing a draft PR left behind by a failed or cancelled job: needs your approval.
- Status move to `In Review` (work instance): automatic once the PR is approved (phase 5, needs the GitHub poller). A per-instance setting, `autoInReview`; not assumed for the personal instance.
  Mechanism: one `pending_actions` table (`jobId`, `kind`, `payload`, `status`, `reason`) for every action that needs your approval. Nothing is sent before approval. Phase 1 builds the table, the pure approve/reject logic and the endpoints, and sends nothing.

## Tables (Drizzle)

`jobs` (unique `source + externalId`; `attempt`, `maxAttempts`, `nextRunAt`), `job_events` (append-only: state, failure kind, reason), `slots`. `pending_actions`.

## Slots

`SLOT_COUNT` slots (0..N-1). A job takes a free slot at `claiming` and releases it on `failed`, `cancelled`, or final. Each slot has its own Postgres database (cloned from a template DB) and its own logical Redis DB index on the per-slot Redis. Allocation logic is pure (`allocate.ts`); storage is separate.

## Transcripts

`~/steward/runs/<instance>/<job-id>/`:

- `transcript.jsonl`: one envelope per line, `{ seq, ts, kind, data }`. `kind` in `system | assistant | tool | result | error | orchestrator`. `data` holds the raw agent event unmodified. One writer for runner and orchestrator lines. `seq` increases monotonically so the SSE tail can resume (`Last-Event-ID`).
- `raw.jsonl`: byte-exact runner output, mode `0600`, never served by the API.
  Redaction applies to orchestrator-originated lines and process logs only, not to agent output. Retention: `RUN_RETENTION_DAYS` (default 30), sweep in phase 5. Verify Claude Code's stream-json event shapes against the docs or a probe before writing the mapper.

## API

Hono, `/v1` prefix, chained route definitions, `src/api/contract.ts` exports `AppType` and the zod schemas. Bind to `127.0.0.1` only.

- `GET /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/log` (SSE tail), `POST /v1/jobs/:id/{retry,cancel,confirm,decline}`, `GET /v1/actions?status=pending`, `POST /v1/actions/:id/{approve,reject}`.
- Auth: `API_TOKEN` bearer, constant-time compare, redacted in logs. Reject any `Host` that is not `127.0.0.1:PORT` or `localhost:PORT`. Reject cross-origin requests unless in `ALLOWED_ORIGINS` (default empty).
- SSE clients use `fetch` streaming, since `EventSource` cannot set headers.
- Dashboard (later): `dashboard/` in this repo, a pnpm workspace member added when it starts. It imports only `src/api/contract.ts` as types (enforced with a dependency-cruiser rule). The token sits in `sessionStorage`; note the XSS risk in `docs/security.md`.

## Layout

```
src/
  platform/        config (zod), logger (redacting), clock, delay, http, git helpers
  transitions.ts   pure state machine         (+ pure core files, see pureCorePaths)
  allocate.ts      pure slot allocation
  linear-map.ts    pure WorkItem mapping
  db/              drizzle schema, migrations
  linear.ts        WorkFeed implementation
  runner/          AgentRunner interface, echo stub, transcript writer
  worker/          BullMQ consumer, reconciler
  api/             Hono entry point and contract.ts
deploy/            systemd template unit, Podman Quadlet files, config examples
test/              synthetic fixtures only
docs/              architecture.md, security.md, decisions.md, project-brief.md
```

The tree is a starting point. `/init-repo` and the fit check decide the final names and the `pureCorePaths` globs.

## Phase 1 scope (do ONLY this)

1. `/init-repo`, `.env.example`, `config.example.json`, `.gitignore` (`config.local.json`, `.env`).
2. DB schema, migrations, state machine with full tests (including the new edges).
3. Linear intake: filter, polling, backoff, dedupe, baseline and cap, dry-run, mapping from synthetic fixtures. Log raw JSON first.
4. Slot allocator with tests (allocate, release, exhaustion, `SLOT_COUNT`) and the startup reconciler (kill mid-job, restart, job requeued or failed `infra`, slot free).
5. Retry policy as pure code with tests (backoff, failure kinds).
6. Transcript writer (both files) with tests.
7. Hono API with auth, Host/Origin checks, confirm/decline, `GET /v1/jobs?state=…`, SSE tail with resume.
8. Worker stub: take a queued job, make a git worktree for the configured repo path, run the echo runner, write transcripts, mark done.
9. `deploy/`: systemd template unit (own user, `EnvironmentFile`), Quadlet units for Postgres and two Redis on a per-instance network.

Out of scope: real agent runs, Podman worker launch, validation, push and PRs, claim, GitHub reads, ntfy, Linear writes, OpenCode, dashboard, retention sweep. Leave typed stubs and `TODO(phase-N)` markers.

## Rules (project-specific)

- Secrets only via env. Never log keys; redact `Authorization`.
- No GitHub or Linear credentials in agent containers (`docs/security.md`).
- The orchestrator pushes, opens PRs and updates Linear. Agents only commit locally in a worktree.
- Duplicate once, extract on the third use.
- Verify uncertain facts (Linear filter syntax, Podman flags, Claude Code flags, ntfy action syntax, GitHub empty-commit PRs) against official docs or a probe. Record in `docs/decisions.md`.

## Deliverables

Working phase 1 with `pnpm check` and `repo-checks audit` passing; `README.md` (run instructions, dry-run); `docs/architecture.md`; `docs/security.md`; `docs/decisions.md`; unresolved questions and exact next steps for phase 2.

## Rollout

Personal first. The work instance is created only after the personal one has run a full ticket-to-draft-PR cycle.

- Build and test against a personal Linear workspace and a private scratch repo on the personal GitHub account. Use the scratch repo for the probes too (empty-commit draft PR, `gh` identity check).
- Every phase starts in dry-run on the personal instance. Turn dry-run off only after reading the logged JSON.
- The work instance is a second config and env file outside the repo, with its own `INSTANCE`, key, team key, `gh` account and git identity. Nothing in the repo changes to add it.

## Phase roadmap

2. Podman worker image and launch (`--userns=keep-id`, `--cpus`, `--memory=2g`, `--pids-limit`, `--cap-drop=ALL`, `no-new-privileges`), Claude Code headless run, timeout and max-turns caps.
3. Validator (typecheck/lint/test in container, diff policy), retries ≤2.
4. Claim (empty commit and draft PR), push, validation report, Linear writes with approval, ntfy.
5. GitHub poller (reviews, `/agent` comments, Actions `conclusion`, merge, cleanup), retention sweep.
6. OpenCode adapter, box-wide test semaphore, dashboard.

## Decided since the last draft

- One `pending_actions` table for all approvals.
- Work: PR approved -> Linear `In Review` automatically.
- Existing PRs this instance did not make: skip.
- Both instances run on this box. The name is `steward`.

- A "PR approved" is a GitHub review approval (work instance).
- Personal instance: you are the only user, so no review approval exists. `autoInReview` is off there. No `In Review` move.
- Manual work: you open a draft PR before moving a ticket you work on by hand to `In Progress`. The existing-PR skip rule is the guard. No extra rule for in-progress manual work.

## Open items

- ntfy (later, phase 4): self-host or `ntfy.sh`; what ticket text may leave the box; how phone action buttons reach a `127.0.0.1` API.
- Personal instance: when does a ticket leave `In Progress`? You move it yourself, or the orchestrator moves it when the draft is ready? (Assumed: you.)
