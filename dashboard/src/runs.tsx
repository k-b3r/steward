// A job's attempts, so every run is visible and one can be pinned for the transcript.
import { useEffect, useState } from 'react'

import { api, type RunResponse } from './api'
import { useStore } from './data'
import { relativeTime } from './model'
import { Empty, Icon, Skeleton } from './ui'

type Outcome = NonNullable<RunResponse['outcome']>

const OUTCOME_LABEL: Record<Outcome, string> = {
  done: 'Done',
  pr_open: 'PR open',
  retry: 'Retry',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

// A run borrows the job state colours: in flight reads as running, a retry as a warning.
const OUTCOME_CLASS: Record<Outcome, string> = {
  done: 's-done',
  pr_open: 's-pr_open',
  retry: 's-warn',
  failed: 's-failed',
  cancelled: 's-cancelled',
}

/** A short word for a run: its outcome, plus the failure kind when there is one. */
export function runLabel(run: RunResponse): string {
  const base = run.outcome === null ? 'Running' : OUTCOME_LABEL[run.outcome]
  return run.failureKind === null ? base : `${base} (${run.failureKind})`
}

const outcomeClass = (run: RunResponse): string => (run.outcome === null ? 's-running' : OUTCOME_CLASS[run.outcome])

type RunRow = {
  number: number
  label: string
  failureKind: string | null
  started: string
  ended: string
  slot: string
}

/** The plain data a run row renders, with every time already made relative. */
export function runRow(run: RunResponse, now: number): RunRow {
  return {
    number: run.number,
    label: runLabel(run),
    failureKind: run.failureKind,
    started: relativeTime(run.startedAt, now),
    ended: relativeTime(run.endedAt, now),
    slot: run.slot === null ? '—' : String(run.slot),
  }
}

export function Runs({
  jobId,
  onSelect,
  selected,
}: {
  jobId: string
  selected: number | undefined
  onSelect: (runNumber: number) => void
}) {
  const { now } = useStore()
  // `null` means the list has not arrived yet; a failure says so rather than claiming "no runs".
  const [runs, setRuns] = useState<RunResponse[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setRuns(null)
    setFailed(false)
    void api.runs(jobId).then(
      (list) => {
        if (live) setRuns(list)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [jobId])

  return (
    <section className="panel" aria-label="Runs">
      <div className="panel-h">
        <Icon name="i-list" size="sm" />
        <h2>Runs</h2>
        <span className="grow" />
        {runs === null ? null : <span className="sm muted">{runs.length}</span>}
      </div>
      {runs === null && !failed ? <Skeleton rows={3} /> : null}
      {failed ? <Empty title="Runs unavailable">The list did not load. Try again.</Empty> : null}
      {runs !== null && runs.length === 0 ? (
        <Empty title="No runs yet">The first attempt shows up here once it starts.</Empty>
      ) : null}
      {runs === null || runs.length === 0 ? null : (
        <div className="panel-b" style={{ display: 'grid', gap: 6 }}>
          {runs.map((run) => {
            const row = runRow(run, now)
            return (
              <button
                key={run.number}
                className="btn"
                aria-pressed={selected === run.number}
                onClick={() => onSelect(run.number)}
              >
                <span className="mono">#{row.number}</span>
                <span className={`chip sm ${outcomeClass(run)}`}>{row.label}</span>
                <span className="sm muted">{row.started}</span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
