import { describe, expect, it } from 'vitest'

import { jobStateSchema } from '../../src/api/contract'
import { FILTERS, LANES, isSpinning, relativeTime, safeTrackerUrl, stateClass } from './model'

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

describe('safeTrackerUrl', () => {
  it('keeps http and https links', () => {
    expect(safeTrackerUrl('https://linear.app/x/TST-1')).toBe('https://linear.app/x/TST-1')
    expect(safeTrackerUrl('http://localhost:3000/TST-1')).toBe('http://localhost:3000/TST-1')
  })

  it('refuses anything else, so a script URL never becomes an href', () => {
    for (const url of ['', 'javascript:alert(1)', 'data:text/html,hi', '//evil.example', 'linear.app/TST-1']) {
      expect(safeTrackerUrl(url), url).toBeNull()
    }
  })
})

describe('stateClass', () => {
  it('borrows a neighbour colour for states the design has none for', () => {
    expect(stateClass('claiming')).toBe('s-running')
    expect(stateClass('proposed')).toBe('s-queued')
    expect(stateClass('declined')).toBe('s-cancelled')
    expect(stateClass('ci_failed')).toBe('s-failed')
  })

  it('uses the state name for every other state', () => {
    for (const state of ALL_STATES) {
      if (state === 'claiming' || state === 'proposed' || state === 'declined' || state === 'ci_failed') continue
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
