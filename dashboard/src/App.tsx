import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { token } from './api'
import { DataProvider, useStore } from './data'
import { JobDetail } from './job-detail'
import { Jobs } from './jobs'
import { Approvals, Overview, Slots } from './pages'
import { SPRITE } from './sprite'
import { Icon } from './ui'

type Theme = 'dark' | 'light'
type Route = { page: 'overview' | 'jobs' | 'slots' | 'approvals' } | { page: 'job'; id: string }

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  const job = /^jobs\/([0-9a-f-]+)$/i.exec(path)
  if (job?.[1] !== undefined) return { page: 'job', id: job[1] }
  if (path === 'jobs') return { page: 'jobs' }
  if (path === 'slots') return { page: 'slots' }
  if (path === 'approvals') return { page: 'approvals' }
  return { page: 'overview' }
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (value.trim() === '') return
    token.set(value.trim())
    onDone()
  }
  return (
    <main className="main" style={{ maxWidth: 420, margin: '15vh auto' }}>
      <form className="panel" onSubmit={submit}>
        <div className="panel-h">
          <Icon name="i-lock" />
          <h2>Sign in to Steward</h2>
        </div>
        <div className="panel-b" style={{ display: 'grid', gap: 12 }}>
          <div className="field">
            <label htmlFor="tok">API token</label>
            <input
              id="tok"
              className="input mono"
              type="password"
              autoFocus
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <span className="hint">The value of API_TOKEN. It is kept for this browser tab only.</span>
          </div>
          <button className="btn primary lg" type="submit">
            Continue
          </button>
        </div>
      </form>
    </main>
  )
}

const NAV: { page: Route['page']; href: string; label: string; icon: string }[] = [
  { page: 'overview', href: '#/', label: 'Overview', icon: 'i-grid' },
  { page: 'jobs', href: '#/jobs', label: 'Jobs', icon: 'i-list' },
  { page: 'slots', href: '#/slots', label: 'Slots', icon: 'i-cpu' },
  { page: 'approvals', href: '#/approvals', label: 'Approvals', icon: 'i-lock' },
]

const LIVE_LABEL = { live: 'Live', reconnecting: 'Reconnecting', stale: 'Stale' } as const

function Shell({ theme, onTheme }: { theme: Theme; onTheme: () => void }) {
  const { connection, error, actions, jobs, toasts, dismiss, refresh, signOut } = useStore()
  const route = useRoute()
  const current = route.page === 'job' ? 'jobs' : route.page
  const pendingApprovals = actions.filter((a) => a.status === 'pending').length
  const working = jobs.filter((j) => j.state === 'running' || j.state === 'claiming').length

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="mark">
            <Icon name="i-layers" size="sm" />
          </span>
          Steward
        </span>
        <span className="live" data-state={connection} role="status">
          <Icon name={connection === 'live' ? 'i-activity' : 'i-wifi-off'} size="sm" />
          {LIVE_LABEL[connection]}
        </span>
        <span className="faint xs">{working} working</span>
        <span className="tb-sp" />
        <button
          className="iconbtn bordered"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          onClick={onTheme}
        >
          <Icon name={theme === 'dark' ? 'i-sun' : 'i-moon'} />
        </button>
        <button className="btn ghost sm" onClick={signOut}>
          Sign out
        </button>
      </header>
      {connection === 'live' ? null : (
        <div className="discon" role="alert">
          <Icon name="i-wifi-off" />
          <span className="grow">
            <strong>{connection === 'stale' ? 'Data may be out of date.' : 'Connection lost.'}</strong>{' '}
            <span className="muted">{error ?? 'Retrying.'}</span>
          </span>
          <button className="btn sm" onClick={() => void refresh()}>
            Retry now
          </button>
        </div>
      )}
      <div className="body">
        <nav className="nav" aria-label="Primary">
          {NAV.map((item) => (
            <a
              key={item.page}
              className="nav-i"
              href={item.href}
              aria-current={current === item.page ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              <span className="grow" />
              {item.page === 'approvals' && pendingApprovals > 0 ? (
                <span className="count attn">{pendingApprovals}</span>
              ) : null}
            </a>
          ))}
        </nav>
        <main className="main">
          {route.page === 'overview' ? <Overview /> : null}
          {route.page === 'jobs' ? <Jobs /> : null}
          {route.page === 'job' ? <JobDetail id={route.id} /> : null}
          {route.page === 'slots' ? <Slots /> : null}
          {route.page === 'approvals' ? <Approvals /> : null}
        </main>
      </div>
      <div style={{ position: 'fixed', top: 64, right: 24, display: 'grid', gap: 8, zIndex: 30 }} aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id} role="status">
            <Icon name={t.tone === 'ok' ? 'i-check' : 'i-alert'} size="lg" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="tt">{t.text}</div>
            </div>
            <button className="iconbtn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="i-x" size="sm" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function App() {
  const [signedIn, setSignedIn] = useState(token.get() !== null)
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem('steward.theme') === 'light' ? 'light' : 'dark',
  )
  const signOut = useCallback(() => {
    token.clear()
    setSignedIn(false)
  }, [])
  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('steward.theme', next)
    setTheme(next)
  }

  return (
    <div className="st" data-theme={theme} data-view="detailed" style={{ minHeight: '100vh' }}>
      {/* Static, trusted icon sprite. */}
      <div dangerouslySetInnerHTML={{ __html: SPRITE }} />
      {signedIn ? (
        <DataProvider onSignOut={signOut}>
          <Shell theme={theme} onTheme={toggleTheme} />
        </DataProvider>
      ) : (
        <Login onDone={() => setSignedIn(true)} />
      )}
    </div>
  )
}
