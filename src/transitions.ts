// Job state machine. Pure decision code: no clock, randomness, fetch or process.
import type { JobState } from './types'

/**
 * The only legal moves between job states. Every state is a key, so a missing or
 * extra state is a type error. Self-transitions are never legal.
 */
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  proposed: ['queued', 'declined'],
  declined: ['proposed'],
  queued: ['claiming', 'cancelled', 'failed'],
  // claiming/running -> queued is the automatic infra retry (backoff); `failed` means retries are exhausted.
  claiming: ['running', 'queued', 'failed', 'cancelled'],
  // TODO(phase-4): remove running -> done. It exists only for the phase-1 echo worker stub.
  running: ['pr_open', 'done', 'queued', 'failed', 'cancelled'],
  pr_open: ['in_review', 'failed', 'cancelled'],
  in_review: ['changes_requested', 'merged', 'failed', 'cancelled'],
  changes_requested: ['in_review', 'running', 'failed', 'cancelled'],
  merged: ['done'],
  done: [],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued'],
}

/** Thrown when a job is asked to move along an edge the state machine does not allow. */
export class IllegalTransitionError extends Error {
  constructor(from: JobState, to: JobState) {
    super(`Illegal job state transition: ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/**
 * Reports whether a job may move from `from` to `to`.
 *
 * @returns `true` only for an edge in the state machine; `false` for every other
 *   pair, including a self-transition.
 */
export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Asserts that a job may move from `from` to `to`.
 *
 * @throws {IllegalTransitionError} when the pair is not a legal edge. The message
 *   names both states.
 */
export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to)
  }
}

/**
 * Lists the states a job may move to from `from`, in the order the state machine
 * declares them. Terminal states (`done`) return an empty list.
 */
export function legalNext(from: JobState): readonly JobState[] {
  return TRANSITIONS[from]
}
