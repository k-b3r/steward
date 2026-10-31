// What a caller may read, shaped for the wire. The HTTP layer validates and serializes; it never
// decides which fields are public, how many rows come back, or which buttons a state allows.
import { allowedActionsFor, type JobAction } from './jobs-commands'
import type { ActionStatus, FailureKind, Job, JobState, PendingAction } from './types'

export type QueryStore = {
  /** Raw job row, `Date` fields intact, or null; production is `src/db/store.ts` getJob. */
  getJob(id: string): Promise<Job | null>
  /** Raw rows, newest first; the caller's `limit` is passed straight through to the store. */
  listJobs(filter?: { state?: JobState; limit?: number }): Promise<Job[]>
  /** Raw rows, newest first; an unknown `status` returns an empty array instead of an error. */
  listActions(filter?: { status?: string; limit?: number }): Promise<PendingAction[]>
}

/**
 * The arguments of the three query functions in this file, and nothing more than the store they read
 * through. It exists so a caller binds one store once and passes the same object to `getJob`,
 * `listJobs` and `listActions`. The 100 default and the 1..500 bound are module constants here, not
 * part of the deps; `src/composition/api.ts` builds it, `src/jobs-queries.test.ts` passes a fake.
 */
export type QueryDeps = {
  /** The only dependency; production wraps `src/db/store.ts`, tests pass an in-memory fake. */
  store: QueryStore
}

/**
 * A job as the API returns it: dates as ISO strings and no tracker source id.
 * `src/api/contract.ts` asserts this shape against `jobResponseSchema` at compile time.
 */
export type JobSummary = {
  /** Job UUID, the primary key; the routes take it as the `:id` path parameter. */
  id: string
  /** Tracker ticketKey as people see it, for example `TST-1`; dedupe uses source plus source id, not this. */
  ticketKey: string
  /** Tracker name, for example `linear`; intake dedupes on source plus source id, which this shape omits. */
  source: string
  /** One of the twelve job states; `allowedActions` is derived from it. */
  state: JobState
  /** Attempts started: 0 before the first `claiming`, +1 on each `claiming`, reset to 0 by a manual retry. */
  attempt: number
  /** Ceiling for `attempt`, set from `MAX_ATTEMPTS` (default 3) when the job row is created. */
  maxAttempts: number
  /** Slot number (0..`SLOT_COUNT`-1) and its database while held; null when the job holds no slot. */
  slot: number | null
  /** ISO time when a delayed retry becomes eligible; null when no retry is scheduled. */
  nextRunAt: string | null
  /** `infra`, `agent` or `setup`, set when the job enters `failed` or falls back to `queued`; else null. */
  failureKind: FailureKind | null
  /** From `allowedActionsFor(state)`, so a client never shows a button the command would refuse. */
  allowedActions: JobAction[]
}

/** A pending action as the API returns it: dates as ISO strings, `payload` left as untyped JSON. */
export type ActionSummary = {
  /** Action UUID; approve and reject take it as the `:id` path parameter. */
  id: string
  /** UUID of the job that drafted this write; no route filters actions by it. */
  jobId: string
  /** Free text naming the write, for example `comment` or `close_pr`; no CHECK and nothing reads it yet. */
  kind: string
  /** JSON for the write, shaped by `kind`, for example `{ body: 'hi' }` for a comment; stored as untyped jsonb. */
  payload: unknown
  /** `pending` until decided, then `approved` or `rejected`; no code writes `done` or `failed` yet. */
  status: ActionStatus
  /** Text given with the decision, for example a decline reason; null while pending and when none was given. */
  reason: string | null
  /** ISO time the action was drafted; no update writes it. */
  createdAt: string
  /** ISO time of the approve or reject; null while the action is still pending. */
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
    ticketKey: job.ticketKey,
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

/** One pending action mapped for the response, whatever its status. */
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
