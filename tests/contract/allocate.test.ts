import {
  allocateSlot,
  assertSlotCount,
  findLeakedSlots,
  freeSlots,
  HOLDING_STATES,
  holdsSlot,
} from '../../src/allocate'
import { JOB_STATES } from '../../src/types'

// Neither `allocateSlot` nor `freeSlots` states an order for what it lists, so lists are sorted before comparing.
const ascending = (slots: readonly number[]): number[] => [...slots].sort((a, b) => a - b)

const NON_HOLDING_STATES = JOB_STATES.filter((state) => state !== 'claiming' && state !== 'running')

describe('allocateSlot', () => {
  const freeSlotCases: Array<{ slotCount: number; taken: number[]; expected: number }> = [
    { slotCount: 1, taken: [], expected: 0 },
    { slotCount: 3, taken: [], expected: 0 },
    { slotCount: 3, taken: [0], expected: 1 },
    { slotCount: 3, taken: [0, 1], expected: 2 },
    { slotCount: 3, taken: [1], expected: 0 },
    { slotCount: 4, taken: [0, 2], expected: 1 },
  ]

  it.each(freeSlotCases)(
    'returns the lowest free slot $expected when $slotCount slots exist and $taken are taken',
    ({ slotCount, taken, expected }) => {
      expect(allocateSlot(slotCount, taken)).toBe(expected)
    },
  )

  it('accepts the taken slots as a Set', () => {
    expect(allocateSlot(3, new Set([0, 1]))).toBe(2)
  })

  it('leaves the set of taken slots as it was given', () => {
    const taken = new Set([0, 1])

    allocateSlot(3, taken)

    expect([...taken]).toEqual([0, 1])
  })
})

describe('freeSlots', () => {
  it('lists every slot when none is taken', () => {
    expect(ascending(freeSlots(3, []))).toEqual([0, 1, 2])
  })

  it('lists the slots that are not taken', () => {
    expect(ascending(freeSlots(4, [1, 2]))).toEqual([0, 3])
  })

  it('accepts the taken slots as a Set', () => {
    expect(ascending(freeSlots(4, new Set([1, 2])))).toEqual([0, 3])
  })

  it('leaves the set of taken slots as it was given', () => {
    const taken = new Set([1, 2])

    freeSlots(4, taken)

    expect([...taken]).toEqual([1, 2])
  })
})

describe('HOLDING_STATES', () => {
  it('is claiming and running', () => {
    expect([...HOLDING_STATES].sort()).toEqual(['claiming', 'running'])
  })
})

describe('holdsSlot', () => {
  it.each(['claiming', 'running'] as const)('is true for %s', (state) => {
    expect(holdsSlot(state)).toBe(true)
  })

  it.each(NON_HOLDING_STATES)('is false for %s', (state) => {
    expect(holdsSlot(state)).toBe(false)
  })
})

describe('assertSlotCount', () => {
  it.each([1, 3, 16])('accepts a slot count of %s, which is inside the accepted range 1 to 16', (slotCount) => {
    expect(() => assertSlotCount(slotCount)).not.toThrow()
  })
})

describe('findLeakedSlots', () => {
  it.each(['done', 'merged', 'failed'] as const)('reports a slot held by a job in state %s', (jobState) => {
    expect(findLeakedSlots([{ slot: 1, jobState }])).toEqual([1])
  })

  it.each(['claiming', 'running'] as const)('does not report a slot held by a job in state %s', (jobState) => {
    expect(findLeakedSlots([{ slot: 0, jobState }])).toEqual([])
  })

  it('reports only the leaked slots out of a mixed list', () => {
    const leaked = findLeakedSlots([
      { slot: 0, jobState: 'running' },
      { slot: 1, jobState: 'done' },
      { slot: 2, jobState: 'claiming' },
      { slot: 3, jobState: 'failed' },
    ])

    expect(ascending(leaked)).toEqual([1, 3])
  })
})
