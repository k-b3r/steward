// Pure slot allocation. No clock, no randomness, no I/O: callers pass in the
// slot count and the currently taken slots.

import type { JobState } from './types'

const MIN_SLOTS = 1
const MAX_SLOTS = 16

// A job holds a slot only while claiming or running. Waiting for review does
// not hold one: this deliberately differs from the first brief so that open
// pull requests do not starve the slots.
export const HOLDING_STATES = ['claiming', 'running'] as const satisfies readonly JobState[]

export function assertSlotCount(n: number): void {
  if (!Number.isInteger(n) || n < MIN_SLOTS || n > MAX_SLOTS) {
    throw new RangeError(`slotCount must be an integer in ${MIN_SLOTS}..${MAX_SLOTS}, got ${String(n)}`)
  }
}

function validTaken(slotCount: number, taken: Iterable<number>): Set<number> {
  const set = new Set<number>()
  for (const slot of taken) {
    if (Number.isInteger(slot) && slot >= 0 && slot < slotCount) {
      set.add(slot)
    }
  }
  return set
}

export function allocateSlot(slotCount: number, taken: Iterable<number>): number | null {
  assertSlotCount(slotCount)
  const used = validTaken(slotCount, taken)
  for (let slot = 0; slot < slotCount; slot += 1) {
    if (!used.has(slot)) {
      return slot
    }
  }
  return null
}

export function freeSlots(slotCount: number, taken: Iterable<number>): number[] {
  assertSlotCount(slotCount)
  const used = validTaken(slotCount, taken)
  const free: number[] = []
  for (let slot = 0; slot < slotCount; slot += 1) {
    if (!used.has(slot)) {
      free.push(slot)
    }
  }
  return free
}

export function holdsSlot(state: JobState): boolean {
  return HOLDING_STATES.some((holding) => holding === state)
}

export function findLeakedSlots(held: ReadonlyArray<{ slot: number; jobState: JobState | null }>): number[] {
  const leaked = new Set<number>()
  for (const row of held) {
    if (row.jobState === null || !holdsSlot(row.jobState)) {
      leaked.add(row.slot)
    }
  }
  return [...leaked].sort((a, b) => a - b)
}
