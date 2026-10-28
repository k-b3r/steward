import { useState } from 'react'

import { api } from './api'
import type { JobResponse } from './api'
import { useStore } from './data'
import { CANCELLABLE, RETRYABLE } from './model'
import { Icon } from './ui'

type Pending = { kind: 'decline' | 'cancel' }

/** The buttons a job offers in its current state. Destructive ones ask first. */
export function JobActions({ job, size = 'sm' }: { job: JobResponse; size?: 'sm' | 'lg' }) {
  const { run } = useStore()
  const [pending, setPending] = useState<Pending | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const cls = `btn ${size}`

  const exec = async (label: string, call: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    const ok = await run(`${job.identifier}: ${label}`, call)
    setBusy(false)
    if (ok) {
      setPending(null)
      setReason('')
    }
  }

  return (
    <>
      {job.state === 'proposed' ? (
        <>
          <button
            className={`${cls} primary`}
            disabled={busy}
            onClick={() => void exec('confirmed', () => api.confirm(job.id))}
          >
            <Icon name="i-check" size="sm" />
            Confirm
          </button>
          <button className={cls} disabled={busy} onClick={() => setPending({ kind: 'decline' })}>
            Decline
          </button>
        </>
      ) : null}
      {job.state === 'declined' ? (
        <button className={cls} disabled={busy} onClick={() => void exec('reconsidered', () => api.reconsider(job.id))}>
          Reconsider
        </button>
      ) : null}
      {RETRYABLE.includes(job.state) ? (
        <button
          className={`${cls} primary`}
          disabled={busy}
          onClick={() => void exec('queued for retry', () => api.retry(job.id))}
        >
          <Icon name="i-retry" size="sm" />
          Retry
        </button>
      ) : null}
      {CANCELLABLE.includes(job.state) ? (
        <button className={`${cls} danger`} disabled={busy} onClick={() => setPending({ kind: 'cancel' })}>
          Cancel
        </button>
      ) : null}

      {pending === null ? null : (
        <div className="scrim" style={{ position: 'fixed', inset: 0, zIndex: 20, borderRadius: 0 }} role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
            <div className="dialog-h">
              <h3 id="dlg-t">
                {pending.kind === 'cancel' ? `Cancel ${job.identifier}?` : `Decline ${job.identifier}?`}
              </h3>
            </div>
            <div className="dialog-b">
              {pending.kind === 'cancel' ? (
                <p>The running agent stops and the job moves to Cancelled. You can retry it later.</p>
              ) : (
                <div className="field">
                  <label htmlFor="reason">Reason (required)</label>
                  <textarea
                    id="reason"
                    className="textarea"
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              )}
            </div>
            <div className="dialog-f">
              <button className="btn" onClick={() => setPending(null)}>
                Keep it
              </button>
              {pending.kind === 'cancel' ? (
                <button
                  className="btn danger solid"
                  disabled={busy}
                  onClick={() => void exec('cancelled', () => api.cancel(job.id))}
                >
                  Cancel job
                </button>
              ) : (
                <button
                  className="btn danger solid"
                  disabled={busy || reason.trim() === ''}
                  onClick={() => void exec('declined', () => api.decline(job.id, reason.trim()))}
                >
                  Decline
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
