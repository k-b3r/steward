import { describe, expect, it } from 'vitest'

import type { PendingAction } from './db/store'
import {
  ActionNotPendingError,
  ActionNotFoundError,
  JobNotFoundError,
  cancelJob,
  confirmJob,
  decideAction,
  declineJob,
  reconsiderJob,
  retryJob,
  type CommandStore,
} from './jobs-commands'
import { IllegalTransitionError } from './transitions'
import type { Job, JobState } from './types'

const NOW = new Date('2026-01-02T03:04:05.000Z')

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    source: 'linear',
    externalId: 'ext-1',
    identifier: 'TST-1',
    state: 'proposed',
    attempt: 0,
    maxAttempts: 3,
    slot: null,
    nextRunAt: null,
    failureKind: null,
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

function setup(input: { job?: Job; action?: PendingAction | null } = {}) {
  const jobs = new Map(input.job === undefined ? [] : [[input.job.id, input.job]])
  const actions = new Map(input.action == null ? [] : [[input.action.id, input.action]])
  const calls: string[] = []
  const store: CommandStore = {
    async getJob(id) {
      return (jobs.get(id) as Job | undefined) ?? null
    },
    async getAction(id) {
      return (actions.get(id) as PendingAction | undefined) ?? null
    },
    async transitionJob(id, to, opts) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`Unknown job id: ${id}`)
      const updated = { ...job, state: to, reason: undefined } as Job
      jobs.set(id, updated)
      calls.push(`transition ${job.state} -> ${to}`)
      void opts
      return updated
    },
    async decideAction(id, decision, opts) {
      const action = actions.get(id)
      if (action === undefined) throw new Error(`Unknown pending action: ${id}`)
      if (action.status !== 'pending') throw new Error(`Pending action ${id} is ${action.status}, not pending`)
      const updated = { ...action, status: decision, decidedAt: opts.now, reason: opts.reason ?? null }
      actions.set(id, updated)
      calls.push(`decide ${decision}`)
      return updated
    },
  }
  const deps = {
    store,
    clock: () => NOW,
    enqueue: async (id: string) => void calls.push(`enqueue ${id}`),
    cancelRun: async (id: string) => void calls.push(`cancel run ${id}`),
  }
  return { deps, calls, jobs, actions }
}

const asState = (value: unknown): JobState => (value as Job).state

describe('confirmJob', () => {
  it('queues a proposed job, then enqueues it', async () => {
    const { deps, calls } = setup({ job: makeJob() })

    const job = await confirmJob(deps, '11111111-1111-4111-8111-111111111111')

    expect(asState(job)).toBe('queued')
    expect(calls).toEqual(['transition proposed -> queued', 'enqueue 11111111-1111-4111-8111-111111111111'])
  })

  it('refuses anything that is not proposed', async () => {
    const { deps } = setup({ job: makeJob({ state: 'running' }) })

    await expect(confirmJob(deps, '11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    )
  })

  it('throws JobNotFoundError for an unknown job', async () => {
    const { deps } = setup()

    await expect(confirmJob(deps, 'nope')).rejects.toBeInstanceOf(JobNotFoundError)
  })
})

describe('declineJob', () => {
  it('records the reason', async () => {
    const { deps } = setup({ job: makeJob() })

    const job = await declineJob(deps, '11111111-1111-4111-8111-111111111111', 'not for the agent')

    expect(asState(job)).toBe('declined')
  })

  it('needs a reason', async () => {
    const { deps } = setup({ job: makeJob() })

    await expect(declineJob(deps, '11111111-1111-4111-8111-111111111111', '   ')).rejects.toThrow(/reason/i)
  })
})

describe('retryJob', () => {
  it('requeues a failed job and enqueues it again', async () => {
    const { deps, calls } = setup({ job: makeJob({ state: 'failed', attempt: 3 }) })

    await retryJob(deps, '11111111-1111-4111-8111-111111111111')

    expect(calls).toEqual(['transition failed -> queued', 'enqueue 11111111-1111-4111-8111-111111111111'])
  })

  it('never retries a job that is finished, or one that is already in flight', async () => {
    for (const state of ['done', 'merged', 'running', 'queued', 'pr_open'] as const) {
      const { deps } = setup({ job: makeJob({ state }) })

      await expect(retryJob(deps, '11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(
        IllegalTransitionError,
      )
    }
  })
})

describe('cancelJob', () => {
  it('stops the run first, then records the cancel', async () => {
    const { deps, calls } = setup({ job: makeJob({ state: 'running' }) })

    const job = await cancelJob(deps, '11111111-1111-4111-8111-111111111111')

    expect(asState(job)).toBe('cancelled')
    expect(calls).toEqual(['cancel run 11111111-1111-4111-8111-111111111111', 'transition running -> cancelled'])
  })

  it('does not stop a run for a job that never started', async () => {
    const { deps, calls } = setup({ job: makeJob({ state: 'proposed' }) })

    await expect(cancelJob(deps, '11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(IllegalTransitionError)
    expect(calls).toEqual([])
  })

  it('does not retry a job that is only proposed', async () => {
    const { deps } = setup({ job: makeJob({ state: 'proposed' }) })

    await expect(retryJob(deps, '11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(IllegalTransitionError)
  })
})

describe('reconsiderJob', () => {
  it('returns a declined job to proposed without enqueueing it', async () => {
    const { deps, calls } = setup({ job: makeJob({ state: 'declined' }) })

    const job = await reconsiderJob(deps, '11111111-1111-4111-8111-111111111111')

    expect(asState(job)).toBe('proposed')
    expect(calls).toEqual(['transition declined -> proposed'])
  })
})

describe('decideAction', () => {
  it('approves a pending action', async () => {
    const { deps } = setup({ action: makeAction() })

    const action = await decideAction(deps, makeAction().id, 'approved')

    expect(action.status).toBe('approved')
  })

  it('rejects with a reason', async () => {
    const { deps } = setup({ action: makeAction() })

    const action = await decideAction(deps, makeAction().id, 'rejected', 'wrong wording')

    expect(action).toMatchObject({ status: 'rejected', reason: 'wrong wording' })
  })

  it('reports a missing action as ActionNotFoundError, without scanning a list', async () => {
    const { deps } = setup()

    await expect(decideAction(deps, 'nope', 'approved')).rejects.toBeInstanceOf(ActionNotFoundError)
  })

  it('reports an action that is no longer pending as ActionNotPendingError', async () => {
    const { deps } = setup({ action: makeAction({ status: 'approved' }) })

    await expect(decideAction(deps, makeAction().id, 'rejected')).rejects.toBeInstanceOf(ActionNotPendingError)
  })
})
