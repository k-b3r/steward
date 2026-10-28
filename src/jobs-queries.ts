// What a caller may read, shaped for the wire. The HTTP layer validates and serializes; it never
// decides which fields are public, how many rows come back, or which buttons a state allows.
import { allowedActionsFor, type JobAction } from './jobs-commands'
import type { ActionStatus, FailureKind, Job, JobState, PendingAction } from './types'

export type QueryStore = {
  getJob(id: string): Promise<Job | null>
  listJobs(filter?: { state?: JobState; limit?: number }): Promise<Job[]>
  listActions(filter?: { status?: string; limit?: number }): Promise<PendingAction[]>
}

export type QueryDeps = { store: QueryStore }

/** A job as the API returns it. No tracker external id, dates as ISO strings, actions included. */
export type JobSummary = {
  id: string
  identifier: string
  source: string
  state: JobState
  attempt: number
  maxAttempts: number
  slot: number | null
  nextRunAt: string | null
  failureKind: FailureKind | null
  allowedActions: JobAction[]
}

export type ActionSummary = {
  id: string
  jobId: string
  kind: string
  payload: unknown
  status: ActionStatus
  reason: string | null
  createdAt: string
  decidedAt: string | null
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer in 1..${MAX_LIMIT}, got ${String(limit)}`)
  }
}

function toJobSummary(job: Job): JobSummary {
  return {
    id: job.id,
    identifier: job.identifier,
    source: job.source,
    state: job.state,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    slot: job.slot,
    nextRunAt: job.nextRunAt === null ? null : job.nextRunAt.toISOString(),
    failureKind: job.failureKind,
    allowedActions: allowedActionsFor(job.state),
  }
}

/** One decided action, mapped for the response. */
export function toActionSummary(action: PendingAction): ActionSummary {
  return {
    id: action.id,
    jobId: action.jobId,
    kind: action.kind,
    payload: action.payload,
    status: action.status,
    reason: action.reason,
    createdAt: action.createdAt.toISOString(),
    decidedAt: action.decidedAt === null ? null : action.decidedAt.toISOString(),
  }
}

export async function listJobs(
  deps: QueryDeps,
  filter: { state?: JobState; limit?: number } = {},
): Promise<JobSummary[]> {
  const limit = filter.limit ?? DEFAULT_LIMIT
  assertLimit(limit)
  const jobs = await deps.store.listJobs({ ...(filter.state === undefined ? {} : { state: filter.state }), limit })
  return jobs.map(toJobSummary)
}

export async function getJob(deps: QueryDeps, id: string): Promise<JobSummary | null> {
  const job = await deps.store.getJob(id)
  return job === null ? null : toJobSummary(job)
}

export async function listActions(
  deps: QueryDeps,
  filter: { status?: string; limit?: number } = {},
): Promise<ActionSummary[]> {
  const limit = filter.limit ?? DEFAULT_LIMIT
  assertLimit(limit)
  const actions = await deps.store.listActions({
    ...(filter.status === undefined ? {} : { status: filter.status }),
    limit,
  })
  return actions.map(toActionSummary)
}
