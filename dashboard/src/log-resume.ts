// Where a transcript stream should resume, and the loop that keeps it following one run.
//
// A `seq` only means something inside one run. The API refuses a bare resume (`after` > 0 without
// `run`) once the job has runs, so a client that opened while the job had none has to learn the run
// and start that run's log from the beginning.
import { ApiError } from './api'
import type { Envelope } from './api'

export type LogResume = { run?: number; after: number }

export type ResumePlan = { resume: LogResume; restart: boolean }

/**
 * Plans the next attempt from the newest run the server reports. `newestRun` is `undefined` when
 * the job has no run yet *or* when the lookup failed: the caller must not treat a failure as
 * "no runs", so both cases keep the current position and change nothing.
 */
export function planResume(current: LogResume, newestRun: number | undefined): ResumePlan {
  if (newestRun === undefined || newestRun === current.run) {
    return { resume: current, restart: false }
  }
  return { resume: { run: newestRun, after: 0 }, restart: true }
}

export type LogStreamDeps = {
  /** One connection attempt: resolves when the server closes the stream. */
  follow: (args: {
    after: number
    run?: number
    signal: AbortSignal
    onEnvelope: (e: Envelope) => void
  }) => Promise<void>
  /** The job's runs, newest last. A rejection means "unknown", never "none". */
  runs: () => Promise<{ number: number }[]>
  onEnvelope: (envelope: Envelope) => void
  /** Called when the stream moves to a different run and its lines must be dropped. */
  onRestart: () => void
  onStatus: (status: 'live' | 'reconnecting') => void
  sleep: (ms: number) => Promise<void>
  signal: AbortSignal
  retryMs: number
  /** When set, follow this run and never move to another. Without it the newest run is pinned. */
  run?: number
}

/**
 * Follows a job's transcript until `signal` aborts. It pins the newest run at open when it can read
 * it, reconnects from the newest envelope it saw, and when the API refuses a bare resume it learns
 * the run, drops the lines, and starts that run from its first envelope.
 */
export async function followRunLog(deps: LogStreamDeps): Promise<void> {
  let lastSeq = 0
  const newestRun =
    deps.run ??
    (await deps
      .runs()
      .then((runs) => runs.at(-1)?.number)
      .catch(() => undefined))
  let resume = planResume({ after: 0 }, newestRun).resume

  while (!deps.signal.aborted) {
    try {
      deps.onStatus('live')
      await deps.follow({
        ...resume,
        // The position moves while the stream is open, so read it here, not from the plan.
        after: lastSeq,
        signal: deps.signal,
        onEnvelope: (envelope) => {
          lastSeq = Math.max(lastSeq, envelope.seq)
          deps.onEnvelope(envelope)
        },
      })
    } catch (error) {
      if (deps.signal.aborted) return
      // A pinned run never moves, so a refusal for it is a real error and not a run switch.
      if (error instanceof ApiError && error.status === 400 && deps.run === undefined) {
        const learnedRun = await deps
          .runs()
          .then((runs) => runs.at(-1)?.number)
          .catch(() => undefined)
        const plan = planResume({ ...resume, after: lastSeq }, learnedRun)
        if (plan.restart) {
          resume = plan.resume
          lastSeq = 0
          deps.onRestart()
        }
      }
    }
    if (deps.signal.aborted) return
    deps.onStatus('reconnecting')
    await deps.sleep(deps.retryMs)
  }
}
