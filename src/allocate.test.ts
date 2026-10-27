import { describe, expect, it } from 'vitest'

import { HOLDING_STATES, allocateSlot, assertSlotCount, findLeakedSlots, freeSlots, holdsSlot } from './allocate'
import { JOB_STATES, type JobState } from './types'

describe('assertSlotCount', () => {
  it('accepts the whole allowed range', () => {
    expect(() => assertSlotCount(1)).not.toThrow()
    expect(() => assertSlotCount(16)).not.toThrow()
    expect(() => assertSlotCount(7)).not.toThrow()
  })

  it('rejects 0, negative numbers and anything above 16', () => {
    expect(() => assertSlotCount(0)).toThrow(RangeError)
    expect(() => assertSlotCount(-1)).toThrow(RangeError)
    expect(() => assertSlotCount(17)).toThrow(RangeError)
  })

  it('rejects non-integers', () => {
    expect(() => assertSlotCount(1.5)).toThrow(RangeError)
    expect(() => assertSlotCount(Number.NaN)).toThrow(RangeError)
  })
})

describe('allocateSlot', () => {
  it('returns slot 0 when nothing is taken', () => {
    expect(allocateSlot(4, [])).toBe(0)
  })

  it('returns the lowest free slot when there are gaps', () => {
    expect(allocateSlot(5, [0, 1, 3])).toBe(2)
    expect(allocateSlot(5, [1, 2, 3])).toBe(0)
  })

  it('reuses a released slot', () => {
    const first = allocateSlot(3, [0, 1])
    expect(first).toBe(2)

    const released = [0, 2]
    expect(allocateSlot(3, released)).toBe(1)
  })

  it('returns null when every slot is taken', () => {
    expect(allocateSlot(2, [0, 1])).toBeNull()
  })

  it('ignores taken values outside the slot range', () => {
    expect(allocateSlot(2, [-1, 2, 99])).toBe(0)
    expect(allocateSlot(2, [-5, 0, 1, 7])).toBeNull()
  })

  it('tolerates duplicate taken values', () => {
    expect(allocateSlot(4, [0, 0, 1, 1])).toBe(2)
  })

  it('works with a single slot', () => {
    expect(allocateSlot(1, [])).toBe(0)
    expect(allocateSlot(1, [0])).toBeNull()
  })

  it('rejects invalid slot counts', () => {
    expect(() => allocateSlot(0, [])).toThrow(RangeError)
    expect(() => allocateSlot(17, [])).toThrow(RangeError)
    expect(() => allocateSlot(1.5, [])).toThrow(RangeError)
  })
})

describe('freeSlots', () => {
  it('lists every slot when nothing is taken', () => {
    expect(freeSlots(3, [])).toEqual([0, 1, 2])
  })

  it('lists only the untaken slots in ascending order', () => {
    expect(freeSlots(5, [3, 0])).toEqual([1, 2, 4])
  })

  it('ignores out-of-range and duplicate taken values', () => {
    expect(freeSlots(2, [-1, 0, 0, 9])).toEqual([1])
  })

  it('returns an empty list when full', () => {
    expect(freeSlots(2, [0, 1])).toEqual([])
  })

  it('rejects invalid slot counts', () => {
    expect(() => freeSlots(0, [])).toThrow(RangeError)
    expect(() => freeSlots(17, [])).toThrow(RangeError)
  })
})

describe('HOLDING_STATES', () => {
  it('is exactly claiming and running', () => {
    expect([...HOLDING_STATES]).toEqual(['claiming', 'running'])
  })
})

describe('holdsSlot', () => {
  it('is true only for claiming and running', () => {
    const holding: JobState[] = ['claiming', 'running']
    for (const state of JOB_STATES) {
      expect(holdsSlot(state)).toBe(holding.includes(state))
    }
  })

  it('returns false for the other ten states', () => {
    const others = JOB_STATES.filter((state) => state !== 'claiming' && state !== 'running')
    expect(others).toHaveLength(10)
    for (const state of others) {
      expect(holdsSlot(state)).toBe(false)
    }
  })
})

describe('findLeakedSlots', () => {
  it('returns nothing for empty input', () => {
    expect(findLeakedSlots([])).toEqual([])
  })

  it('treats a slot whose job is missing as leaked', () => {
    expect(findLeakedSlots([{ slot: 2, jobState: null }])).toEqual([2])
  })

  it.each<JobState>(['queued', 'failed', 'done', 'pr_open', 'in_review', 'proposed', 'declined'])(
    'treats a slot held by a %s job as leaked',
    (state) => {
      expect(findLeakedSlots([{ slot: 1, jobState: state }])).toEqual([1])
    },
  )

  it('keeps slots held by running and claiming jobs', () => {
    expect(
      findLeakedSlots([
        { slot: 0, jobState: 'running' },
        { slot: 1, jobState: 'claiming' },
      ]),
    ).toEqual([])
  })

  it('returns only the leaked slots in ascending order', () => {
    expect(
      findLeakedSlots([
        { slot: 3, jobState: 'done' },
        { slot: 0, jobState: 'running' },
        { slot: 2, jobState: null },
        { slot: 1, jobState: 'pr_open' },
      ]),
    ).toEqual([1, 2, 3])
  })

  it('does not repeat a slot seen more than once', () => {
    expect(
      findLeakedSlots([
        { slot: 4, jobState: null },
        { slot: 4, jobState: 'failed' },
        { slot: 4, jobState: null },
      ]),
    ).toEqual([4])
  })
})
