// Where a transcript stream should resume, and whether it starts over.
//
// A `seq` only means something inside one run. The API refuses a bare resume (`after` > 0 without
// `run`) once the job has runs, so a client that opened while the job had none has to learn the run
// and start that run's log from the beginning.

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
