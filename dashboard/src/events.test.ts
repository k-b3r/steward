import { describe, expect, it } from 'vitest'

import type { JobEventResponse } from '../../src/api/contract'
import { eventRows, eventText } from './events'

const NOW = Date.parse('2026-01-02T12:00:00.000Z')
const at = (seconds: number): string => new Date(NOW + seconds * 1000).toISOString()

function event(overrides: Partial<JobEventResponse> = {}): JobEventResponse {
  return { from: null, to: 'proposed', failureKind: null, reason: null, at: at(-60), ...overrides }
}

describe('eventText', () => {
  it('names a creation by its to-state, since there is no from-state', () => {
    expect(eventText(event())).toBe('created as Proposed')
  })

  it('shows a move by the labels a person reads', () => {
    expect(eventText(event({ from: 'proposed', to: 'queued' }))).toBe('Proposed -> Queued')
    expect(eventText(event({ from: 'pr_open', to: 'ci_failed' }))).toBe('PR open -> CI failed')
  })

  it('adds the reason when there is one, and never an empty pair of brackets', () => {
    expect(eventText(event({ from: 'proposed', to: 'queued', reason: 'confirmed' }))).toBe(
      'Proposed -> Queued (from confirmed)',
    )
    expect(eventText(event({ from: 'proposed', to: 'queued', reason: '' }))).toBe('Proposed -> Queued')
  })

  it('marks the failure kind before the reason, which is the long part', () => {
    expect(
      eventText(event({ from: 'claiming', to: 'queued', failureKind: 'infra', reason: 'worker lost on restart' })),
    ).toBe('Claiming -> Queued (failure: infra) (from worker lost on restart)')
    expect(eventText(event({ from: 'claiming', to: 'failed', failureKind: 'setup' }))).toBe(
      'Claiming -> Failed (failure: setup)',
    )
  })
})

describe('eventRows', () => {
  it('keeps server order, formats the age and flags failures', () => {
    const rows = eventRows(
      [
        event({ at: at(-120) }),
        event({ from: 'queued', to: 'claiming', at: at(-30) }),
        event({ from: 'claiming', to: 'failed', failureKind: 'setup', at: at(-1) }),
      ],
      NOW,
    )

    expect(rows.map((row) => row.text)).toEqual([
      'created as Proposed',
      'Queued -> Claiming',
      'Claiming -> Failed (failure: setup)',
    ])
    expect(rows.map((row) => row.at)).toEqual(['2m ago', '30s ago', '1s ago'])
    expect(rows.map((row) => row.failure)).toEqual([false, false, true])
    expect(rows.map((row) => row.key)).toEqual([`0-${at(-120)}`, `1-${at(-30)}`, `2-${at(-1)}`])
  })

  it('has nothing to show for an empty log', () => {
    expect(eventRows([], NOW)).toEqual([])
  })
})
