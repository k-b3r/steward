import { describe, expect, it } from 'vitest'

import { backoffDelayMs, decideAfterFailure, type BackoffOptions } from './retry-policy.js'

const noJitter: BackoffOptions = { baseMs: 100, maxMs: 10_000, jitterRatio: 0 }
const jitter: BackoffOptions = { baseMs: 100, maxMs: 10_000, jitterRatio: 0.2 }

const now = new Date('2026-01-01T00:00:00.000Z')

describe('backoffDelayMs', () => {
  it('grows exponentially without jitter', () => {
    expect(backoffDelayMs(1, noJitter, 0)).toBe(100)
    expect(backoffDelayMs(2, noJitter, 0)).toBe(200)
    expect(backoffDelayMs(3, noJitter, 0)).toBe(400)
    expect(backoffDelayMs(4, noJitter, 0)).toBe(800)
    // rand is ignored when jitterRatio is 0.
    expect(backoffDelayMs(4, noJitter, 0.99)).toBe(800)
  })

  it('caps the delay at maxMs', () => {
    expect(backoffDelayMs(20, noJitter, 0)).toBe(10_000)
    expect(backoffDelayMs(20, { baseMs: 1000, maxMs: 2500, jitterRatio: 0 }, 0)).toBe(2500)
  })

  it('uses the default factor of 2', () => {
    expect(backoffDelayMs(3, { baseMs: 50, maxMs: 10_000, jitterRatio: 0 }, 0)).toBe(200)
  })

  it('applies a custom factor', () => {
    const opts: BackoffOptions = {
      baseMs: 100,
      maxMs: 10_000,
      factor: 3,
      jitterRatio: 0,
    }
    expect(backoffDelayMs(1, opts, 0)).toBe(100)
    expect(backoffDelayMs(2, opts, 0)).toBe(300)
    expect(backoffDelayMs(3, opts, 0)).toBe(900)
  })

  it('stays within the jitter bounds at rand 0', () => {
    // 400 * (1 - 0.2 + 0) = 320
    expect(backoffDelayMs(3, jitter, 0)).toBe(320)
  })

  it('stays within the jitter bounds at rand just below 1', () => {
    // 400 * (1 - 0.2 + 2 * 0.2 * 0.999999) = 479.99984 -> 480
    expect(backoffDelayMs(3, jitter, 0.999999)).toBe(480)
    expect(backoffDelayMs(3, jitter, 0.5)).toBe(400)
  })

  it('rounds to an integer', () => {
    expect(Number.isInteger(backoffDelayMs(3, jitter, 0.333))).toBe(true)
    expect(backoffDelayMs(1, { baseMs: 33, maxMs: 1000, jitterRatio: 0 }, 0)).toBe(33)
    expect(backoffDelayMs(2, { baseMs: 33, maxMs: 1000, jitterRatio: 0 }, 0)).toBe(66)
  })

  it('clamps a jittered result to maxMs', () => {
    // base * factor^(attempt - 1) is already at the cap, so jitter cannot exceed it.
    expect(backoffDelayMs(10, { baseMs: 1000, maxMs: 1000 }, 0.999999)).toBe(1000)
  })

  it('rejects attempt below 1', () => {
    expect(() => backoffDelayMs(0, noJitter, 0)).toThrow(RangeError)
    expect(() => backoffDelayMs(-1, noJitter, 0)).toThrow(RangeError)
  })

  it('rejects rand outside [0, 1)', () => {
    expect(() => backoffDelayMs(1, noJitter, -0.1)).toThrow(RangeError)
    expect(() => backoffDelayMs(1, noJitter, 1)).toThrow(RangeError)
    expect(() => backoffDelayMs(1, noJitter, 1.5)).toThrow(RangeError)
  })

  it('rejects negative or inverted bounds', () => {
    expect(() => backoffDelayMs(1, { baseMs: -1, maxMs: 100 }, 0)).toThrow(RangeError)
    expect(() => backoffDelayMs(1, { baseMs: 100, maxMs: -1 }, 0)).toThrow(RangeError)
    expect(() => backoffDelayMs(1, { baseMs: 500, maxMs: 100 }, 0)).toThrow(RangeError)
  })

  it('rejects a jitterRatio outside 0..1', () => {
    expect(() => backoffDelayMs(1, { baseMs: 100, maxMs: 1000, jitterRatio: -0.1 }, 0)).toThrow(RangeError)
    expect(() => backoffDelayMs(1, { baseMs: 100, maxMs: 1000, jitterRatio: 1.1 }, 0)).toThrow(RangeError)
  })
})

describe('decideAfterFailure', () => {
  it('never retries setup failures', () => {
    expect(
      decideAfterFailure({
        kind: 'setup',
        attempt: 1,
        maxAttempts: 3,
        now,
        rand: 0,
        backoff: noJitter,
      }),
    ).toEqual({ action: 'fail' })
  })

  it('fails agent failures', () => {
    expect(
      decideAfterFailure({
        kind: 'agent',
        attempt: 1,
        maxAttempts: 3,
        now,
        rand: 0,
        backoff: noJitter,
      }),
    ).toEqual({ action: 'fail' })
  })

  it('retries infra failures below maxAttempts and fails at the limit', () => {
    const base = {
      kind: 'infra' as const,
      maxAttempts: 3,
      now,
      rand: 0,
      backoff: noJitter,
    }
    expect(decideAfterFailure({ ...base, attempt: 1 })).toEqual({
      action: 'retry',
      nextRunAt: new Date(now.getTime() + 100),
    })
    expect(decideAfterFailure({ ...base, attempt: 2 })).toEqual({
      action: 'retry',
      nextRunAt: new Date(now.getTime() + 200),
    })
    expect(decideAfterFailure({ ...base, attempt: 3 })).toEqual({
      action: 'fail',
    })
  })

  it('sets nextRunAt to now plus the computed delay', () => {
    const decision = decideAfterFailure({
      kind: 'infra',
      attempt: 3,
      maxAttempts: 5,
      now,
      rand: 0.5,
      backoff: jitter,
    })
    expect(decision).toEqual({
      action: 'retry',
      nextRunAt: new Date(now.getTime() + backoffDelayMs(3, jitter, 0.5)),
    })
  })

  it('fails immediately when maxAttempts is 1', () => {
    expect(
      decideAfterFailure({
        kind: 'infra',
        attempt: 1,
        maxAttempts: 1,
        now,
        rand: 0,
        backoff: noJitter,
      }),
    ).toEqual({ action: 'fail' })
  })

  it('does not mutate the input now', () => {
    const input = new Date('2026-02-03T04:05:06.007Z')
    const before = input.getTime()
    decideAfterFailure({
      kind: 'infra',
      attempt: 1,
      maxAttempts: 3,
      now: input,
      rand: 0,
      backoff: noJitter,
    })
    expect(input.getTime()).toBe(before)
    expect(input.toISOString()).toBe('2026-02-03T04:05:06.007Z')
  })

  it('rejects maxAttempts below 1', () => {
    expect(() =>
      decideAfterFailure({
        kind: 'infra',
        attempt: 1,
        maxAttempts: 0,
        now,
        rand: 0,
        backoff: noJitter,
      }),
    ).toThrow(RangeError)
  })
})
