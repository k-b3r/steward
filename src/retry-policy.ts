// Pure retry decisions: exponential backoff and failure-kind routing.
// Clock and randomness are arguments, never read here.

import type { FailureKind } from './types'

export type BackoffOptions = {
  /** Delay before the first retry, in milliseconds; must be >= 0. Production starts at 30 s. */
  baseMs: number
  /** Ceiling on any delay, in milliseconds, applied after jitter; must be >= `baseMs`. Production: 10 min. */
  maxMs: number
  /** Multiplier per attempt. Defaults to 2. */
  factor?: number
  /** Fraction of the delay that may wobble either way, in 0..1. Defaults to 0.2. */
  jitterRatio?: number
}

const DEFAULT_FACTOR = 2
const DEFAULT_JITTER_RATIO = 0.2

export type FailureDecision = { action: 'retry'; nextRunAt: Date } | { action: 'fail' }

type FailureInput = {
  /** Routes the decision: `infra` retries with backoff; `agent` and `setup` fail at once. */
  kind: FailureKind
  /** Attempts made so far, including the one that just failed. */
  attempt: number
  /** Retries stop once `attempt` reaches this. Must be an integer >= 1, and is per job, not global. */
  maxAttempts: number
  /** Clock reading the caller supplies; `nextRunAt` is computed from it. */
  now: Date
  /** Uniform random in [0, 1), supplied by the caller. */
  rand: number
  /** Delays and cap passed on to `backoffDelayMs`; production passes `BACKOFF` from bootstrap. */
  backoff: BackoffOptions
}

function assertBackoffInputs(attempt: number, opts: BackoffOptions, rand: number): void {
  const factor = opts.factor ?? DEFAULT_FACTOR
  const jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO

  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be an integer >= 1, got ${attempt}`)
  }
  if (!(rand >= 0 && rand < 1)) {
    throw new RangeError(`rand must be in [0, 1), got ${rand}`)
  }
  if (opts.baseMs < 0) {
    throw new RangeError(`baseMs must be >= 0, got ${opts.baseMs}`)
  }
  if (opts.maxMs < 0) {
    throw new RangeError(`maxMs must be >= 0, got ${opts.maxMs}`)
  }
  if (opts.maxMs < opts.baseMs) {
    throw new RangeError(`maxMs must be >= baseMs, got maxMs ${opts.maxMs} and baseMs ${opts.baseMs}`)
  }
  if (factor < 1) {
    throw new RangeError(`factor must be >= 1, got ${factor}`)
  }
  if (!(jitterRatio >= 0 && jitterRatio <= 1)) {
    throw new RangeError(`jitterRatio must be in 0..1, got ${jitterRatio}`)
  }
}

/**
 * Delay before the next try, for a failure after `attempt` attempts.
 * `rand` in [0, 1) drives the jitter and is supplied by the caller.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions, rand: number): number {
  assertBackoffInputs(attempt, opts, rand)

  const factor = opts.factor ?? DEFAULT_FACTOR
  const jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO

  const raw = opts.baseMs * factor ** (attempt - 1)
  const capped = Math.min(opts.maxMs, raw)
  const jittered = capped * (1 - jitterRatio + 2 * jitterRatio * rand)
  const clamped = Math.min(opts.maxMs, Math.max(0, jittered))

  return Math.round(clamped)
}

/**
 * What to do after a failure.
 * `infra` backs off and retries, `agent` and `setup` do not.
 */
export function decideAfterFailure(input: FailureInput): FailureDecision {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be an integer >= 1, got ${input.maxAttempts}`)
  }

  switch (input.kind) {
    case 'setup':
      return { action: 'fail' }
    case 'agent':
      // TODO(phase-3): agent failures go to the validation feedback loop, not generic backoff
      return { action: 'fail' }
    case 'infra': {
      if (input.attempt >= input.maxAttempts) {
        return { action: 'fail' }
      }

      const delayMs = backoffDelayMs(input.attempt, input.backoff, input.rand)
      return { action: 'retry', nextRunAt: new Date(input.now.getTime() + delayMs) }
    }
  }
}
