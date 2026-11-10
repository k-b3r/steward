# Wiring plan: the production run

The pieces exist and are merged (decisions 30-38). Nothing connects them yet. This is the plan for
the PRs that do, in order. Each is small, tested first, and green on its own. The first three change
nothing a person sees; the last three change what a confirmed ticket does.

## Where we are

- `src/runner/pi.ts` is the real runner. `src/bootstrap.ts` still builds `createEchoRunner`.
- `src/validate.ts` runs the config's checks but nothing calls it.
- `src/platform/github.ts` can push, open a draft PR and list a ticket's PRs; nothing calls it.
- `src/linear-write.ts` can move a ticket's state and attach a PR link; nothing calls it.
- `process-job.ts` does: slot, claim, worktree, run the runner, `done`. No PR, no push, no checks.
- `jobs` has no `branch` and `runs` has no `sessionId`, so a claim and a resume have nowhere to live.

## Slice 1: the config and the schema

- Config keys, all with defaults that keep today's behavior: `RUNNER` (`echo` | `pi`), `PI_IMAGE`
  (`steward-pi:1.5.0`), `PI_MODEL`, `PI_TURN_CAP` (40), `PI_TIMEOUT_MS` (20 min), `CLAIM_ENABLED`
  (false), `VALIDATION_ENABLED` (false). `PI_MODEL_API_KEY` is a secret: environment only, like the others,
  redacted and never logged.
- Slices 3 and 4 add what only they need: `WORKSPACE_REPO` (the `owner/name` a claim opens the PR
  on) in slice 3, and `VALIDATION_CONFIG_FILE` plus `VALIDATION_IMAGE` in slice 4.
- Migration: `jobs.branch` (text, null), `runs.session_id` (text, null). Drizzle schema plus the
  generated SQL.
- Proven by: `config.test.ts` defaults and refusals; a migration test that the columns exist.
- Behavior change: none.

## Slice 2: the runner switch and resume across a restart (done, decision 40)

- `bootstrap.ts` builds the runner from `RUNNER`: the echo runner as today, or the Pi runner with a
  real `podman spawn`, `execPodman`, the clock and a cancelable `sleep`.
- `process-job.ts` stores the session id on the run, and `resumeJob` continues a job waiting in
  `changes_requested` or `ci_failed`: it restores the branch in a worktree, then `runner.resume`. No
  stored session means a fresh start inside the same call, never a job parked in `running`.
- The `podman` client gets an allowlisted environment, not the host's.
- Proven by: integration tests for a resume, a job that is not waiting, a job with no session, and a
  resume that fails.
- Behavior change: none until `RUNNER=pi` is set, and nothing calls `resumeJob` until the API route
  and the poller land.

## Slice 3: the claim

- In `process-job.ts`, after the worktree is ready and before the runner starts, when `CLAIM_ENABLED`:
  1. the identity check (`checkIdentity`): a mismatch is a `setup` failure;
  2. if the owner's own account already has an open PR for the ticket that steward did not open,
     skip the job (cancel it, reason `existing pull request`). PRs by other accounts are ignored;
  3. push an empty commit on the job branch and open a draft PR, then store the branch and number
     on the job and attach the PR link in Linear.
- A failed claim means no agent starts, so the slot is released in the `finally` as today.
- Status: the module is built and not wired (`src/claim.ts`, `src/claim-policy.ts`, `jobs.pr_number`
  and `jobs.pr_url`, `WORKSPACE_REPO`; decision 42). The `process-job.ts` call, the skip
  transition and the Linear link are still to do.
- Proven by: integration tests against a fake `Exec` and one real run on the scratch repo.
- Behavior change: a draft PR appears when a confirmed ticket starts, if enabled.

## Slice 4: validation and push

- After the runner returns, when `VALIDATION_ENABLED`: `validateWorktree`. Pass: `pushBranch`,
  then `updatePrBody` with the report, then `running -> pr_open`. Fail with a retry: resume Pi with
  the feedback (at most twice, in the same run). Exhausted: `agent` failure, nothing pushed.
- The index: `collectChangedFiles` stages with `git add -A`, so the commit step must commit what is
  staged, not assume an empty index.
- Proven by: integration tests for pass, retry twice, exhausted, and a forbidden path (no checks
  run, nothing pushed).
- Behavior change: the draft PR now has the agent's commit and a report; the job ends at `pr_open`.

## Slice 5: the Linear move and the digest

- `confirmJob` moves the ticket to the first of `ALLOWED_STATUSES` (`In Progress`) and records a
  pending action if the write fails, so a failure can be retried by a person. The API stays the
  same; the side effect is on the command.
- One digest of everything waiting on a person (proposals, the draft states, `failed` jobs), as
  decided, is read at `GET /v1/digest`: the items, their counts, and the same list as plain text
  (decision 44). Delivering it (ntfy) is not built, because the message hosting is an open
  decision. `failed` keeps its immediate notification.
- Proven by: unit tests with a fake writer; a real move on one ticket, then undone by hand. The
  digest adds unit and route tests for its ordering, ages, wording and empty case.
- Behavior change: confirming a ticket moves it in Linear.

## Not in this plan

Sub-agents in the job log (next-work item 4), the dashboard's live panels, the GitHub poller
(phase 5) and the retention sweep. Each is its own follow-up.
