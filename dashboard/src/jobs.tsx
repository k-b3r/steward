import { useMemo, useState } from 'react'

import type { JobResponse } from './api'
import { useStore } from './data'
import { JobActions } from './job-actions'
import { FILTERS, relativeTime, safeTrackerUrl } from './model'
import { Attempts, Empty, Icon, PageHead, Skeleton, StateChip } from './ui'

const jobHref = (job: { id: string }): string => `#/jobs/${job.id}`

/** What the Job and Created columns show: the key, the ticket title, a way into the tracker, and age. */
export function ticketCell(
  job: Pick<JobResponse, 'id' | 'identifier' | 'title' | 'url' | 'createdAt'>,
  now: number,
): { identifier: string; title: string; href: string; trackerUrl: string | null; createdAgo: string } {
  return {
    identifier: job.identifier,
    title: job.title,
    href: jobHref(job),
    trackerUrl: safeTrackerUrl(job.url),
    // An age is never "in 2s": a tick of clock skew reads as brand new, not as the future.
    createdAgo: now - Date.parse(job.createdAt) <= 0 ? 'just now' : relativeTime(job.createdAt, now),
  }
}

type SortKey = 'identifier' | 'state' | 'attempt'

export function Jobs() {
  const { jobs, loaded, now } = useStore()
  const [filter, setFilter] = useState(0)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'identifier', dir: 1 })

  const rows = useMemo(() => {
    const states = FILTERS[filter]?.states ?? []
    const q = query.trim().toLowerCase()
    return jobs
      .filter(
        (j) =>
          (states.length === 0 || states.includes(j.state)) &&
          (q === '' || `${j.identifier} ${j.title} ${j.source}`.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const left = a[sort.key]
        const right = b[sort.key]
        return (left < right ? -1 : left > right ? 1 : 0) * sort.dir
      })
  }, [jobs, filter, query, sort])

  const head = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        className="thb"
        aria-pressed={sort.key === key}
        onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 1 ? -1 : 1 }))}
      >
        {label}
        <Icon name="i-sort" size="xs" />
      </button>
    </th>
  )

  return (
    <>
      <PageHead title="Jobs" sub={`${rows.length} of ${jobs.length}`} />
      <div className="toolbar" role="group" aria-label="Filters">
        {FILTERS.map((f, i) => (
          <button key={f.name} className="fchip" aria-pressed={filter === i} onClick={() => setFilter(i)}>
            {f.name}
            <span className="n">
              {f.states.length === 0 ? jobs.length : jobs.filter((j) => f.states.includes(j.state)).length}
            </span>
          </button>
        ))}
        <span className="tb-sp" style={{ flex: 1 }} />
        <label className="search" style={{ width: 240 }}>
          <Icon name="i-search" size="sm" />
          <input
            type="search"
            placeholder="Search jobs"
            aria-label="Search jobs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="panel" style={{ overflowX: 'auto' }}>
        {!loaded ? (
          <Skeleton rows={6} />
        ) : rows.length === 0 ? (
          <Empty title="No jobs match">Change the filter, or wait for the next poll.</Empty>
        ) : (
          <table className="tbl jobs-tbl">
            <thead>
              <tr>
                {head('identifier', 'Job')}
                {head('state', 'State')}
                <th>Source</th>
                {head('attempt', 'Attempt')}
                <th>Slot</th>
                <th>Created</th>
                <th>Next run</th>
                <th>Failure</th>
                <th className="r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((job) => {
                const cell = ticketCell(job, now)
                return (
                  <tr key={job.id}>
                    <td>
                      <a className="jid link" href={jobHref(job)}>
                        {job.identifier}
                      </a>
                      {job.title === '' ? null : <div className="xs muted trunc">{job.title}</div>}
                      {cell.trackerUrl === null ? null : (
                        <a
                          className="faint xs"
                          href={cell.trackerUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${job.identifier} in the tracker`}
                        >
                          <Icon name="i-external" size="xs" /> tracker
                        </a>
                      )}
                    </td>
                    <td>
                      <StateChip state={job.state} />
                    </td>
                    <td className="muted">{job.source}</td>
                    <td>
                      <Attempts job={job} />
                    </td>
                    <td className="mono">{job.slot ?? '—'}</td>
                    <td className="mono muted">{cell.createdAgo}</td>
                    <td className="mono muted">{relativeTime(job.nextRunAt, now)}</td>
                    <td>
                      {job.failureKind === null ? (
                        <span className="faint">—</span>
                      ) : (
                        <span className="tag">{job.failureKind}</span>
                      )}
                    </td>
                    <td className="r">
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <JobActions job={job} />
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
