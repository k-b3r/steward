# Next work

The plan for the next changes, agreed 2026-11-07. Each item says what changes, which files it
touches, what proves it, and what is still undecided. Do the items in order: item 1 is the design
record, and the later items depend on its decisions.

Settled in that discussion:

- An approval comes before work starts (the `proposed` gate) and a **draft PR** is the claim
  (decision 7 in `decisions.md`). No approval comes before the PR.
- A job can be resumed and ends only when its PR is merged.
- `failed` counts as ongoing: it still blocks the ticket.
- Every run is kept as its own record.
- The list of a ticket's jobs and runs is in the dashboard and API only. Nothing is written to
  Linear.

## 1. Record the design: a `ci_failed` state and per-run records

Design only, no behaviour change. Do this in one PR with the code that needs it, per
`CODING_STANDARDS.md`.

Status 2026-11-07: the state, the runs table, per-run transcripts and the runs endpoint are on
`ci-failed-state` and `runs-api`, and the dashboard shows a job's runs and history (`ui-truth`).
Still open from this item: the `?ticket=` filter on `GET /v1/jobs`, and whatever sets `ci_failed`.

- **New state `ci_failed`**, between `pr_open` and `in_review`. "Ongoing" for a ticket means CI is
  red because of this PR. A failure that also occurs on `BASE_BRANCH` does not count. Edges:
  - `pr_open -> ci_failed`, `in_review -> ci_failed`: a check failed on this PR.
  - `ci_failed -> running`: the agent is resumed to fix it.
  - `ci_failed -> in_review`: a person fixed it by hand.
  - `ci_failed -> failed | cancelled`: as its neighbours.
- **Runs as their own table.** `jobs` stays one row per ticket (`source + externalId` is unique,
  `src/db/schema.ts` line 51) and ends at `merged`. A `runs` row covers one execution: `jobId`,
  run number, slot, `startedAt`, `endedAt`, outcome and failure kind. Retries and resumes add a run.
  `job_events` stays the append-only state log.
- **Transcripts per run.** Today the folder is keyed by job id only (`src/runner/echo.ts` line 40),
  so a second run appends to the same `transcript.jsonl` and the two become indistinguishable.
  Move to `runs/<job-id>/<run-number>/`.
- **Wire and dashboard.** `GET /v1/jobs` gains a filter by ticket identifier. A read endpoint lists a
  job's runs. The dashboard gets a `ci_failed` label, icon and lane (`dashboard/src/model.ts`) —
  done, and so is the dashboard view of a job's runs and its state history.

Files: `src/types.ts`, `src/transitions.ts` and its test, `src/api/contract.ts` (the state list is
duplicated there with a completeness check, so the typecheck fails until it is updated),
`src/db/schema.ts` plus a generated migration, `dashboard/src/model.ts`, and
`docs/decisions.md` + `docs/architecture.md` (the state table).

Proven by: `src/transitions.test.ts` edge by edge, including that every state has an entry and no
self-transition; an integration test that a resumed job gets a second run row and a second
transcript folder; `pnpm check`.

Still undecided:

- Which check results make a state `ci_failed`: GitHub's checks, or a validation verdict from phase
  3? The base-branch comparison needs the phase 5 poller, so the classification lands then; the state
  and its edges land now.
- Whether a manual `retry` from `failed` counts as a new run. Proposed: yes.
- Whether `merged` closes the run or a later sweep does.

## 2. Fix the crash and the API defects

Found while running the system end to end against real Postgres and Redis.

- **A Postgres outage kills the process.** `createPool` adds no error listener
  (`src/platform/db.ts` lines 11–13), so a dropped idle connection crashes the worker, and the API
  with it. Log the event instead, and test that the worker survives Postgres restarting.
- **`limit` is ignored.** `listJobs` and `listActions` never apply it (`src/db/store.ts` lines 137
  and 306), so `GET /v1/jobs?limit=1` returns every row. Add `.limit()` and an integration test.
- **A non-UUID action id returns 500.** The param schema accepts any string (`src/api/app.ts` line
  62). Postgres rejects it as a uuid. Use `z.uuid()`, as the job routes do.

## 3. Decide the concurrency

`new Worker(...)` sets no `concurrency` (`src/worker/queue.ts` lines 73–79), so one job runs at a
time even though `SLOT_COUNT` is 3. Decide between raising it to `SLOT_COUNT` and documenting one.
The reconciler assumes one worker per instance, so the change needs that assumption revisited and
a test with two jobs at once.

## 4. Decide the intake rule for a burst

`MAX_ENQUEUE_PER_POLL` is all-or-nothing: if a poll finds more new `In Progress` tickets than the
cap, none is queued (`src/intake-policy.ts` lines 51–55, 79–80). The name reads as a split. Options
in the discussion: keep it, cap in-flight work instead, or keep only the first-poll baseline gate.
Whichever is chosen, record it in `decisions.md` item 6 and align the name or the behaviour.

## Later, in phase order

1. Build script, so the systemd units can start (`decisions.md` open item 1).
2. Phase 2: the container runner, resume from `ci_failed`, handing a merge conflict to the agent.
3. Phase 3: the validator.
4. Phase 4: the claim, the draft PR, push, Linear writes with approval, notifications.
5. Phase 5: the GitHub poller (reviews, checks, merge), which is what makes `ci_failed` meaningful,
   then retention and branch cleanup.
6. Phase 6: the second agent adapter and the box-wide test semaphore, which is when the slots Redis
   (`REDIS_SLOT_URL`) is used for the first time.
