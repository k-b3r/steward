// The legal edges, written from the phase plan and independent of the implementation.
import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition, IllegalTransitionError, legalNext } from './transitions'
import { JOB_STATES, type JobState } from './types'

type Edge = readonly [from: JobState, to: JobState]

const LEGAL_EDGES: readonly Edge[] = [
  ['proposed', 'queued'],
  ['proposed', 'declined'],
  ['declined', 'proposed'],
  ['queued', 'claiming'],
  ['queued', 'cancelled'],
  ['queued', 'failed'],
  ['claiming', 'running'],
  ['claiming', 'failed'],
  ['claiming', 'cancelled'],
  ['running', 'pr_open'],
  ['running', 'done'],
  ['running', 'failed'],
  ['running', 'cancelled'],
  ['pr_open', 'in_review'],
  ['pr_open', 'failed'],
  ['pr_open', 'cancelled'],
  ['in_review', 'changes_requested'],
  ['in_review', 'merged'],
  ['in_review', 'failed'],
  ['in_review', 'cancelled'],
  ['changes_requested', 'in_review'],
  ['changes_requested', 'running'],
  ['changes_requested', 'failed'],
  ['changes_requested', 'cancelled'],
  ['merged', 'done'],
  ['failed', 'queued'],
  ['failed', 'cancelled'],
  ['cancelled', 'queued'],
]

const edgeKey = ([from, to]: Edge): string => `${from}->${to}`
const LEGAL_KEYS = new Set(LEGAL_EDGES.map(edgeKey))

const ALL_PAIRS: readonly Edge[] = JOB_STATES.flatMap((from) => JOB_STATES.map((to): Edge => [from, to]))
const ILLEGAL_PAIRS = ALL_PAIRS.filter((edge) => !LEGAL_KEYS.has(edgeKey(edge)))

const tableNext = (from: JobState): readonly JobState[] =>
  LEGAL_EDGES.filter(([source]) => source === from).map(([, target]) => target)

describe('canTransition', () => {
  it.each(LEGAL_EDGES)('allows the legal edge %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true)
  })

  it.each(ILLEGAL_PAIRS)('rejects the illegal edge %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false)
  })

  it('treats every self-transition as illegal', () => {
    for (const state of JOB_STATES) {
      expect(canTransition(state, state)).toBe(false)
    }
  })

  it('allows retrying failed and cancelled jobs back to queued', () => {
    expect(canTransition('failed', 'queued')).toBe(true)
    expect(canTransition('cancelled', 'queued')).toBe(true)
  })

  it('does not allow merged or done jobs back to queued', () => {
    expect(canTransition('merged', 'queued')).toBe(false)
    expect(canTransition('done', 'queued')).toBe(false)
  })
})

describe('assertTransition', () => {
  it('throws IllegalTransitionError on an illegal pair', () => {
    expect(() => assertTransition('proposed', 'running')).toThrow(IllegalTransitionError)
  })

  it('names both states in the error message', () => {
    expect(() => assertTransition('proposed', 'running')).toThrow(/proposed/)
    expect(() => assertTransition('proposed', 'running')).toThrow(/running/)
  })

  it('does not throw on a legal pair', () => {
    expect(() => assertTransition('queued', 'claiming')).not.toThrow()
  })

  it('does not throw on a retry pair', () => {
    expect(() => assertTransition('failed', 'queued')).not.toThrow()
  })
})

describe('legalNext', () => {
  it.each(JOB_STATES)('matches the table for %s', (state) => {
    expect(legalNext(state)).toEqual(tableNext(state))
  })

  it('returns no next states for done', () => {
    expect(legalNext('done')).toEqual([])
  })

  it('returns exactly the terminal and failure targets after merged', () => {
    expect(legalNext('merged')).toEqual(['done'])
  })

  it('returns queued and cancelled after failed', () => {
    expect(legalNext('failed')).toEqual(['queued', 'cancelled'])
  })

  it('returns queued after cancelled', () => {
    expect(legalNext('cancelled')).toEqual(['queued'])
  })

  it('returns only legal targets for every state', () => {
    for (const state of JOB_STATES) {
      for (const target of legalNext(state)) {
        expect(canTransition(state, target)).toBe(true)
      }
    }
  })
})
