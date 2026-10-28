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
export type Toast = { id: number; tone: 'ok' | 'bad'; text: string }

type Store = {
  jobs: JobResponse[]
  actions: ActionResponse[]
  loaded: boolean
  connection: Connection
  error: string | null
  now: number
  refresh: () => Promise<void>
  /** Runs an API call, refreshes, and reports the outcome as a toast. */
  run: (label: string, call: () => Promise<unknown>) => Promise<boolean>
  toasts: Toast[]
  dismiss: (id: number) => void
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
