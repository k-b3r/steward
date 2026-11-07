import { describe, expect, it } from 'vitest'

import { ApiError } from './api'
import type { Envelope } from './api'
import { followRunLog, planResume, type LogStreamDeps } from './log-resume'

const envelope = (seq: number): Envelope => ({ seq, ts: '2026-01-02T03:04:05.000Z', kind: 'system', data: { seq } })

type Run = { number: number }
type Call = { after: number; run?: number }
type Attempt = (deliver: (envelope: Envelope) => void) => void

describe('planResume', () => {
  it('keeps the position while the job still has no run', () => {
    expect(planResume({ after: 12 }, undefined)).toEqual({ resume: { after: 12 }, restart: false })
  })

  it('keeps the position when the lookup failed, which is not the same as no runs', () => {
    expect(planResume({ run: 2, after: 30 }, undefined)).toEqual({ resume: { run: 2, after: 30 }, restart: false })
  })

  it('switches to a run that appeared, from its first envelope', () => {
    expect(planResume({ after: 40 }, 1)).toEqual({ resume: { run: 1, after: 0 }, restart: true })
  })

  it('keeps the position on the same run, and starts a different one over', () => {
    expect(planResume({ run: 1, after: 40 }, 1)).toEqual({ resume: { run: 1, after: 40 }, restart: false })
    expect(planResume({ run: 1, after: 40 }, 2)).toEqual({ resume: { run: 2, after: 0 }, restart: true })
  })
})

/**
 * Drives the loop with a script: each entry is one connection attempt, after which the server
 * closes the stream. When the script runs out the signal aborts, which ends the loop.
 */
function driver(script: Attempt[], answers: (() => Promise<Run[]>)[]) {
  const controller = new AbortController()
  const attempts = [...script]
  const remaining = [...answers]
  const calls: Call[] = []
  let restarts = 0

  const deps: LogStreamDeps = {
    follow: async ({ after, run, onEnvelope }) => {
      calls.push({ after, ...(run === undefined ? {} : { run }) })
      attempts.shift()?.(onEnvelope)
      if (attempts.length === 0) controller.abort()
    },
    runs: () => (remaining.length > 1 ? remaining.shift()!() : (remaining[0]?.() ?? Promise.resolve([]))),
    onEnvelope: () => {},
    onRestart: () => {
      restarts += 1
    },
    onStatus: () => {},
    sleep: () => Promise.resolve(),
    signal: controller.signal,
    retryMs: 0,
  }

  return { deps, calls, restarts: () => restarts }
}

describe('followRunLog', () => {
  it('pins the newest run at open', async () => {
    const { deps, calls } = driver([() => {}], [() => Promise.resolve([{ number: 1 }, { number: 2 }])])

    await followRunLog(deps)

    expect(calls).toEqual([{ after: 0, run: 2 }])
  })

  it('reconnects from the newest envelope it delivered, not from the planned position', async () => {
    const { deps, calls } = driver(
      [(deliver) => [1, 2, 3, 4].forEach((seq) => deliver(envelope(seq))), () => {}],
      [() => Promise.resolve([{ number: 1 }])],
    )

    await followRunLog(deps)

    expect(calls).toEqual([
      { after: 0, run: 1 },
      { after: 4, run: 1 },
    ])
  })

  it('learns the run after a refusal, drops the lines and restarts that run from seq 0', async () => {
    const { deps, calls, restarts } = driver(
      [
        (deliver) => deliver(envelope(3)),
        () => {
          throw new ApiError(400, 'invalid request')
        },
        () => {},
      ],
      [() => Promise.resolve([{ number: 1 }]), () => Promise.resolve([{ number: 1 }, { number: 2 }])],
    )

    await followRunLog(deps)

    expect(calls).toEqual([
      { after: 0, run: 1 },
      { after: 3, run: 1 },
      { after: 0, run: 2 },
    ])
    expect(restarts()).toBe(1)
  })

  it('keeps the position when the runs lookup fails, because that is not "no runs"', async () => {
    const offline = (): Promise<Run[]> => Promise.reject(new Error('offline'))
    const { deps, calls, restarts } = driver(
      [
        (deliver) => deliver(envelope(9)),
        () => {
          throw new ApiError(400, 'invalid request')
        },
        () => {},
      ],
      [offline],
    )

    await followRunLog(deps)

    // It keeps retrying from where it was: no run is invented, and the position never resets.
    expect(calls).toEqual([{ after: 0 }, { after: 9 }, { after: 9 }])
    expect(restarts()).toBe(0)
  })

  it('stops when the signal aborts, and does not reconnect after it', async () => {
    const controller = new AbortController()
    controller.abort()
    const calls: Call[] = []
    await followRunLog({
      follow: async (args) => {
        calls.push({ after: args.after })
      },
      runs: () => Promise.resolve([]),
      onEnvelope: () => {},
      onRestart: () => {},
      onStatus: () => {},
      sleep: () => Promise.resolve(),
      signal: controller.signal,
      retryMs: 0,
    })

    expect(calls).toEqual([])
  })
})
