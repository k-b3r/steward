// The state timeline: every move a job made, oldest first. The dashboard's answer to "how did it
// get here?" without reading the transcript.
import { useEffect, useState } from 'react'

import { api, type JobEventResponse } from './api'
import { STATE_LABEL, relativeTime } from './model'
import { Empty, Icon, Skeleton } from './ui'

/** One line per event, e.g. `Proposed -> Queued (from confirmed)`. */
export function eventText(event: JobEventResponse): string {
  const move =
    event.from === null
      ? `created as ${STATE_LABEL[event.to]}`
      : `${STATE_LABEL[event.from]} -> ${STATE_LABEL[event.to]}`
  const reason = event.reason === null || event.reason === '' ? '' : ` (from ${event.reason})`
  const failure = event.failureKind === null ? '' : ` (failure: ${event.failureKind})`
  return `${move}${failure}${reason}`
}

/** The rows the timeline renders, already formatted against one `now`. */
export function eventRows(
  events: JobEventResponse[],
  now: number,
): { key: string; text: string; at: string; failure: boolean }[] {
  return events.map((event, index) => ({
    key: `${index}-${event.at}`,
    text: eventText(event),
    at: relativeTime(event.at, now),
    failure: event.failureKind !== null,
  }))
}

export function Events({ jobId, now }: { jobId: string; now?: number }) {
  const [events, setEvents] = useState<JobEventResponse[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState(() => Date.now())

  useEffect(() => {
    const controller = new AbortController()
    setEvents(null)
    setError(null)
    void api
      .events(jobId)
      .then((next) => {
        if (controller.signal.aborted) return
        setEvents(next)
        setLoadedAt(Date.now())
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : 'request failed')
      })
    return () => {
      controller.abort()
    }
  }, [jobId])

  const clock = now ?? loadedAt

  return (
    <section className="panel" aria-labelledby="events-h">
      <div className="panel-h">
        <Icon name="i-activity" size="sm" />
        <h2 id="events-h">History</h2>
        {events === null ? null : <span className="count">{events.length}</span>}
      </div>
      {error !== null ? (
        <div className="panel-b">
          <p className="sm muted">Could not load the history: {error}</p>
        </div>
      ) : events === null ? (
        <Skeleton rows={3} />
      ) : events.length === 0 ? (
        <Empty title="No state changes yet" />
      ) : (
        <div className="panel-b">
          {eventRows(events, clock).map((row) => (
            <div className={`ln ${row.failure ? 'err' : 'sys'}`} key={row.key}>
              <span className="t">{row.at}</span>
              <span className="k">{row.failure ? 'failed' : 'state'}</span>
              <span className="m">{row.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
