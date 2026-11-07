import { describe, expect, it } from 'vitest'

import { ticketCell } from './jobs'

const NOW = Date.parse('2026-01-02T12:00:00.000Z')

const job = {
  id: '11111111-1111-4111-8111-111111111111',
  identifier: 'TST-1',
  title: 'Add a greeting',
  url: 'https://linear.app/example/issue/TST-1',
  createdAt: new Date(NOW - 5 * 60_000).toISOString(),
}

describe('ticketCell', () => {
  it('carries the key, the title, the link into the app and the tracker link', () => {
    expect(ticketCell(job, NOW)).toEqual({
      identifier: 'TST-1',
      title: 'Add a greeting',
      href: `#/jobs/${job.id}`,
      trackerUrl: 'https://linear.app/example/issue/TST-1',
      createdAgo: '5m ago',
    })
  })

  it('offers no tracker link when the ticket has no url', () => {
    expect(ticketCell({ ...job, url: '' }, NOW).trackerUrl).toBeNull()
  })

  it('keeps an empty title empty, so the row can skip the line', () => {
    expect(ticketCell({ ...job, title: '' }, NOW).title).toBe('')
  })

  it('shows a brand new job as just now, never as a time in the future', () => {
    expect(ticketCell({ ...job, createdAt: new Date(NOW).toISOString() }, NOW).createdAgo).toBe('just now')
    // Clock skew between the server and the browser must not read as "in 5s".
    expect(ticketCell({ ...job, createdAt: new Date(NOW + 5_000).toISOString() }, NOW).createdAgo).toBe('just now')
  })
})
