// What a person asks the system to do with a job. Every rule about which moves are allowed
// lives here, not in the HTTP layer: a route validates its input, calls one function, and
// turns the errors below into status codes.
import type { PendingAction } from './types'
import { canTransition, IllegalTransitionError } from './transitions'
import type { FailureKind, Job, JobState } from './types'

export type CommandStore = {
  /** Raw job row, or null when the id is unknown; each command turns null into `JobNotFoundError`. */
  getJob(id: string): Promise<Job | null>
  /** Raw action row, or null; `decideAction` turns null into `ActionNotFoundError`. */
  getAction(id: string): Promise<PendingAction | null>
  /** Moves the job and appends a job event in one transaction; `now` comes from `deps.clock`, never here. */
  transitionJob(
    id: string,
    to: JobState,
    opts: { now: Date; reason?: string; failureKind?: FailureKind; nextRunAt?: Date | null },
  ): Promise<Job>
  /** Updates status, reason and decidedAt only while the row is still `pending`; otherwise it throws. */
  decideAction(
    id: string,
    decision: 'approved' | 'rejected',
    opts: { now: Date; reason?: string },
  ): Promise<PendingAction>
}

export type CommandDeps = {
  /** Production is `src/db/store.ts` via `src/composition/api.ts`; tests pass an in-memory fake. */
  store: CommandStore
  /** Every timestamp comes from here; production is `ctx.clock`, tests return a fixed date. */
  clock: () => Date
  /** Puts the job id on the BullMQ queue with no delay; `confirm` and `retry` call it after the row is `queued`. */
  enqueue: (jobId: string) => Promise<void>
  /** Stops a run that may still be working; production is `runner.cancel`, called before the row changes. */
  cancelRun: (jobId: string) => Promise<void>
}

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Unknown job: ${jobId}`)
    this.name = 'JobNotFoundError'
  }
}

export class ActionNotFoundError extends Error {
  constructor(actionId: string) {
    super(`Unknown pending action: ${actionId}`)
    this.name = 'ActionNotFoundError'
  }
}

export class ActionNotPendingError extends Error {
  constructor(status: string) {
    super(`Pending action is ${status}, not pending`)
    this.name = 'ActionNotPendingError'
  }
}

async function load(deps: CommandDeps, id: string): Promise<Job> {
  const job = await deps.store.getJob(id)
  if (job === null) {
    throw new JobNotFoundError(id)
  }
  return job
}

/**
 * The state machine allows some edges for the orchestrator's own reasons (claiming and running
 * go back to `queued` for an automatic retry). A command must name the states it accepts, never
 * rely on "some legal path exists", or a confirm could restart a running job.
 */
function requireFrom(job: Job, to: JobState, allowed: readonly JobState[]): void {
  if (!allowed.includes(job.state) || !canTransition(job.state, to)) {
    throw new IllegalTransitionError(job.state, to)
  }
}

/** Every intent a person can ask for, named for the API. */
export type JobAction = 'confirm' | 'decline' | 'reconsider' | 'retry' | 'cancel'

const CONFIRMABLE: readonly JobState[] = ['proposed']
const DECLINABLE: readonly JobState[] = ['proposed']
const RECONSIDERABLE: readonly JobState[] = ['declined']
const RETRYABLE: readonly JobState[] = ['failed', 'cancelled']
const CANCELLABLE: readonly JobState[] = ['queued', 'claiming', 'running', 'pr_open', 'in_review', 'changes_requested']

/**
 * The intents available in a given state. Read models expose this so a client never offers a
 * button the command would reject, and the rules live in one place.
 */
export function allowedActionsFor(state: JobState): JobAction[] {
  const actions: JobAction[] = []
  if (CONFIRMABLE.includes(state)) actions.push('confirm', 'decline')
  if (RECONSIDERABLE.includes(state)) actions.push('reconsider')
  if (RETRYABLE.includes(state)) actions.push('retry')
  if (CANCELLABLE.includes(state)) actions.push('cancel')
  return actions
}

/** A confirmed proposal becomes a queued job and is delivered to the queue. */
export async function confirmJob(deps: CommandDeps, id: string): Promise<Job> {
  const job = await load(deps, id)
  requireFrom(job, 'queued', CONFIRMABLE)
  const updated = await deps.store.transitionJob(id, 'queued', { now: deps.clock(), reason: 'confirmed' })
  await deps.enqueue(id)
  return updated
}

/** A declined proposal is parked with the reason; nothing is queued. */
export async function declineJob(deps: CommandDeps, id: string, reason: string): Promise<Job> {
  const trimmed = reason.trim()
  if (trimmed === '') {
    throw new Error('A decline needs a reason')
  }
  const job = await load(deps, id)
  requireFrom(job, 'declined', DECLINABLE)
  return deps.store.transitionJob(id, 'declined', { now: deps.clock(), reason: trimmed })
}

/** Reopens a declined proposal so it can be decided again. */
export async function reconsiderJob(deps: CommandDeps, id: string): Promise<Job> {
  const job = await load(deps, id)
  requireFrom(job, 'proposed', RECONSIDERABLE)
  return deps.store.transitionJob(id, 'proposed', { now: deps.clock(), reason: 'reconsidered' })
}

/** A manual retry of a job that stopped: the row is reused, the attempt counter resets in the store. */
export async function retryJob(deps: CommandDeps, id: string): Promise<Job> {
  const job = await load(deps, id)
  requireFrom(job, 'queued', RETRYABLE)
  const updated = await deps.store.transitionJob(id, 'queued', { now: deps.clock(), reason: 'retried by hand' })
  await deps.enqueue(id)
  return updated
}

/** Stops the run first, so an agent still working is told to stop before the row changes. */
export async function cancelJob(deps: CommandDeps, id: string): Promise<Job> {
  const job = await load(deps, id)
  requireFrom(job, 'cancelled', CANCELLABLE)
  await deps.cancelRun(id)
  return deps.store.transitionJob(id, 'cancelled', { now: deps.clock(), reason: 'cancelled by hand' })
}

/** Approve or reject a pending outside write. Only a pending action can be decided, once. */
export async function decideAction(
  deps: CommandDeps,
  id: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<PendingAction> {
  const action = await deps.store.getAction(id)
  if (action === null) {
    throw new ActionNotFoundError(id)
  }
  if (action.status !== 'pending') {
    throw new ActionNotPendingError(action.status)
  }
  return deps.store.decideAction(id, decision, { now: deps.clock(), reason })
}
