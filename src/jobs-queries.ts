// What a caller may read, shaped for the wire. The HTTP layer validates and serializes; it never
// decides which fields are public, how many rows come back, or which buttons a state allows.
import { buildDigest, WAITING_STATES, type Digest } from './digest'
import { allowedActionsFor, type JobAction } from './jobs-commands'
import type { ActionStatus, FailureKind, Job, JobEvent, JobState, PendingAction, Run, RunOutcome } from './types'

export type QueryStore = {
  getJob(id: string): Promise<Job | null>
  listJobs(filter?: { state?: JobState; limit?: number }): Promise<Job[]>
  listRuns(jobId: string): Promise<Run[]>
  listEvents(jobId: string, limit?: number): Promise<JobEvent[]>
  listActions(filter?: { status?: string; limit?: number }): Promise<PendingAction[]>
}

export type QueryDeps = { store: QueryStore }

/** A job as the API returns it. No tracker external id, dates as ISO strings, actions included. */
export type JobSummary = {
  id: string
  identifier: string
  /** The ticket text, so a person can tell two jobs apart without opening the tracker. */
  title: string
  url: string
  source: string
  state: JobState
  attempt: number
  maxAttempts: number
  slot: number | null
  nextRunAt: string | null
  failureKind: FailureKind | null
  createdAt: string
  allowedActions: JobAction[]
}

/** One state change, as the timeline shows it. */
export type JobEventSummary = {
  from: JobState | null
  to: JobState
  failureKind: FailureKind | null
  reason: string | null
  at: string
}

/** One execution of a job as the API returns it. The job id is left out: the caller asked by it. */
export type RunSummary = {
  number: number
  slot: number | null
  startedAt: string
  endedAt: string | null
  outcome: RunOutcome | null
  failureKind: FailureKind | null
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
    title: job.title,
    url: job.url,
    source: job.source,
    state: job.state,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    slot: job.slot,
    nextRunAt: job.nextRunAt === null ? null : job.nextRunAt.toISOString(),
    failureKind: job.failureKind,
    createdAt: job.createdAt.toISOString(),
    allowedActions: allowedActionsFor(job.state),
  }
}

function toRunSummary(run: Run): RunSummary {
  return {
    number: run.number,
    slot: run.slot,
    startedAt: run.startedAt.toISOString(),
    endedAt: run.endedAt === null ? null : run.endedAt.toISOString(),
    outcome: run.outcome,
    failureKind: run.failureKind,
  }
}

/** A job's state changes, oldest first. */
export async function listEvents(deps: QueryDeps, jobId: string): Promise<JobEventSummary[]> {
  const events = await deps.store.listEvents(jobId)
  return events.map((event) => ({
    from: event.fromState,
    to: event.toState,
    failureKind: event.failureKind,
    reason: event.reason,
    at: event.at.toISOString(),
  }))
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

/** A job's runs, oldest first. */
export async function listRuns(deps: QueryDeps, jobId: string): Promise<RunSummary[]> {
  return (await deps.store.listRuns(jobId)).map(toRunSummary)
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

/**
 * Everything waiting on a person, read-only. Every row in a waiting state is read, without a limit:
 * the store returns newest first, so a cap would drop the oldest rows, which the digest lists first.
 */
export async function getDigest(deps: QueryDeps, now: Date): Promise<Digest> {
  const lists = await Promise.all(WAITING_STATES.map((state) => deps.store.listJobs({ state })))
  return buildDigest({ jobs: lists.flat(), now })
}
