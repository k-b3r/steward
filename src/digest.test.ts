import { describe, expect, it } from 'vitest'

import { buildDigest } from './digest'
import type { Job, JobState } from './types'

const NOW = new Date('2026-01-15T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const ago = (days: number, hours = 0): Date => new Date(NOW.getTime() - days * DAY_MS - hours * 3_600_000)

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    source: 'linear',
    externalId: 'ext-1',
    identifier: 'TST-1',
    title: 'A ticket',
    url: 'https://example.test/TST-1',
    createdAt: ago(0),
    state: 'proposed',
    attempt: 0,
    maxAttempts: 3,
    slot: null,
    nextRunAt: null,
    failureKind: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    ...overrides,
  }
}

const WAITING: readonly JobState[] = ['proposed', 'pr_open', 'in_review', 'changes_requested', 'ci_failed', 'failed']
const NOT_WAITING: readonly JobState[] = ['declined', 'queued', 'claiming', 'running', 'merged', 'done', 'cancelled']

describe('buildDigest', () => {
  it('counts proposals, reviewing jobs and failures, and ignores the rest', () => {
    const jobs = [
      job({ identifier: 'TST-1', state: 'proposed' }),
      job({ identifier: 'TST-2', state: 'pr_open' }),
      job({ identifier: 'TST-3', state: 'in_review' }),
      job({ identifier: 'TST-4', state: 'changes_requested' }),
      job({ identifier: 'TST-5', state: 'ci_failed' }),
      job({ identifier: 'TST-6', state: 'failed' }),
      ...NOT_WAITING.map((state, index) => job({ identifier: `TST-${String(10 + index)}`, state })),
    ]

    const digest = buildDigest({ jobs, now: NOW })

    expect(digest.counts).toEqual({ proposals: 1, reviewing: 4, failed: 1 })
    expect(digest.items.map((item) => item.identifier)).toEqual(WAITING.map((_, index) => `TST-${String(index + 1)}`))
  })

  it('orders oldest first within a group, groups in the order proposals, reviewing, failed', () => {
    const digest = buildDigest({
      jobs: [
        job({ identifier: 'TST-5', state: 'failed', createdAt: ago(5) }),
        job({ identifier: 'TST-2', state: 'pr_open', createdAt: ago(2) }),
        job({ identifier: 'TST-4', state: 'proposed', createdAt: ago(4) }),
        job({ identifier: 'TST-1', state: 'pr_open', createdAt: ago(1) }),
        job({ identifier: 'TST-3', state: 'proposed', createdAt: ago(3) }),
        job({ identifier: 'TST-6', state: 'failed', createdAt: ago(6) }),
      ],
      now: NOW,
    })

    expect(digest.items.map((item) => item.identifier)).toEqual(['TST-4', 'TST-3', 'TST-2', 'TST-1', 'TST-6', 'TST-5'])
    expect(digest.items.map((item) => item.ageDays)).toEqual([4, 3, 2, 1, 6, 5])
  })

  it('breaks a tie by identifier, so the same input always reads the same', () => {
    const digest = buildDigest({
      jobs: [
        job({ identifier: 'TST-B', state: 'proposed', createdAt: ago(2) }),
        job({ identifier: 'TST-A', state: 'proposed', createdAt: ago(2) }),
      ],
      now: NOW,
    })

    expect(digest.items.map((item) => item.identifier)).toEqual(['TST-A', 'TST-B'])
  })

  it('reports whole days and never a negative age', () => {
    const digest = buildDigest({
      jobs: [
        job({ identifier: 'TST-1', state: 'proposed', createdAt: ago(0) }),
        job({ identifier: 'TST-2', state: 'proposed', createdAt: ago(1) }),
        job({ identifier: 'TST-3', state: 'proposed', createdAt: ago(3, 23) }),
        job({ identifier: 'TST-4', state: 'proposed', createdAt: new Date(NOW.getTime() + DAY_MS) }),
      ],
      now: NOW,
    })

    expect(digest.items.map((item) => item.ageDays)).toEqual([3, 1, 0, 0])
  })

  it('writes one plain line per item, with the title verbatim and no markup added', () => {
    const markup = 'Fix *the* [header](https://example.test) <b>now</b> & more'
    const digest = buildDigest({
      jobs: [
        job({ identifier: 'TST-1', title: markup, state: 'proposed', createdAt: ago(3) }),
        job({ identifier: 'TST-2', title: 'Add a footer', state: 'pr_open', createdAt: ago(1) }),
        job({ identifier: 'TST-3', title: 'Land the thing', state: 'in_review', createdAt: ago(2) }),
        job({ identifier: 'TST-4', title: 'Rework the parser', state: 'changes_requested', createdAt: ago(4) }),
        job({ identifier: 'TST-5', title: 'Unbreak the build', state: 'ci_failed', createdAt: ago(5) }),
        job({ identifier: 'TST-6', title: 'Retry the job', state: 'failed', createdAt: ago(6) }),
      ],
      now: NOW,
    })

    expect(digest.items[0]?.title).toBe(markup)
    expect(digest.text.split('\n')).toEqual([
      `TST-1 ${markup}: draft waiting 3 days`,
      'TST-5 Unbreak the build: checks failing for 5 days',
      'TST-4 Rework the parser: changes requested 4 days ago',
      'TST-3 Land the thing: in review for 2 days',
      'TST-2 Add a footer: pull request open for 1 day',
      'TST-6 Retry the job: failed 6 days ago',
    ])
    expect(digest.text).not.toContain('`')
    expect(digest.text).not.toContain('\\')
  })

  it('keeps a title that spans lines on one line', () => {
    const digest = buildDigest({ jobs: [job({ title: 'First line\nsecond\tline' })], now: NOW })

    expect(digest.text).toBe('TST-1 First line second line: draft waiting 0 days')
  })

  it('says nothing is waiting when no job is', () => {
    const digest = buildDigest({
      jobs: [job({ state: 'done' }), job({ state: 'running' }), job({ state: 'declined' })],
      now: NOW,
    })

    expect(digest).toEqual({
      counts: { proposals: 0, reviewing: 0, failed: 0 },
      items: [],
      text: 'Nothing is waiting on you.',
    })
  })
})
