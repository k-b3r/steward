import { assertTransition, canTransition, legalNext } from '../../src/transitions'
import { JOB_STATES, type JobState } from '../../src/types'

type Edge = { from: JobState; to: JobState }

// The happy chain, edge by edge. Source: docs/architecture.md, "Job states and transitions".
const HAPPY_CHAIN: Edge[] = [
  { from: 'proposed', to: 'queued' },
  { from: 'queued', to: 'claiming' },
  { from: 'claiming', to: 'running' },
  { from: 'running', to: 'done' },
]

// What a person can do with a proposal. Source: docs/project-brief.md, "Job lifecycle" and "Intake (Linear)".
const PROPOSAL_MOVES: Array<Edge & { move: string }> = [
  { move: 'confirm', from: 'proposed', to: 'queued' },
  { move: 'decline', from: 'proposed', to: 'declined' },
  { move: 'reconsider', from: 'declined', to: 'proposed' },
]

// `legalNext` promises "the order the state machine declares them", an order no document shows, so lists are
// compared as sets.
const asSet = (states: readonly JobState[]): JobState[] => [...states].sort()

describe('canTransition', () => {
  it.each(HAPPY_CHAIN)('allows $from -> $to on the happy chain', ({ from, to }) => {
    expect(canTransition(from, to)).toBe(true)
  })

  it.each(PROPOSAL_MOVES)('allows the $move move ($from -> $to)', ({ from, to }) => {
    expect(canTransition(from, to)).toBe(true)
  })
})

describe('assertTransition', () => {
  it.each(HAPPY_CHAIN)('accepts $from -> $to on the happy chain', ({ from, to }) => {
    expect(() => assertTransition(from, to)).not.toThrow()
  })

  it.each(PROPOSAL_MOVES)('accepts the $move move ($from -> $to)', ({ from, to }) => {
    expect(() => assertTransition(from, to)).not.toThrow()
  })
})

describe('legalNext', () => {
  it('lists queued and declined after a proposal', () => {
    expect(asSet(legalNext('proposed'))).toEqual(['declined', 'queued'])
  })

  it('lists only proposed after a declined proposal', () => {
    expect(legalNext('declined')).toEqual(['proposed'])
  })

  it.each(HAPPY_CHAIN)('includes $to after $from', ({ from, to }) => {
    expect(legalNext(from)).toContain(to)
  })

  it('agrees with canTransition for every pair of states', () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        expect(legalNext(from).includes(to), `${from} -> ${to}`).toBe(canTransition(from, to))
      }
    }
  })
})
