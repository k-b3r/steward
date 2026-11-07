import { useEffect, useRef, useState } from 'react'

import { api, followLog } from './api'
import type { Envelope } from './api'
import { useStore } from './data'
import { delay } from './delay'
import { Events } from './events'
import { selectRun, selectedRunFor, type RunSelection } from './job-detail-state'
import { followRunLog } from './log-resume'
import { Runs } from './runs'
import { JobActions } from './job-actions'
import { STATE_LABEL, relativeTime, safeTrackerUrl } from './model'
import { Attempts, Empty, Icon, Skeleton, StateChip } from './ui'

const RECONNECT_MS = 2000

const KIND_CLASS: Record<Envelope['kind'], string> = {
  assistant: 'asst',
  tool: 'tool',
  result: 'res',
  error: 'err',
  system: 'sys',
  orchestrator: 'sys',
}

function envelopeText(data: unknown): string {
  if (typeof data === 'string') return data
  if (typeof data === 'object' && data !== null && 'msg' in data && typeof data.msg === 'string') return data.msg
  return JSON.stringify(data, null, 2)
}

function LiveLog({ jobId, run: pinnedRun }: { jobId: string; run?: number }) {
  const [lines, setLines] = useState<Envelope[]>([])
  const [status, setStatus] = useState<'live' | 'reconnecting'>('live')
  const [follow, setFollow] = useState(true)
  const body = useRef<HTMLDivElement>(null)
  const lastSeq = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    setLines([])
    lastSeq.current = 0
    void followRunLog({
      follow: (args) => followLog(jobId, args),
      runs: () => api.runs(jobId),
      onEnvelope: (envelope) => {
        lastSeq.current = Math.max(lastSeq.current, envelope.seq)
        setLines((prev) => [...prev, envelope])
      },
      onRestart: () => {
        lastSeq.current = 0
        setLines([])
      },
      onStatus: setStatus,
      sleep: delay,
      signal: controller.signal,
      retryMs: RECONNECT_MS,
      ...(pinnedRun === undefined ? {} : { run: pinnedRun }),
    })
    return () => controller.abort()
  }, [jobId, pinnedRun])

  useEffect(() => {
    const el = body.current
    if (follow && el !== null) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  return (
    <div className="log">
      <div className="log-tb">
        <Icon name="i-terminal" size="sm" />
        <strong className="sm">Transcript</strong>
        <span className="count">{lines.length}</span>
        <span style={{ flex: 1 }} />
        <span className="live" data-state={status === 'live' ? 'live' : 'reconnecting'}>
          <span className="livedot" />
          {status === 'live' ? 'Streaming' : 'Reconnecting'}
        </span>
        <button className="fchip" aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
          Follow
        </button>
      </div>
      <div className="log-b" ref={body} style={{ maxHeight: 560, overflow: 'auto' }} role="log" aria-live="off">
        {lines.length === 0 ? <Empty title="No output yet">The transcript appears as the agent works.</Empty> : null}
        {lines.map((e) => (
          <div className={`ln ${KIND_CLASS[e.kind]}`} key={e.seq}>
            <span className="t">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span>
            <span className="k">{e.kind}</span>
            <span className="m">{envelopeText(e.data)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function JobDetail({ id }: { id: string }) {
  const { jobs, loaded, now } = useStore()
  // Which run's transcript is on screen. Undefined means "the newest one, follow it".
  // The pick is stored with its job: this component instance survives a hash change to another job.
  const [selection, setSelection] = useState<RunSelection>({ jobId: id })
  const run = selectedRunFor(selection, id)
  const job = jobs.find((j) => j.id === id)
  if (!loaded) return <Skeleton />
  if (job === undefined) {
    return (
      <>
        <div className="crumbs">
          <a href="#/jobs">Jobs</a>
        </div>
        <Empty title="Job not found">It may have been removed.</Empty>
      </>
    )
  }
  const trackerUrl = safeTrackerUrl(job.url)

  return (
    <>
      <div className="crumbs">
        <a href="#/jobs">Jobs</a>
        <Icon name="i-chev-r" size="xs" />
        <span className="mono">{job.identifier}</span>
      </div>
      <section className="jh">
        <div className="jh-top">
          <div>
            <h1 className="mono">{job.identifier}</h1>
            <p className="sub">
              {job.title}{' '}
              {trackerUrl === null ? null : (
                <a className="link" href={trackerUrl} target="_blank" rel="noreferrer">
                  Open in the tracker
                </a>
              )}
            </p>
            <div className="jh-meta">
              <StateChip state={job.state} />
              <span className="it">Source {job.source}</span>
              <span className="it">
                Attempt <Attempts job={job} />
              </span>
              {job.slot === null ? null : <span className="it">Slot {job.slot}</span>}
            </div>
          </div>
          <div className="acts" style={{ display: 'flex', gap: 8 }}>
            <JobActions job={job} />
          </div>
        </div>
        {job.state === 'failed' ? (
          <div className="callout" role="alert">
            <Icon name="i-alert" />
            <div>
              <h3>
                {STATE_LABEL.failed}
                {job.failureKind === null ? '' : `: ${job.failureKind} failure`}
              </h3>
              <p>
                {job.failureKind === 'setup'
                  ? 'Setup failures are never retried automatically. Fix the cause, then retry.'
                  : `Attempt ${job.attempt} of ${job.maxAttempts}. Retry to run it again.`}
              </p>
            </div>
          </div>
        ) : null}
        {job.nextRunAt === null ? null : <p className="sm muted">Next run {relativeTime(job.nextRunAt, now)}</p>}
      </section>
      <LiveLog jobId={job.id} {...(run === undefined ? {} : { run })} />
      <div style={{ display: 'grid', gap: 16, marginTop: 16 }}>
        <Runs jobId={job.id} selected={run} onSelect={(picked) => setSelection(selectRun(selection, id, picked))} />
        <Events jobId={job.id} now={now} />
      </div>
    </>
  )
}
