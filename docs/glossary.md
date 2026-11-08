# Glossary

The words this project uses, one meaning each. Add a term when a doc or a PR starts using it.
If a word means two things somewhere, fix the code or the doc, not this page.
Describes the state after #36 (branch named for the ticket).

## Things in the system

| Term                        | Meaning                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instance**                | One full copy of steward for one context (`personal`, later `work`). Named by `INSTANCE`. It has its own containers, ports, database, env file and folder. |
| **Ticket**                  | A Linear issue on the `INV` board. Steward reads it and never changes it.                                                                                  |
| **WorkItem**                | Steward's own shape for a ticket (`src/types.ts`). Tracker details stop at the adapter.                                                                    |
| **Feed** (`WorkFeed`)       | The only way work enters: something that yields `WorkItem`s. Linear is the one feed.                                                                       |
| **Job**                     | One ticket's work. One row in Postgres, with a state. Lives until its PR is merged.                                                                        |
| **Job event**               | One line in a job's append-only state log: from, to, failure kind, reason.                                                                                 |
| **Run**                     | One execution of a job. A retry or a resume adds a run. Each has its own transcript.                                                                       |
| **Transcript**              | The record of one run: `transcript.jsonl` (served by the API) and `raw.jsonl` (never served).                                                              |
| **Slot**                    | One of `SLOT_COUNT` places a job can run. Held only in `claiming` and `running`.                                                                           |
| **Worktree**                | A git working folder for one job, on the branch named for the ticket (for example `INV-12`).                                                               |
| **Runner** (`AgentRunner`)  | The thing that starts, resumes or cancels the agent. Today a stub (echo). Later Pi.                                                                        |
| **Agent**                   | The coding AI (Pi). It works inside one job. Steward's own logic has no AI in it.                                                                          |
| **Sub-agent**               | A one-shot helper agent that steward spawns and reaps, never the lead agent.                                                                               |
| **Action** (pending action) | Something steward wants to do that needs a person's approval first.                                                                                        |
| **Draft PR**                | The visible claim on a ticket: a draft pull request from the branch named for the ticket (for example `INV-12`). Phase 4.                                  |

## Processes and stores

| Term                      | Meaning                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **Worker**                | The host process that polls Linear, consumes the queue and does the work.                          |
| **API**                   | The host process that serves `/v1` and the dashboard. It reads Postgres and writes person actions. |
| **Dashboard**             | The web page the API serves. A view of the board.                                                  |
| **Postgres**              | The source of truth for jobs, events, runs, slots and actions.                                     |
| **Queue** (BullMQ, Redis) | A to-do list of job ids. Carries no job data.                                                      |
| **Slots Redis**           | A second Redis for per-slot tests. Unused until phase 6.                                           |
| **Quadlet**               | The Podman file format that makes systemd start a container.                                       |

## Rules and moments

| Term                    | Meaning                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Poll**                | One read of the Linear board. The worker repeats it every `POLL_INTERVAL_MS`.                                |
| **Intake**              | What a poll does with what it reads: queue it, propose it, or skip it. Pure rules in `src/intake-policy.ts`. |
| **Proposed**            | A job that waits for a person to confirm or decline.                                                         |
| **Baseline**            | The first poll for a source. Tickets already `In Progress` become proposals, not work.                       |
| **Burst**               | More new `In Progress` tickets in one poll than `MAX_ENQUEUE_PER_POLL`. Today all become proposals.          |
| **Reconciler**          | The start-up repair pass in the worker. Requeues, retries or fails orphaned jobs and frees leaked slots.     |
| **Leaked slot**         | A slot held by a job that no longer should hold one.                                                         |
| **Claim**               | Taking a slot and moving to `claiming`. In phase 4, also the draft PR that shows the claim.                  |
| **Retry**               | Another attempt. Automatic for `infra` failures, manual from `failed`.                                       |
| **Backoff**             | The growing wait between automatic retries, with jitter.                                                     |
| **Dry run** (`DRY_RUN`) | Polls and logs, writes no jobs.                                                                              |

## Failure kinds

| Term         | Meaning                                                                             |
| ------------ | ----------------------------------------------------------------------------------- |
| **`infra`**  | The box or a service failed. Retried with backoff up to `MAX_ATTEMPTS`.             |
| **`agent`**  | The agent's work failed. Not retried by backoff; phase 3's validation loop owns it. |
| **`setup`**  | Bad config, missing repo, bad auth. Never retried.                                  |
| **`failed`** | A job state: retries are over. The dead-letter state. It still blocks the ticket.   |

## Job states

`proposed`, `declined`, `queued`, `claiming`, `running`, `pr_open`, `ci_failed`, `in_review`,
`changes_requested`, `merged`, `done`, `failed`, `cancelled`. The edges are in
[architecture.md](architecture.md) and `src/transitions.ts`. Only `claiming` and `running` hold a
slot. `merged` and `done` are final.

## Phases

1 core and echo runner (done). 2 container runner. 3 validator. 4 claim, draft PR, tracker writes.
5 GitHub poller. 6 second agent, test semaphore, dashboard.
