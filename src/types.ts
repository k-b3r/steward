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

export type Job = {
  id: string
  source: string
  externalId: string
  identifier: string
  state: JobState
  attempt: number
  maxAttempts: number
  slot: number | null
  nextRunAt: Date | null
  failureKind: FailureKind | null
}

export interface WorkFeed {
  poll(): AsyncIterable<WorkItem>
}

export interface AgentRunner {
  start(job: Job): Promise<{ sessionId: string }>
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
