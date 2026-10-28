import { describe, expect, it } from 'vitest'

import { jobStateSchema } from '../../src/api/contract'
import { CANCELLABLE, FILTERS, LANES, RETRYABLE, isSpinning, relativeTime, stateClass } from './model'

const ALL_STATES = jobStateSchema.options
const NOW = Date.parse('2026-01-01T12:00:00.000Z')
const at = (seconds: number): string => new Date(NOW + seconds * 1000).toISOString()

describe('relativeTime', () => {
  it('shows a dash for no time', () => {
    expect(relativeTime(null, NOW)).toBe('—')
  })

  it('counts seconds, minutes and hours into the past', () => {
    expect(relativeTime(at(-30), NOW)).toBe('30s ago')
    expect(relativeTime(at(-5 * 60), NOW)).toBe('5m ago')
    expect(relativeTime(at(-2 * 3600), NOW)).toBe('2h ago')
  })

  it('counts into the future for a scheduled retry', () => {
    expect(relativeTime(at(45), NOW)).toBe('in 45s')
    expect(relativeTime(at(10 * 60), NOW)).toBe('in 10m')
  })
})

describe('stateClass', () => {
  it('borrows a neighbour colour for states the design has none for', () => {
    expect(stateClass('claiming')).toBe('s-running')
    expect(stateClass('proposed')).toBe('s-queued')
    expect(stateClass('declined')).toBe('s-cancelled')
  })

  it('uses the state name for every other state', () => {
    for (const state of ALL_STATES) {
      if (state === 'claiming' || state === 'proposed' || state === 'declined') continue
      expect(stateClass(state)).toBe(`s-${state}`)
    }
  })

  it('spins only while work is in flight', () => {
    expect(ALL_STATES.filter((state) => isSpinning(state))).toEqual(['claiming', 'running'])
  })
})

describe('board lanes and filters', () => {
  it('puts every job state in exactly one lane, so no job is hidden', () => {
    const placed = LANES.flatMap((lane) => lane.states)

    expect([...placed].sort()).toEqual([...ALL_STATES].sort())
  })

  it('filters only by states that exist, and "All" means no filter', () => {
    for (const filter of FILTERS) {
      for (const state of filter.states) expect(ALL_STATES).toContain(state)
    }
    expect(FILTERS.find((filter) => filter.name === 'All')?.states).toEqual([])
  })
})

describe('which buttons a state gets', () => {
  it('retries only a job that stopped, as the API allows', () => {
    expect(RETRYABLE).toEqual(['failed', 'cancelled'])
  })

  it('never offers cancel on a job that already ended or was never started', () => {
    for (const ended of ['merged', 'done', 'failed', 'cancelled', 'declined', 'proposed'] as const) {
      expect(CANCELLABLE).not.toContain(ended)
    }
  })
})
