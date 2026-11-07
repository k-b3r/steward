import { describe, expect, it } from 'vitest'

import { selectRun, selectedRunFor } from './job-detail-state'

describe('selectedRunFor', () => {
  it('returns the pinned run for the job it was picked on', () => {
    expect(selectedRunFor({ jobId: 'job-a', run: 2 }, 'job-a')).toBe(2)
  })

  it('returns nothing for another job, so run 2 of A is never asked of B', () => {
    expect(selectedRunFor({ jobId: 'job-a', run: 2 }, 'job-b')).toBeUndefined()
  })

  it('follows the newest run when nothing was picked', () => {
    expect(selectedRunFor({ jobId: 'job-a' }, 'job-a')).toBeUndefined()
  })
})

describe('selectRun', () => {
  it('records a pick against its job', () => {
    expect(selectRun({ jobId: 'job-a' }, 'job-a', 3)).toEqual({ jobId: 'job-a', run: 3 })
  })

  it('clears the number when the newest run is chosen again', () => {
    expect(selectRun({ jobId: 'job-a', run: 3 }, 'job-a', undefined)).toEqual({ jobId: 'job-a' })
  })

  it('does not carry a pick over to a new job', () => {
    const moved = selectRun({ jobId: 'job-a', run: 3 }, 'job-b', undefined)

    expect(moved).toEqual({ jobId: 'job-b' })
    expect(selectedRunFor(moved, 'job-b')).toBeUndefined()
  })
})
