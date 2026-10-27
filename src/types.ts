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
