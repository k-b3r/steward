// What a person asks the system to do with a job. Every rule about which moves are allowed
// lives here, not in the HTTP layer: a route validates its input, calls one function, and
// turns the errors below into status codes.
import type { PendingAction } from './db/store'
import { canTransition, IllegalTransitionError } from './transitions'
import type { FailureKind, Job, JobState } from './types'

export type CommandStore = {
  getJob(id: string): Promise<Job | null>
  getAction(id: string): Promise<PendingAction | null>
  transitionJob(
    id: string,
    to: JobState,
    opts: { now: Date; reason?: string; failureKind?: FailureKind; nextRunAt?: Date | null },
  ): Promise<Job>
  decideAction(
    id: string,
    decision: 'approved' | 'rejected',
    opts: { now: Date; reason?: string },
  ): Promise<PendingAction>
}

export type CommandDeps = {
  store: CommandStore
  clock: () => Date
  enqueue: (jobId: string) => Promise<void>
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

const CONFIRMABLE: readonly JobState[] = ['proposed']
const DECLINABLE: readonly JobState[] = ['proposed']
const RECONSIDERABLE: readonly JobState[] = ['declined']
const RETRYABLE: readonly JobState[] = ['failed', 'cancelled']
const CANCELLABLE: readonly JobState[] = ['queued', 'claiming', 'running', 'pr_open', 'in_review', 'changes_requested']

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
