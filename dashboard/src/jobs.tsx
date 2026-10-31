import { useMemo, useState } from 'react'

import { useStore } from './data'
import { JobActions } from './job-actions'
import { FILTERS, relativeTime } from './model'
import { Attempts, Empty, Icon, PageHead, Skeleton, StateChip } from './ui'

const jobHref = (job: { id: string }): string => `#/jobs/${job.id}`

/**
 * The columns the jobs table sorts by: `ticketKey`, `state` and `attempt`. One state holds the key plus a
 * `1 | -1` direction; clicking a header selects that key or flips the direction. All three compare with
 * `<`, so `ticketKey` sorts as text and `TST-10` lands before `TST-2`.
 */
type SortKey = 'ticketKey' | 'state' | 'attempt'

export function Jobs() {
  const { jobs, loaded, now } = useStore()
  const [filter, setFilter] = useState(0)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'ticketKey', dir: 1 })

  const rows = useMemo(() => {
    const states = FILTERS[filter]?.states ?? []
    const q = query.trim().toLowerCase()
    return jobs
      .filter(
        (j) =>
          (states.length === 0 || states.includes(j.state)) &&
          (q === '' || `${j.ticketKey} ${j.source}`.toLowerCase().includes(q)),
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
                {head('ticketKey', 'Job')}
                {head('state', 'State')}
                <th>Source</th>
                {head('attempt', 'Attempt')}
                <th>Slot</th>
                <th>Next run</th>
                <th>Failure</th>
                <th className="r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((job) => (
                <tr key={job.id}>
                  <td>
                    <a className="jid link" href={jobHref(job)}>
                      {job.ticketKey}
                    </a>
                  </td>
                  <td>
                    <StateChip state={job.state} />
                  </td>
                  <td className="muted">{job.source}</td>
                  <td>
                    <Attempts job={job} />
                  </td>
                  <td className="mono">{job.slot ?? '—'}</td>
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
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
