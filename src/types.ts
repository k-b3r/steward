// Shared domain types. Contract for every pure file; do not edit without the orchestrator.

export type WorkItem = {
  source: string
  externalId: string
  identifier: string
  title: string
  body: string
  branch?: string
  labels: string[]
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
  'ci_failed',
  'in_review',
  'changes_requested',
  'merged',
  'done',
  'failed',
  'cancelled',
] as const
export type JobState = (typeof JOB_STATES)[number]

/** infra: retried with backoff. agent: phase 3 loop. setup: never retried. */
export const FAILURE_KINDS = ['infra', 'agent', 'setup'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

/** One state change of a job, for the timeline a person reads. */
export type JobEvent = {
  fromState: JobState | null
  toState: JobState
  failureKind: FailureKind | null
  reason: string | null
  at: Date
}

/** How a run ended. `retry` is an automatic infra retry: the job went back to the queue. */
export const RUN_OUTCOMES = ['done', 'pr_open', 'retry', 'failed', 'cancelled'] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

/** One execution of a job. A retry or a resume adds a run; the job row stays one per ticket. */
export type Run = {
  jobId: string
  /** 1, 2, 3, ... per job. Not reset by a manual retry. */
  number: number
  slot: number | null
  startedAt: Date
  endedAt: Date | null
  outcome: RunOutcome | null
  failureKind: FailureKind | null
}

export type Job = {
  id: string
  source: string
  externalId: string
  identifier: string
  title: string
  /** The ticket description, when the caller has it. The store keeps it in the job's item. */
  body?: string
  url: string
  createdAt: Date
  state: JobState
  attempt: number
  maxAttempts: number
  slot: number | null
  nextRunAt: Date | null
  failureKind: FailureKind | null
  /** The branch the claim pushed. Null until a claim runs (CLAIM_ENABLED). */
  branch: string | null
}

export interface WorkFeed {
  poll(): AsyncIterable<WorkItem>
}

export interface AgentRunner {
  /** `runNumber` is the job's open run (src/runs.ts): the runner keeps that run's output apart. */
  start(job: Job, runNumber: number): Promise<{ sessionId: string }>
  resume(sessionId: string, feedback: string): Promise<void>
  cancel(jobId: string): Promise<void>
}

/** A pending outside write: drafted here, sent only after a human approves it. */
export const ACTION_STATUSES = ['pending', 'approved', 'rejected', 'done', 'failed'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export type PendingAction = {
  id: string
  jobId: string
  kind: string
  payload: unknown
  status: ActionStatus
  reason: string | null
  createdAt: Date
  decidedAt: Date | null
}
