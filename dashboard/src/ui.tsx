// Small presentational pieces shared by the pages. Class names come from design.css.
import type { ReactNode } from 'react'

import type { JobResponse } from './api'
import { STATE_LABEL, isSpinning, stateClass, stateIcon } from './model'

export function Icon({ name, size, spin }: { name: string; size?: 'sm' | 'xs' | 'lg'; spin?: boolean }) {
  return (
    <svg className={`ic${size === undefined ? '' : ` ${size}`}${spin === true ? ' spin' : ''}`} aria-hidden="true">
      <use href={`#${name}`} />
    </svg>
  )
}

export function StateChip({ state, small }: { state: JobResponse['state']; small?: boolean }) {
  return (
    <span className={`chip ${small === true ? 'sm ' : ''}${stateClass(state)}`}>
      <Icon name={stateIcon(state)} spin={isSpinning(state)} />
      {STATE_LABEL[state]}
    </span>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="ring">
        <Icon name="i-layers" />
      </span>
      <h3>{title}</h3>
      {children === undefined ? null : <p>{children}</p>}
    </div>
  )
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="panel-b" aria-busy="true" aria-label="Loading" style={{ display: 'grid', gap: 14 }}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skel" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  )
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="ph">
      <div>
        <h1>{title}</h1>
        {sub === undefined ? null : <p className="sub">{sub}</p>}
      </div>
      {children === undefined ? null : <div className="acts">{children}</div>}
    </div>
  )
}

export function Attempts({ job }: { job: JobResponse }) {
  return (
    <span className="att" title="Attempt">
      {job.attempt}/{job.maxAttempts}
    </span>
  )
}
