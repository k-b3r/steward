// Shared domain types. Contract for every pure file; do not edit without the orchestrator.

/**
 * One tracker ticket as the orchestrator sees it: the feed has already dropped Linear's own field names and
 * node shape, and nothing below this type knows which tracker it came from. Intake turns each item into a
 * job row and stores a copy in `jobs.item`; `source` plus `sourceId` is the unique key. Linear is one
 * possible source, not the only one: src/linear-map.ts `mapIssueToWorkItem` is the adapter that builds these.
 */
export type WorkItem = {
  /** Feed name, `linear` today. With `sourceId` it is the unique key of a job. */
  source: string
  /** The tracker's own issue id, not the human key. Intake dedupes on `source` plus this. */
  sourceId: string
  /** Tracker key as people see it, e.g. `TST-1`. Names the `agent/*` branch and the transcript. */
  ticketKey: string
  /** Issue title, verbatim. Stored with the job row; the API does not serve it yet. */
  title: string
  /** Issue description. An empty string when the tracker returns none. */
  body: string
  /** Branch name the tracker suggests. Only set when the API returns a non-empty one. */
  branch?: string
  /** Label names, in the order the tracker returned them. May be empty. */
  labels: string[]
  /** Issue URL in the tracker. Stored with the job row; the API does not serve it yet. */
  url: string
  /** Tracker status name, e.g. "Todo", "Backlog", "In Progress". */
  status: string
}

export const JOB_STATES = [
  'proposed',
  'declined',
  'queued',
  'claiming',
  'running',
  'pr_open',
  'in_review',
  'changes_requested',
  'merged',
  'done',
  'failed',
  'cancelled',
] as const

/**
 * The closed set of job states. `JOB_STATES` above is the source of truth; the legal moves between them are
 * in src/transitions.ts, the database holds the column to the same list with the `jobs_state_check`
 * constraint in src/db/schema.ts, and src/api/contract.ts repeats the list so a new member fails to compile
 * until the wire schema knows it too.
 */
export type JobState = (typeof JOB_STATES)[number]

/** infra: retried with backoff. agent: phase 3 loop. setup: never retried. */
export const FAILURE_KINDS = ['infra', 'agent', 'setup'] as const

/**
 * Why a run stopped, which on its own decides whether it is retried: `infra` backs off and runs again,
 * `agent` and `setup` fail the job at once (routing in src/retry-policy.ts `decideAfterFailure`).
 * `FAILURE_KINDS` above is the source of truth, `jobs_failure_kind_check` in src/db/schema.ts enforces it,
 * and the column stays null until a transition records the first failure.
 */
export type FailureKind = (typeof FAILURE_KINDS)[number]

/**
 * One unit of work for one tracker ticket: the `jobs` row the orchestrator owns, plus the slot it holds while
 * it runs, which comes from a join with the `slots` table and not from a column here. Created by `insertJob`
 * in src/db/store.ts and changed only through `transitionJob` there; src/jobs-commands.ts and src/worker
 * return it, and src/jobs-queries.ts flattens it into the API response.
 */
export type Job = {
  /** Random UUID, the primary key. The queue and the API use it as the job id. */
  id: string
  /** Feed name, `linear` today. With `sourceId` it is unique among jobs. */
  source: string
  /** Tracker issue id, not the human key. One job per `source` plus this. */
  sourceId: string
  /** Tracker key as people see it, e.g. `TST-1`. Copied at insert and never recomputed since. */
  ticketKey: string
  /** One of `JOB_STATES`. Moves only along the edges in src/transitions.ts. */
  state: JobState
  /** Attempts so far. Goes up by one on entering `claiming`; a manual retry sets it to 0. */
  attempt: number
  /** Attempt limit copied from `MAX_ATTEMPTS` at insert, so a later config change leaves the row alone. */
  maxAttempts: number
  /** Slot number from the `slots` table, not a column on `jobs`; null unless the job holds one. */
  slot: number | null
  /** Earliest time for the next delivery, set by an infra retry and cleared on `claiming`; null runs now. */
  nextRunAt: Date | null
  /**
   * Why the last run stopped; null until a transition records a failure (`failed`, or `queued` on a retry).
   * `infra` is retried with backoff; `agent` and `setup` fail at once.
   */
  failureKind: FailureKind | null
}

export interface WorkFeed {
  /** Called once per intake poll; the caller drains the whole iterable before it decides. */
  poll(): AsyncIterable<WorkItem>
}

export interface AgentRunner {
  /** Called after the job reaches `running`. The returned session id is not stored yet. */
  start(job: Job): Promise<{ sessionId: string }>
  /** Reopens the run behind `sessionId` with the reviewer's feedback. Nothing in src/ calls it yet. */
  resume(sessionId: string, feedback: string): Promise<void>
  /** Called by `cancelJob` before the row moves to `cancelled`; a throw here leaves the job uncancelled. */
  cancel(jobId: string): Promise<void>
}

/** A pending outside write: drafted here, sent only after a human approves it. */
export const ACTION_STATUSES = ['pending', 'approved', 'rejected', 'done', 'failed'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export type PendingAction = {
  /** Random UUID, the primary key. The API serves it as the action id. */
  id: string
  /** The job this write belongs to; a foreign key into `jobs`. */
  jobId: string
  /** Kind of outside write, a free-form string such as `comment`. Nothing constrains the set yet. */
  kind: string
  /** Data the write needs, stored as jsonb. Its shape depends on `kind` and nothing checks it. */
  payload: unknown
  /**
   * One of `ACTION_STATUSES`. New rows are `pending`, a decision sets `approved` or `rejected`,
   * and nothing writes `done` or `failed` yet.
   */
  status: ActionStatus
  /** Free text from the decision, such as why it was rejected. Null while pending and when none is given. */
  reason: string | null
  /** When the row was created; the store takes it from the caller's clock. */
  createdAt: Date
  /** When a human decided; null while `pending`. Set once, together with the status. */
  decidedAt: Date | null
}
