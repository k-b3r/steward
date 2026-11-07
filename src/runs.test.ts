// A run is one execution of a job. It starts when the job takes a slot and ends when it lets go.
import { describe, expect, it } from 'vitest'

import { holdsSlot } from './allocate'
import { endsRun, runOutcomeFor, startsRun } from './runs'
import { legalNext } from './transitions'
import { JOB_STATES, type JobState } from './types'

const LEGAL_EDGES = JOB_STATES.flatMap((from) => legalNext(from).map((to): [JobState, JobState] => [from, to]))

describe('startsRun', () => {
  it('starts on a fresh claim', () => {
    expect(startsRun('queued', 'claiming')).toBe(true)
  })

  it('starts when a waiting job is resumed straight into running', () => {
    expect(startsRun('ci_failed', 'running')).toBe(true)
    expect(startsRun('changes_requested', 'running')).toBe(true)
  })

  it('does not start when the job was already running its run: claiming -> running', () => {
    expect(startsRun('claiming', 'running')).toBe(false)
  })

  it('starts on exactly these legal edges and no others', () => {
    const starting = LEGAL_EDGES.filter(([from, to]) => startsRun(from, to)).map(([from, to]) => `${from}->${to}`)
    expect(starting.sort()).toEqual(['changes_requested->running', 'ci_failed->running', 'queued->claiming'])
  })
})

describe('endsRun', () => {
  it('ends when a job that held a slot lets go of it', () => {
    expect(endsRun('running', 'done')).toBe(true)
    expect(endsRun('claiming', 'queued')).toBe(true)
    expect(endsRun('running', 'pr_open')).toBe(true)
  })

  it('does not end while the slot is still held', () => {
    expect(endsRun('claiming', 'running')).toBe(false)
  })

  it('does not end for a job that held no slot, such as a retry from failed', () => {
    expect(endsRun('failed', 'queued')).toBe(false)
    expect(endsRun('queued', 'cancelled')).toBe(false)
  })

  it('agrees with the slot rule on every legal edge', () => {
    for (const [from, to] of LEGAL_EDGES) {
      expect(endsRun(from, to), `${from} -> ${to}`).toBe(holdsSlot(from) && !holdsSlot(to))
      expect(startsRun(from, to), `${from} -> ${to}`).toBe(!holdsSlot(from) && holdsSlot(to))
    }
  })
})

describe('runOutcomeFor', () => {
  it('names how the run ended by where the job went next', () => {
    expect(runOutcomeFor('done')).toBe('done')
    expect(runOutcomeFor('pr_open')).toBe('pr_open')
    expect(runOutcomeFor('queued')).toBe('retry')
    expect(runOutcomeFor('failed')).toBe('failed')
    expect(runOutcomeFor('cancelled')).toBe('cancelled')
  })

  it('has no outcome for a state a run cannot end in', () => {
    expect(runOutcomeFor('running')).toBeNull()
    expect(runOutcomeFor('merged')).toBeNull()
  })

  it('covers every legal way out of a slot-holding state, so no run is left open', () => {
    for (const [from, to] of LEGAL_EDGES) {
      if (endsRun(from, to)) expect(runOutcomeFor(to), `${from} -> ${to}`).not.toBeNull()
    }
  })
})
