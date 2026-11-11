import { describe, expect, it } from 'vitest'

import { allowedActionsFor } from './jobs-commands'
import { getJob, listActions, listEvents, listJobs, listRuns, type QueryStore } from './jobs-queries'
import { JOB_STATES, type Job, type JobEvent, type JobState, type PendingAction, type Run } from './types'

const NOW = new Date('2026-01-02T03:04:05.000Z')

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    source: 'linear',
    externalId: 'ext-1',
    identifier: 'TST-1',
    title: 'A job for the ticket',
    url: 'https://example.test/TST-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
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

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    jobId: '11111111-1111-4111-8111-111111111111',
    kind: 'comment',
    payload: { body: 'hi' },
    status: 'pending',
    reason: null,
    createdAt: NOW,
    decidedAt: null,
    ...overrides,
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    number: 1,
    slot: 0,
    startedAt: NOW,
    endedAt: null,
    outcome: null,
    failureKind: null,
    ...overrides,
  }
}

function setup(jobs: Job[] = [], actions: PendingAction[] = [], runs: Run[] = [], eventsList: JobEvent[] = []) {
  const calls: { filter?: { state?: JobState; limit?: number } }[] = []
  const store: QueryStore = {
    async getJob(id) {
      return jobs.find((job) => job.id === id) ?? null
    },
    async listJobs(filter = {}) {
      calls.push({ filter })
      const matching = jobs.filter((job) => filter.state === undefined || job.state === filter.state)
      return filter.limit === undefined ? matching : matching.slice(0, filter.limit)
    },
    async listRuns(jobId) {
      return runs.filter((run) => run.jobId === jobId)
    },
    async listEvents() {
      return eventsList
    },
    async listActions(filter = {}) {
      return actions.filter((action) => filter.status === undefined || action.status === filter.status)
    },
  }
  return { deps: { store }, calls }
}

describe('allowedActionsFor', () => {
  it('offers exactly the intents each state accepts', () => {
    const table: Record<JobState, string[]> = {
      proposed: ['confirm', 'decline'],
      declined: ['reconsider'],
      queued: ['cancel'],
      claiming: ['cancel'],
      running: ['cancel'],
      pr_open: ['cancel'],
      ci_failed: ['cancel'],
      in_review: ['cancel'],
      changes_requested: ['cancel'],
      merged: [],
      done: [],
      failed: ['retry'],
      cancelled: ['retry'],
    }

    for (const state of JOB_STATES) {
      expect(allowedActionsFor(state), state).toEqual(table[state])
    }
  })
})

describe('job views', () => {
  it('turns domain rows into wire-ready views with ISO dates and the allowed actions', async () => {
    const { deps } = setup([makeJob({ state: 'failed', attempt: 2, nextRunAt: NOW, failureKind: 'infra' })])

    const views = await listJobs(deps, {})

    expect(views).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        identifier: 'TST-1',
        title: 'A job for the ticket',
        url: 'https://example.test/TST-1',
        source: 'linear',
        state: 'failed',
        attempt: 2,
        maxAttempts: 3,
        slot: null,
        nextRunAt: NOW.toISOString(),
        failureKind: 'infra',
        createdAt: '2026-01-02T03:04:05.000Z',
        allowedActions: ['retry'],
      },
    ])
  })

  it('keeps a null next run null, not a string', async () => {
    const { deps } = setup([makeJob()])

    const [view] = await listJobs(deps, {})

    expect(view?.nextRunAt).toBeNull()
  })

  it('does not expose the tracker external id, which the UI never shows', async () => {
    const { deps } = setup([makeJob({ externalId: 'internal-id' })])

    const [view] = await listJobs(deps, {})

    expect(JSON.stringify(view)).not.toContain('internal-id')
  })

  it('returns one job by id, or null', async () => {
    const { deps } = setup([makeJob()])

    expect(await getJob(deps, '11111111-1111-4111-8111-111111111111')).toMatchObject({ identifier: 'TST-1' })
    expect(await getJob(deps, 'missing')).toBeNull()
  })
})

describe('list limits', () => {
  it('asks the store for the requested limit', async () => {
    const { deps, calls } = setup([makeJob()])

    await listJobs(deps, { state: 'queued', limit: 5 })

    expect(calls[0]?.filter).toEqual({ state: 'queued', limit: 5 })
  })

  it('defaults to 100 and refuses anything above 500', async () => {
    const { deps, calls } = setup()

    await listJobs(deps, {})
    expect(calls.at(-1)?.filter?.limit).toBe(100)

    await expect(listJobs(deps, { limit: 501 })).rejects.toThrow(/limit/i)
    await expect(listJobs(deps, { limit: 0 })).rejects.toThrow(/limit/i)
  })

  it('passes the state filter through unchanged', async () => {
    const { deps, calls } = setup()

    await listJobs(deps, { state: 'failed' })

    expect(calls.at(-1)?.filter?.state).toBe('failed')
  })
})

describe('event views', () => {
  it('maps the state log to the wire shape with ISO dates and nulls kept', async () => {
    const at = new Date('2026-01-02T03:04:06.000Z')
    const { deps } = setup(
      [],
      [],
      [],
      [
        { fromState: null, toState: 'proposed', failureKind: null, reason: null, at: NOW },
        { fromState: 'claiming', toState: 'queued', failureKind: 'infra', reason: 'blip', at },
      ],
    )

    expect(await listEvents(deps, '11111111-1111-4111-8111-111111111111')).toEqual([
      { from: null, to: 'proposed', failureKind: null, reason: null, at: '2026-01-02T03:04:05.000Z' },
      { from: 'claiming', to: 'queued', failureKind: 'infra', reason: 'blip', at: '2026-01-02T03:04:06.000Z' },
    ])
  })

  it('returns an empty list for a job with no events', async () => {
    const { deps } = setup()

    expect(await listEvents(deps, '11111111-1111-4111-8111-111111111111')).toEqual([])
  })
})

describe('run views', () => {
  it('maps a run to wire shape with ISO dates, keeping open fields null', async () => {
    const ended = new Date(NOW.getTime() + 60_000)
    const { deps } = setup(
      [],
      [],
      [makeRun({ number: 1, endedAt: ended, outcome: 'retry', failureKind: 'infra' }), makeRun({ number: 2 })],
    )

    expect(await listRuns(deps, '11111111-1111-4111-8111-111111111111')).toEqual([
      {
        number: 1,
        slot: 0,
        startedAt: '2026-01-02T03:04:05.000Z',
        endedAt: '2026-01-02T03:05:05.000Z',
        outcome: 'retry',
        failureKind: 'infra',
      },
      { number: 2, slot: 0, startedAt: '2026-01-02T03:04:05.000Z', endedAt: null, outcome: null, failureKind: null },
    ])
  })

  it('does not expose the job id: the caller already has it', async () => {
    const { deps } = setup([], [], [makeRun()])

    const [view] = await listRuns(deps, '11111111-1111-4111-8111-111111111111')

    expect(view).not.toHaveProperty('jobId')
  })
})

describe('action views', () => {
  it('maps to wire shape and filters by status', async () => {
    const { deps } = setup(
      [],
      [makeAction(), makeAction({ id: '44444444-4444-4444-8444-444444444444', status: 'approved' })],
    )

    const pending = await listActions(deps, { status: 'pending' })

    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ status: 'pending', createdAt: NOW.toISOString(), decidedAt: null })
  })
})
