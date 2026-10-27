# Architecture

Steward turns tracker tickets into draft pull requests. A ticket triggers one job. The job
runs a coding agent in a sandboxed container, validates the result, and pushes it. The
orchestrator is plain TypeScript on the host. It has no model in its control loop.

This document describes the phase 1 shape. Later phases add the container runner, the
validator, and the GitHub and tracker writes. See [Phase boundaries](#phase-boundaries).

## Runtime shape

- One host runs every instance. Each instance gets its own Postgres, its own Redis for
  BullMQ, its own Redis for per-slot tests, its own network, and its own ports.
- Postgres and both Redis servers run as Podman containers, started by systemd user units.
  The Quadlet files are in `deploy/quadlet/`.
- The API and the worker run on the host as systemd user units
  (`steward-api@<instance>.service`, `steward-worker@<instance>.service`). They are not
  containers.
- Agents run in containers (phase 2). An agent container has no tracker or GitHub
  credentials.
- The orchestrator alone pushes commits, opens pull requests, and writes to the tracker.
- Every port is published on `127.0.0.1` only. The API binds `127.0.0.1` too.

## Interfaces

The domain types live in `src/types.ts`. The tracker types never leave the tracker
adapter; the state machine only knows `WorkItem`.

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
}

interface AgentRunner {
  start(job: Job): Promise<{ sessionId: string }>
  resume(sessionId: string, feedback: string): Promise<void>
  cancel(jobId: string): Promise<void>
}
```

- `WorkFeed` is the only way work enters the system. The tracker adapter implements it.
- `StatusReporter` has no implementation in phase 1. Its real writes are phase 4.
- `AgentRunner` starts, resumes and cancels one agent run. The echo stub is phase 1 work and
  is not built yet. The container runner is phase 2.

## Job states and transitions

The source of truth is `src/transitions.ts`. One function, `assertTransition`, enforces
these edges. Every state has an entry, so a missing or extra state is a type error.
Self-transitions are never legal.

| From                | Allowed next states                                  | Note                                                      |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `proposed`          | `queued`, `declined`                                 | A person confirms or declines a proposal.                 |
| `declined`          | `proposed`                                           | A declined job can be reconsidered.                       |
| `queued`            | `claiming`, `cancelled`, `failed`                    | A queued job can fail before it claims a slot.            |
| `claiming`          | `running`, `queued`, `failed`, `cancelled`           | `queued` is the automatic infra retry with backoff.       |
| `running`           | `pr_open`, `done`, `queued`, `failed`, `cancelled`   | `done` exists only for the phase 1 echo worker stub.      |
| `pr_open`           | `in_review`, `failed`, `cancelled`                   | The draft pull request is the visible claim.              |
| `in_review`         | `changes_requested`, `merged`, `failed`, `cancelled` | A review asks for changes or approves.                    |
| `changes_requested` | `in_review`, `running`, `failed`, `cancelled`        | Feedback can start another run.                           |
| `merged`            | `done`                                               | A merged pull request is closed out.                      |
| `done`              | none                                                 | Final.                                                    |
| `failed`            | `queued`, `cancelled`                                | Failed means retries are exhausted. Retry reuses the row. |
| `cancelled`         | `queued`                                             | A cancelled job can be retried.                           |

Notes:

- `merged` and `done` are final. A retry on either returns 409.
- A retry keeps the job row and increments `attempt`.
- `TODO(phase-4)` in `src/transitions.ts` marks `running -> done`. Remove it when the real
  runner lands.

## Failure kinds and retry rules

The failure kind is stored on the `job_events` row with a free-text `reason`.
`src/retry-policy.ts` makes the decision; it is pure code.

| Kind    | Retried                                         | Rule                                                             |
| ------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `infra` | Yes, until `attempt >= maxAttempts` (default 3) | Exponential backoff. `nextRunAt = now + delay`.                  |
| `agent` | No, not by generic backoff                      | The phase 3 capped validation loop handles it.                   |
| `setup` | Never                                           | Missing repo path, bad config, rejected auth, identity mismatch. |

Backoff: `delay = baseMs * factor^(attempt - 1)`, capped at `maxMs`, then jittered by
`jitterRatio` either way. Defaults in code: `factor = 2`, `jitterRatio = 0.2`. The caller
passes `baseMs` and `maxMs`; the config file has no keys for them yet. `MAX_ATTEMPTS`
defaults to 3.

`failed` means retries are exhausted. This is the dead-letter state. Phase 4 notifies once
per new failure and sends a daily reminder.

## Slots

`SLOT_COUNT` slots exist per instance, numbered `0..SLOT_COUNT-1`. The config default is 3;
the accepted range is 1 to 16.

- A job holds a slot only in `claiming` and `running`. `HOLDING_STATES` in `src/allocate.ts`
  is the source of truth. This deliberately differs from the first brief: an open pull
  request waiting for review does not hold a slot, so open drafts cannot starve the worker.
- `allocateSlot(slotCount, taken)` returns the lowest free slot, or `null` when the instance
  is full. `freeSlots` lists what is free. Both are pure and tested.
- Each slot has its own Postgres database, cloned from a template database. On the per-slot
  Redis it uses its own logical database index.
- `findLeakedSlots` reports slots held by a job that is final or failed. The reconciler frees
  those slots.

## Postgres is the source of truth

Postgres holds jobs, job events, slots and pending actions. BullMQ only delivers job IDs and
runs delayed jobs. The worker re-reads the job from Postgres before it acts. The retry
policy lives in our code, not in BullMQ.

The startup reconciler runs before the worker takes new work:

- Requeue `queued` jobs that are missing from Redis.
- Fail `running` jobs that have no live worker, with kind `infra`.
- Free slots held by jobs that are final or failed.

## Transcripts

Each job has a run directory: `~/runs/<instance>/<job-id>/`. The directory is mode 0700.

- `transcript.jsonl`: one envelope per line, `{ seq, ts, kind, data }`. `kind` is one of
  `system`, `assistant`, `tool`, `result`, `error`, `orchestrator`. `seq` increases
  monotonically, so the SSE tail can resume from `Last-Event-ID`.
- `raw.jsonl`: the byte-exact runner output, mode 0600. The API never serves this file.
- One writer handles runner and orchestrator lines. Agent events go into `data` unmodified.
- Redaction covers orchestrator-originated lines and process logs. It does not cover agent
  output; see [security.md](security.md).
- Retention is `RUN_RETENTION_DAYS` (default 30). The sweep is phase 5.

## Per-instance naming

`INSTANCE` matches `/^[a-z][a-z0-9-]{0,30}$/`. Nothing is a global singleton.
`instanceNames()` in `src/platform/config.ts` derives the shared names.

| Thing              | Value                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| Env file           | `~/.config/steward/<instance>.env`                                          |
| API unit           | `steward-api@<instance>.service`                                            |
| Worker unit        | `steward-worker@<instance>.service`                                         |
| Postgres container | `steward-<instance>-postgres` (`steward-<instance>-postgres.service`)       |
| Queue Redis        | `steward-<instance>-redis-queue` (`...-redis-queue.service`)                |
| Slots Redis        | `steward-<instance>-redis-slots` (`...-redis-slots.service`)                |
| Network            | `steward-<instance>-net` (file `steward-<instance>.network`)                |
| Postgres volume    | `steward-<instance>-pgdata`                                                 |
| Queue Redis volume | `steward-<instance>-redis-queue-data`                                       |
| Database           | `steward_<instance>` with hyphens replaced by underscores                   |
| Podman secrets     | `steward-<instance>-postgres-password`, `steward-<instance>-redis-password` |
| Runs dir           | `~/runs/<instance>/`                                                        |
| Ports (127.0.0.1)  | base for Postgres, base+1 for queue Redis, base+2 for slots Redis           |

`instanceNames().unit` returns `steward@<instance>`. That is the instance prefix; the
deployed units insert the role before the `@`. No code reads the unit name today.

## Code layout

Flat shape: pure decision files sit beside the shell files. See `CONTEXT.md`.

```
src/
  platform/       config.ts, logger.ts; clock, delay, http, git helpers are planned
  transitions.ts  pure job state machine
  retry-policy.ts pure backoff and failure-kind routing
  allocate.ts     pure slot allocation
  linear-map.ts   pure tracker JSON to WorkItem
  types.ts        WorkItem, Job, JobState, FailureKind, the interfaces
  db/             Drizzle schema and migrations: phase 1, not built yet
  linear.ts       WorkFeed implementation: phase 1, not built yet
  runner/         transcript.ts; the echo runner stub is phase 1 and not built yet
  api/            index.ts is a stub until phase 1 completes
  worker/         index.ts is a stub until phase 1 completes
tests/
  fixtures/       synthetic tracker data
  integration/    needs TEST_DATABASE_URL
deploy/
  quadlet/        Podman Quadlet templates with @INSTANCE@ placeholders
  render.sh       renders the templates for one instance and port base
  render.test.sh  shell test for render.sh
  systemd/        steward-api@.service and steward-worker@.service
docs/
  architecture.md, security.md, decisions.md, project-brief.md
```

The API contract (`src/api/contract.ts`, exporting `AppType`) is the only thing the future
dashboard imports from `src/`. A dependency-cruiser rule enforces that.

## Phase boundaries

1. Phase 1: config, logger, state machine, retry policy, slot allocator, tracker intake,
   transcripts, Hono API, worker stub, deploy files.
2. Phase 2: Podman worker image and launch, headless agent run, timeout and turn caps.
3. Phase 3: validator (typecheck, lint, tests, diff policy), retries at most 2.
4. Phase 4: claim with an empty commit and a draft PR, push, validation report, tracker
   writes with approval, notifications.
5. Phase 5: GitHub poller (reviews, comments, check results, merge, cleanup), retention
   sweep.
6. Phase 6: second agent adapter, box-wide test semaphore, dashboard.

The entry points are stubs today, and there is no build script yet. The systemd units
therefore expect `dist/` files that do not exist. See `docs/decisions.md`.

## Related documents

- [security.md](security.md): secrets, API exposure, per-instance isolation.
- [decisions.md](decisions.md): dated decision log, verified facts, open items.
- [project-brief.md](project-brief.md): the design.
