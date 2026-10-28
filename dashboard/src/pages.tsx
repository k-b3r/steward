import { useState } from 'react'

import { api } from './api'
import type { ActionResponse, JobResponse } from './api'
import { useStore } from './data'
import { JobActions } from './job-actions'
import { LANES, relativeTime } from './model'
import { Attempts, Empty, Icon, PageHead, Skeleton, StateChip } from './ui'

const jobHref = (job: JobResponse): string => `#/jobs/${job.id}`

function Today() {
  const { jobs } = useStore()
  const count = (...states: JobResponse['state'][]): number => jobs.filter((j) => states.includes(j.state)).length
  const stats: [string, number, string][] = [
    ['Working', count('running', 'claiming'), 'agents on a slot'],
    ['Waiting', count('queued', 'proposed'), 'queued or proposed'],
    ['In review', count('pr_open', 'in_review', 'changes_requested'), 'pull requests open'],
    ['Failed', count('failed'), 'need a retry'],
    ['Merged', count('merged', 'done'), 'finished'],
    ['Total', jobs.length, 'jobs known'],
  ]
  return (
    <section className="today" aria-label="Summary">
      {stats.map(([label, value, sub]) => (
        <div className="stat" key={label}>
          <span className="l">{label}</span>
          <span className="v">{value}</span>
          <span className="s">{sub}</span>
        </div>
      ))}
    </section>
  )
}

function ActionRow({ action }: { action: ActionResponse }) {
  const { run, jobs } = useStore()
  const job = jobs.find((j) => j.id === action.jobId)
  return (
    <div className="attn">
      <span className="chip s-in_review">
        <Icon name="i-lock" />
        Approval
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="ttl">
          <span className="jid">{job?.identifier ?? action.jobId.slice(0, 8)}</span>
          <span className="trunc">{action.kind}</span>
        </div>
        <div className="why">Nothing is sent until you approve.</div>
      </div>
      <div className="acts">
        <button
          className="btn sm primary"
          onClick={() => void run(`${action.kind} approved`, () => api.approve(action.id))}
        >
          Approve
        </button>
        <button
          className="btn sm danger"
          onClick={() => void run(`${action.kind} rejected`, () => api.reject(action.id))}
        >
          Reject
        </button>
      </div>
    </div>
  )
}

function Attention() {
  const { jobs, actions, now, loaded } = useStore()
  const pending = actions.filter((a) => a.status === 'pending')
  const jobsNeedingYou = jobs.filter(
    (j) => j.state === 'failed' || j.state === 'proposed' || j.state === 'changes_requested',
  )
  const total = pending.length + jobsNeedingYou.length
  return (
    <section className="panel" aria-labelledby="attn-h">
      <div className="panel-h">
        <Icon name="i-alert" />
        <h2 id="attn-h">Needs attention</h2>
        {total > 0 ? <span className="count attn">{total}</span> : null}
      </div>
      {!loaded ? <Skeleton rows={3} /> : null}
      {loaded && total === 0 ? (
        <Empty title="Nothing needs you">Failed jobs, proposals and approvals show up here.</Empty>
      ) : null}
      {pending.map((action) => (
        <ActionRow key={action.id} action={action} />
      ))}
      {jobsNeedingYou.map((job) => (
        <div className="attn" key={job.id}>
          <StateChip state={job.state} />
          <div style={{ minWidth: 0 }}>
            <div className="ttl">
              <a className="jid link" href={jobHref(job)}>
                {job.identifier}
              </a>
              <span className="trunc faint">{job.source}</span>
            </div>
            <div className="why">
              {job.state === 'failed'
                ? `Failed on attempt ${job.attempt} of ${job.maxAttempts}${job.failureKind === null ? '' : ` (${job.failureKind})`}.`
                : job.state === 'proposed'
                  ? 'Waiting for you to confirm or decline.'
                  : 'A reviewer asked for changes.'}
              {job.nextRunAt === null ? '' : ` Next run ${relativeTime(job.nextRunAt, now)}.`}
            </div>
          </div>
          <div className="acts">
            <JobActions job={job} />
          </div>
        </div>
      ))}
    </section>
  )
}

function slotNumbers(jobs: JobResponse[]): number[] {
  const seen = jobs.filter((j) => j.slot !== null).map((j) => j.slot as number)
  const max = Math.max(2, ...seen)
  return Array.from({ length: max + 1 }, (_, i) => i)
}

function SlotGrid({ large }: { large?: boolean }) {
  const { jobs, loaded } = useStore()
  const busy = jobs.filter((j) => j.slot !== null && (j.state === 'claiming' || j.state === 'running'))
  const slots = slotNumbers(jobs)
  if (!loaded) return <Skeleton rows={3} />
  return (
    <div className={large === true ? 'sgrid' : 'swarm'}>
      {slots.map((n) => {
        const job = busy.find((j) => j.slot === n)
        if (job === undefined) {
          return (
            <div className="slot idle" key={n}>
              <div className="slot-h">
                <span className="slot-n">SLOT {n}</span>
                <span className="chip sm s-queued">
                  <Icon name="i-queued" />
                  Idle
                </span>
              </div>
              <div className="sm">Waiting for a ticket</div>
            </div>
          )
        }
        return (
          <a className="slot" key={n} href={jobHref(job)} style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="slot-h">
              <span className="slot-n">SLOT {n}</span>
              <StateChip state={job.state} small />
            </div>
            <div>
              <div className="slot-id">{job.identifier}</div>
              <div className="slot-t faint">{job.source}</div>
            </div>
            <div className="slot-f">
              <div className="slot-m">
                <span className="mono">attempt {job.attempt}</span>
              </div>
            </div>
          </a>
        )
      })}
    </div>
  )
}

export function Overview() {
  const { jobs, loaded } = useStore()
  const busy = jobs.filter((j) => j.slot !== null && (j.state === 'claiming' || j.state === 'running')).length
  return (
    <>
      <PageHead title="Overview" sub={new Date().toLocaleString()} />
      <Today />
      <Attention />
      <section aria-labelledby="swarm-h">
        <div className="sec-h">
          <h2 id="swarm-h">Swarm</h2>
          <span className="faint xs">{busy} busy</span>
        </div>
        <SlotGrid />
      </section>
      <section aria-label="Pipeline lanes">
        <div className="lanes">
          {LANES.map((lane) => {
            const cards = jobs.filter((j) => lane.states.includes(j.state))
            return (
              <div className="lane" key={lane.name}>
                <div className="lane-h">
                  <h3>{lane.name}</h3>
                  <span className="count">{cards.length}</span>
                </div>
                {loaded && cards.length === 0 ? (
                  <p className="faint xs" style={{ padding: 4 }}>
                    Empty
                  </p>
                ) : null}
                {cards.slice(0, 8).map((job) => (
                  <a
                    className="kcard"
                    key={job.id}
                    href={jobHref(job)}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    <div className="r">
                      <span className="jid">{job.identifier}</span>
                      <StateChip state={job.state} small />
                    </div>
                    <div className="m">
                      <span>{job.source}</span>
                      <Attempts job={job} />
                    </div>
                  </a>
                ))}
                {cards.length > 8 ? (
                  <a className="xs" href="#/jobs">
                    +{cards.length - 8} more
                  </a>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}

export function Slots() {
  const { jobs } = useStore()
  return (
    <>
      <PageHead title="Slots" sub="Each slot runs one agent at a time." />
      <SlotGrid large />
      <p className="faint xs">
        {jobs.filter((j) => j.state === 'queued').length} queued jobs are waiting for a free slot.
      </p>
    </>
  )
}

export function Approvals() {
  const { actions, loaded } = useStore()
  const [showAll, setShowAll] = useState(false)
  const list = actions.filter((a) => showAll || a.status === 'pending')
  return (
    <>
      <PageHead title="Approvals" sub="Nothing leaves this machine until you approve it.">
        <div className="seg" role="group" aria-label="Show">
          <button aria-pressed={!showAll} onClick={() => setShowAll(false)}>
            Pending
          </button>
          <button aria-pressed={showAll} onClick={() => setShowAll(true)}>
            All
          </button>
        </div>
      </PageHead>
      <section className="panel">
        {!loaded ? <Skeleton /> : null}
        {loaded && list.length === 0 ? (
          <Empty title="No approvals">Actions that need your say show up here.</Empty>
        ) : null}
        {list.map((action) =>
          action.status === 'pending' ? (
            <ActionRow key={action.id} action={action} />
          ) : (
            <div className="attn" key={action.id}>
              <span
                className={`chip ${action.status === 'approved' || action.status === 'done' ? 's-ok' : 's-failed'}`}
              >
                {action.status}
              </span>
              <div>
                <div className="ttl">
                  <span className="jid">{action.kind}</span>
                </div>
                {action.reason === null ? null : <div className="why">{action.reason}</div>}
              </div>
              <span className="faint xs mono">{action.decidedAt ?? action.createdAt}</span>
            </div>
          ),
        )}
      </section>
    </>
  )
}
