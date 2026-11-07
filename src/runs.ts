// Pure rules for when a run starts and ends, and how it ended. A run is one execution of a job:
// it starts when the job takes a slot and ends when the job lets go of it.
import { holdsSlot } from './allocate'
import type { JobState, RunOutcome } from './types'

/** A job entering a slot-holding state from one that holds none begins a new run. */
export function startsRun(from: JobState, to: JobState): boolean {
  return !holdsSlot(from) && holdsSlot(to)
}

/** A job leaving the slot-holding states ends the run it had open. */
export function endsRun(from: JobState, to: JobState): boolean {
  return holdsSlot(from) && !holdsSlot(to)
}

/** How a run ended, from the state the job moved to. `null` for a state a run cannot end in. */
export function runOutcomeFor(to: JobState): RunOutcome | null {
  switch (to) {
    case 'done':
      return 'done'
    case 'pr_open':
      return 'pr_open'
    case 'queued':
      return 'retry'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return null
  }
}
