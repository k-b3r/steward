import { describe, expect, it } from 'vitest'

import type { RunResponse } from './api'
import { runLabel, runRow } from './runs'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')
const at = (seconds: number): string => new Date(NOW + seconds * 1000).toISOString()

const run = (over: Partial<RunResponse> = {}): RunResponse => ({
  number: 1,
  slot: 2,
  startedAt: at(-5 * 60),
  endedAt: at(-60),
  outcome: 'done',
  failureKind: null,
  ...over,
})

describe('runLabel', () => {
  it('calls a run that has not ended yet running, matching its colour', () => {
    expect(runLabel(run({ outcome: null, endedAt: null }))).toBe('Running')
  })

  it('names each outcome a person can read', () => {
    expect(runLabel(run({ outcome: 'done' }))).toBe('Done')
    expect(runLabel(run({ outcome: 'pr_open' }))).toBe('PR open')
    expect(runLabel(run({ outcome: 'retry' }))).toBe('Retry')
    expect(runLabel(run({ outcome: 'failed' }))).toBe('Failed')
    expect(runLabel(run({ outcome: 'cancelled' }))).toBe('Cancelled')
  })

  it('adds the failure kind in brackets when the run has one', () => {
    expect(runLabel(run({ outcome: 'failed', failureKind: 'infra' }))).toBe('Failed (infra)')
  })
})

describe('runRow', () => {
  it('turns a finished run into plain row data', () => {
    expect(runRow(run({ number: 3 }), NOW)).toEqual({
      number: 3,
      label: 'Done',
      failureKind: null,
      started: '5m ago',
      ended: '1m ago',
      slot: '2',
    })
  })

  it('carries the failure kind through to the row', () => {
    const row = runRow(run({ outcome: 'failed', failureKind: 'infra' }), NOW)

    expect(row.label).toBe('Failed (infra)')
    expect(row.failureKind).toBe('infra')
  })

  it('shows a dash when the run has no slot and no end', () => {
    const row = runRow(run({ outcome: null, slot: null, endedAt: null }), NOW)

    expect(row.ended).toBe('—')
    expect(row.slot).toBe('—')
  })
})
