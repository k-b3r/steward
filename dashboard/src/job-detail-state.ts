// Which run the job page is pinning.
//
// The page is one component for every job (`#/jobs/<id>` is a hash route), so React keeps the same
// instance when the job changes. A run number picked on one job means nothing on the next, so the
// selection is stored with the job it belongs to and read back only for that job.

export type RunSelection = { jobId: string; run?: number }

/** The run to pin for `jobId`, or undefined when the selection belongs to another job. */
export function selectedRunFor(selection: RunSelection, jobId: string): number | undefined {
  return selection.jobId === jobId ? selection.run : undefined
}

/** The selection after someone picks a run on `jobId`. */
export function selectRun(selection: RunSelection, jobId: string, run: number | undefined): RunSelection {
  const sameJob = selection.jobId === jobId
  if (run === undefined) {
    // Clearing drops the number but keeps the job, so a later pick starts clean.
    return sameJob && selection.run === undefined ? selection : { jobId }
  }
  return sameJob && selection.run === run ? selection : { jobId, run }
}
