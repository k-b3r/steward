// Shared polling store: one fetch loop feeds every page, and every action refreshes it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { ApiError, api, token } from './api'
import type { ActionResponse, JobResponse } from './api'
import { delay } from './delay'

const POLL_MS = 5000
const TOAST_MS = 5000
const STALE_AFTER_MS = 20_000

type Connection = 'live' | 'reconnecting' | 'stale'
export type Toast = {
  /** Counter from `nextToast`, unique per toast. Used as the React key and passed back to `dismiss`. */
  id: number
  /** `ok` when the call in `run` resolved, `bad` when it threw; picks the check or alert icon. */
  tone: 'ok' | 'bad'
  /** The line shown in the toast, for example `TST-1: cancelled` or `TST-1: confirm failed: HTTP 409`. */
  text: string
}

type Store = {
  /** Latest `/v1/jobs` response, replaced whole on every refresh. The only job list the pages read. */
  jobs: JobResponse[]
  /** Latest `/v1/actions` response, replaced whole on every refresh. */
  actions: ActionResponse[]
  /** Set on the first successful fetch and never reset; pages show a skeleton until then. */
  loaded: boolean
  /**
   * Polling health, computed in the render: `live` while fetches succeed, then `reconnecting`, and
   * `stale` once 20s pass since the last success. Before any success `lastOk` is 0, so it reads `stale`.
   */
  connection: Connection
  /** Message of the last failed refresh, or `null`. Cleared by the next success; shown in the banner. */
  error: string | null
  /** `Date.now()` bumped once a second, so `relativeTime` labels re-render and `connection` can age. */
  now: number
  /** Fetches both lists and replaces them. Run on mount, every 5s, after a successful `run`, and by "Retry now". */
  refresh: () => Promise<void>
  /** Runs an API call, refreshes, and reports the outcome as a toast. */
  run: (label: string, call: () => Promise<unknown>) => Promise<boolean>
  /** Notifications from `run`, newest last; each is removed by `dismiss` after 5s or by its close button. */
  toasts: Toast[]
  /** Removes one toast by its `id`; a missing id is ignored. */
  dismiss: (id: number) => void
  /** Drops the API token from sessionStorage and returns to the sign-in form. Called on a 401 too. */
  signOut: () => void
}

const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (store === null) throw new Error('useStore outside DataProvider')
  return store
}

export function DataProvider({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const [jobs, setJobs] = useState<JobResponse[]>([])
  const [actions, setActions] = useState<ActionResponse[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastOk, setLastOk] = useState(0)
  const [failing, setFailing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextToast = useRef(1)

  const refresh = useCallback(async () => {
    try {
      const [nextJobs, nextActions] = await Promise.all([api.jobs(), api.actions()])
      setJobs(nextJobs)
      setActions(nextActions)
      setLoaded(true)
      setFailing(false)
      setError(null)
      setLastOk(Date.now())
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        token.clear()
        onSignOut()
        return
      }
      setFailing(true)
      setError(caught instanceof Error ? caught.message : 'request failed')
    }
  }, [onSignOut])

  useEffect(() => {
    void refresh()
    const poll = setInterval(() => void refresh(), POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [refresh])

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), [])

  const run = useCallback(
    async (label: string, call: () => Promise<unknown>) => {
      const id = nextToast.current++
      const push = (tone: Toast['tone'], text: string): void => {
        setToasts((list) => [...list, { id, tone, text }])
        void delay(TOAST_MS).then(() => dismiss(id))
      }
      try {
        await call()
        push('ok', label)
        await refresh()
        return true
      } catch (caught) {
        push('bad', `${label} failed: ${caught instanceof Error ? caught.message : 'unknown error'}`)
        return false
      }
    },
    [dismiss, refresh],
  )

  const connection: Connection = !failing ? 'live' : now - lastOk > STALE_AFTER_MS ? 'stale' : 'reconnecting'

  const value = useMemo<Store>(
    () => ({ jobs, actions, loaded, connection, error, now, refresh, run, toasts, dismiss, signOut: onSignOut }),
    [jobs, actions, loaded, connection, error, now, refresh, run, toasts, dismiss, onSignOut],
  )
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}
