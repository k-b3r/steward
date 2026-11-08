# Walkthrough: how steward works today

A baseline for a person, not a spec. Last checked against the code on `main` at `d083e97`.
Describes the state after #36 (branch named for the ticket).
Details live in [architecture.md](architecture.md) and [decisions.md](decisions.md). If this page
and the code disagree, the code wins: fix this page.

## What is up after start

A running instance is three container services plus two host processes. Nothing else.

```
Podman containers (systemd user units, 127.0.0.1 only; start-stack.sh starts them)
  steward-<i>-postgres      jobs, job_events, runs, slots, actions       port base
  steward-<i>-redis-queue   BullMQ queue                                 port base+1
  steward-<i>-redis-slots   per-slot test Redis (unused until phase 6)   port base+2

Host processes (systemd user units; need a build that does not exist yet)
  steward-worker@<i>   src/entries/worker.ts
  steward-api@<i>      src/entries/api.ts        API_PORT, 127.0.0.1 only
```

Both processes read the same `.env` through `loadConfig`. Check order on a cold start:

1. **Containers first.** `start-stack.sh` creates the two Podman secrets, renders the Quadlet
   files, starts the services, waits for Postgres and creates the empty database.
2. **Worker start** (`composeWorker`, then `entries/worker.ts`), in this order:
   1. `migrateDb`: creates or updates the tables. Only the worker does this.
   2. `reconcile`: the worker has no memory of earlier runs, so it treats every `claiming` or
      `running` job as orphaned. Each is retried with backoff or failed as `infra`. It then frees
      leaked slots and requeues `queued` jobs missing from Redis. It logs `Reconciled on startup`.
   3. `queue.startWorker`: starts consuming job ids, one at a time. It logs `Worker started`.
   4. The **poll loop**: read Linear, run intake, sleep `POLL_INTERVAL_MS` (with jitter, and a
      longer wait after failures), repeat until stopped. A failed poll is logged, never fatal.
3. **API start** (`composeApi`): binds `127.0.0.1:API_PORT` and logs `API listening`. It serves
   `/v1` (token auth) and, if `DASHBOARD_DIR` is set and built, the dashboard from the same origin.
   It runs no poll and no worker: it only reads Postgres and writes person actions
   (confirm, decline, reconsider, retry, cancel, approve action).

So on an empty first start: tables exist, no slots held, nothing queued, and the first poll turns
every `In Progress` ticket into a `proposed` job (the baseline rule) for you to confirm. With
`DRY_RUN=true` the poll logs raw Linear responses and writes nothing.

Shut down (`SIGTERM`): the worker closes the queue and the pool; a job mid-run is left for the
next start's reconciler. The API closes its server, queue and pool.

The API and worker only talk through Postgres and Redis, never to each other. A confirm in the API
writes the row and enqueues the id; the worker picks it up.

## The flow

```
Linear (INV board)
   │  poll                       src/linear.ts (read only), src/linear-map.ts
   ▼
intake                           src/intake.ts + src/intake-policy.ts
   │  one decision per ticket: queue, propose, or skip
   ▼
Postgres: job row (state)        src/db/store.ts, src/transitions.ts
   │  job id only
   ▼
BullMQ queue (Redis)             src/worker/queue.ts
   ▼
worker: processJob               src/worker/process-job.ts
   │  take a slot → git worktree on branch <TICKET-ID> → run the agent
   ▼
runner                           src/runner/echo.ts  (a STUB; Pi comes later)
   ▼
job ends `done` today            (real target: draft PR → review → merged)
```

A person watches and acts through the Hono API (`src/api/`) and the dashboard (`dashboard/`).

## What each step decides

1. **Poll and intake.** A poll reads tickets into `WorkItem`s. `decideIntake` (pure) says, per
   ticket:
   - already has a job → skip
   - status `In Progress` → queue it, **except**:
     - first poll for a source (the baseline) → `proposed`, not run
     - more new `In Progress` tickets than `MAX_ENQUEUE_PER_POLL` in one poll → **all** of them
       become `proposed` (all-or-nothing; this is open item 4)
   - status `Todo` or `Backlog` → `proposed`
   - any other status → skip
   - proposals stop once `MAX_OPEN_PROPOSALS` are open
     A person confirms or declines each `proposed` job.
2. **Queue.** BullMQ carries only the job id. Postgres is the truth: the worker re-reads the row.
3. **Worker.** `processJob`: ignore it unless the job is `queued`; take the lowest free slot (none
   free → try again in 5 s); move to `claiming`; fetch the base branch; create or reuse the
   worktree on the branch named for the ticket (for example `INV-12`); run the runner. Slot and worktree are cleaned up on every path.
4. **Failure.** Each failure gets a kind. `infra` retries with backoff up to 3 attempts. `agent`
   is not retried by backoff (the phase 3 validation loop will own it). `setup` never retries.
   Out of retries means `failed`.
5. **Reconciler** (worker start-up): requeue `queued` jobs missing from Redis; fail `running` jobs
   with no live worker; free slots held by final or failed jobs.

## Job states in one breath

`proposed → queued → claiming → running → (pr_open → in_review → merged → done)`, with
`ci_failed`, `changes_requested`, `failed`, `cancelled` and `declined` on the side.
Source: `src/transitions.ts`. **Only `claiming` and `running` hold a slot**, so open PRs waiting
for review never starve the worker. Today the echo runner goes `running → done` and nothing sets
`ci_failed`.

## Records

- `jobs`: one row per ticket. `job_events`: append-only state log. `runs`: one row per execution
  (a retry or a resume adds one). Transcripts live in
  `~/steward-instances/<instance>/runs/<job-id>/<run-number>/`.

## What is real and what is not

| Real, tested                                               | Stubbed or missing                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| State machine, retry policy, slot allocation, intake rules | The agent: echo runner stands in for Pi                            |
| Postgres store, runs, transcripts, reconciler              | Any call to Linear or GitHub in anger (never run for real)         |
| Hono API and dashboard                                     | Draft PR, validation, push, tracker writes (phases 3–4)            |
| Deploy files (Quadlet, systemd units)                      | A build: `dist/` does not exist, so the units cannot start         |
|                                                            | Sub-agent spawn and reap (`src/subagent-policy.ts` is policy only) |

## Things worth knowing before the next changes

- **One job at a time.** `queue.ts` sets no `concurrency`, so `SLOT_COUNT=3` is never used in
  parallel. Raising it touches the "one worker per instance" assumption in the reconciler.
- **No LLM in steward's control loop.** The lead and sub-agent split lives inside one job.
- **The agent is Pi**, sub-agents are one-shot and spawned and reaped by steward.
- **Nothing is written to Linear** yet; the draft PR is the visible claim (decision 7).

## Check yourself

Can you answer these without looking?

1. A ticket in `Todo` appears. What happens, and who moves it on?
2. Five new `In Progress` tickets arrive in one poll and the cap is 3. What is queued?
3. A job sits in `pr_open`. Does it hold a slot? Why?
4. An `infra` failure happens on attempt 3. Where does the job end up?
5. The worker dies mid-run. What fixes the job and its slot?
6. Why does raising BullMQ concurrency need more than a one-line change?

Answers: 1 `proposed`, a person confirms. 2 None, all five become `proposed`. 3 No, so drafts
cannot starve the worker. 4 `failed` (retries exhausted). 5 The reconciler at next start: fails
the job as `infra`, frees the slot. 6 The reconciler assumes one worker, so it could fail jobs
another live worker is running.
