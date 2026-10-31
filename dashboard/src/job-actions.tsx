import { useState } from 'react'

import { api } from './api'
import type { JobResponse } from './api'
import { useStore } from './data'
import { Icon } from './ui'

/**
 * Which dialog `JobActions` has open, or null for none. Only `decline` (a reason is required) and
 * `cancel` ask first; `confirm`, `reconsider` and `retry` call the API as soon as they are clicked.
 * The typed reason is separate `reason` state and is cleared with `pending` once the call succeeds.
 */
type Pending = {
  /** Which dialog is open: `decline` collects a required reason, `cancel` only asks to confirm. */
  kind: 'decline' | 'cancel'
}

/** The buttons a job offers in its current state. Destructive ones ask first. */
export function JobActions({ job, size = 'sm' }: { job: JobResponse; size?: 'sm' | 'lg' }) {
  const { run } = useStore()
  const [pending, setPending] = useState<Pending | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const cls = `btn ${size}`

  const exec = async (label: string, call: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    const ok = await run(`${job.ticketKey}: ${label}`, call)
    setBusy(false)
    if (ok) {
      setPending(null)
      setReason('')
    }
  }

  return (
    <>
      {job.allowedActions.includes('confirm') ? (
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
      {job.allowedActions.includes('reconsider') ? (
        <button className={cls} disabled={busy} onClick={() => void exec('reconsidered', () => api.reconsider(job.id))}>
          Reconsider
        </button>
      ) : null}
      {job.allowedActions.includes('retry') ? (
        <button
          className={`${cls} primary`}
          disabled={busy}
          onClick={() => void exec('queued for retry', () => api.retry(job.id))}
        >
          <Icon name="i-retry" size="sm" />
          Retry
        </button>
      ) : null}
      {job.allowedActions.includes('cancel') ? (
        <button className={`${cls} danger`} disabled={busy} onClick={() => setPending({ kind: 'cancel' })}>
          Cancel
        </button>
      ) : null}

      {pending === null ? null : (
        <div className="scrim" style={{ position: 'fixed', inset: 0, zIndex: 20, borderRadius: 0 }} role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
            <div className="dialog-h">
              <h3 id="dlg-t">{pending.kind === 'cancel' ? `Cancel ${job.ticketKey}?` : `Decline ${job.ticketKey}?`}</h3>
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
