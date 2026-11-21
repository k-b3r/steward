import { describe, expect, it } from 'vitest'

import type { PendingAction } from './types'
import {
  ActionNotPendingError,
  ActionNotFoundError,
  JobNotFoundError,
  cancelJob,
  confirmJob,
  decideAction,
  ActionNotExecutableError,
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
    async finishAction(id, outcome, opts) {
      const action = actions.get(id)
      if (action === undefined) throw new Error(`Unknown pending action: ${id}`)
      const updated = { ...action, status: outcome, reason: opts.reason ?? action.reason }
      actions.set(id, updated)
      calls.push(`finish ${outcome}`)
      return updated
    },
    async createAction(input) {
      const action: PendingAction = {
        id: '44444444-4444-4444-8444-444444444444',
        jobId: input.jobId,
        kind: input.kind,
        payload: input.payload,
        status: 'pending',
        reason: input.reason ?? null,
        createdAt: input.now,
        decidedAt: null,
      }
      actions.set(action.id, action)
      calls.push(`create action ${action.kind}`)
      return action
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

describe('confirmJob and the Linear move', () => {
  const JOB_ID = '11111111-1111-4111-8111-111111111111'

  function withMove(result: () => Promise<'moved' | 'already'>, moves: [string, string][] = []) {
    return {
      targetState: 'In Progress',
      moveToState: async (issueId: string, stateName: string) => {
        moves.push([issueId, stateName])
        return result()
      },
    }
  }

  it('moves the ticket after the job is queued and enqueued', async () => {
    const { deps, calls } = setup({ job: makeJob({ externalId: 'issue-42' }) })
    const moves: [string, string][] = []
    const linear = {
      targetState: 'In Progress',
      moveToState: async (issueId: string, stateName: string) => {
        calls.push('move')
        moves.push([issueId, stateName])
        return 'moved' as const
      },
    }

    const job = await confirmJob({ ...deps, linear }, JOB_ID)

    expect(asState(job)).toBe('queued')
    expect(moves).toEqual([['issue-42', 'In Progress']])
    expect(calls).toEqual(['transition proposed -> queued', `enqueue ${JOB_ID}`, 'move'])
  })

  it('treats already as success and records no action', async () => {
    const { deps, calls, actions } = setup({ job: makeJob() })

    const job = await confirmJob({ ...deps, linear: withMove(async () => 'already') }, JOB_ID)

    expect(asState(job)).toBe('queued')
    expect(calls).toEqual(['transition proposed -> queued', `enqueue ${JOB_ID}`])
    expect(actions.size).toBe(0)
  })

  it('still queued the job when the move fails, and records one action a person can retry', async () => {
    const { deps, actions } = setup({ job: makeJob({ externalId: 'issue-42' }) })
    const failure = new Error('Linear issueUpdate failed with status 500')
    const warnings: { message: string; fields?: Record<string, unknown> }[] = []

    const job = await confirmJob(
      {
        ...deps,
        linear: withMove(() => Promise.reject(failure)),
        logger: { warn: (message, fields) => warnings.push({ message, fields }) },
      },
      JOB_ID,
    )

    expect(asState(job)).toBe('queued')
    expect([...actions.values()]).toHaveLength(1)
    expect([...actions.values()][0]).toMatchObject({
      jobId: JOB_ID,
      kind: 'linear_move',
      payload: { issueId: 'issue-42', state: 'In Progress' },
      status: 'pending',
      reason: failure.message,
      createdAt: NOW,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.fields).toMatchObject({ jobId: JOB_ID, issueId: 'issue-42', reason: failure.message })
  })

  it('rejects when the pending action cannot be recorded, with the job already queued', async () => {
    const { deps } = setup({ job: makeJob({ externalId: 'issue-42' }) })
    const failing = {
      ...deps,
      store: { ...deps.store, createAction: () => Promise.reject(new Error('insert failed')) },
      linear: withMove(() => Promise.reject(new Error('Linear is down'))),
    }

    await expect(confirmJob(failing, JOB_ID)).rejects.toThrow('insert failed')
    expect(asState((await deps.store.getJob(JOB_ID)) as Job)).toBe('queued')
  })

  it('does not touch Linear when no writer is wired', async () => {
    const { deps, calls } = setup({ job: makeJob() })

    await confirmJob(deps, JOB_ID)

    expect(calls).toEqual(['transition proposed -> queued', `enqueue ${JOB_ID}`])
  })

  it('does not move the ticket when the confirm itself is refused', async () => {
    const { deps } = setup({ job: makeJob({ state: 'queued' }) })
    const moves: [string, string][] = []

    await expect(confirmJob({ ...deps, linear: withMove(async () => 'moved', moves) }, JOB_ID)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    )
    expect(moves).toEqual([])
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
    for (const state of ['done', 'merged', 'running', 'queued', 'pr_open', 'ci_failed'] as const) {
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

describe('decideAction on a linear_move', () => {
  const MOVE = makeAction({ kind: 'linear_move', payload: { issueId: 'issue-1', state: 'In Progress' } })

  function withLinear(moveToState: (issueId: string, state: string) => Promise<'moved' | 'already'>) {
    const { deps, calls, actions } = setup({ action: MOVE })
    return { deps: { ...deps, linear: { moveToState, targetState: 'In Progress' } }, calls, actions }
  }

  it('retries the recorded move when approved, and marks the action done', async () => {
    const moves: [string, string][] = []
    const { deps, calls } = withLinear(async (issueId, state) => {
      moves.push([issueId, state])
      return 'moved'
    })

    const action = await decideAction(deps, MOVE.id, 'approved')

    expect(moves).toEqual([['issue-1', 'In Progress']])
    expect(action.status).toBe('done')
    expect(calls).toEqual(['decide approved', 'finish done'])
  })

  it('treats an already-moved ticket as done', async () => {
    const { deps } = withLinear(async () => 'already')

    expect((await decideAction(deps, MOVE.id, 'approved')).status).toBe('done')
  })

  it('marks the action failed with the reason when the retry throws, instead of rejecting the request', async () => {
    const { deps, calls } = withLinear(async () => {
      throw new Error('Linear is down')
    })

    const action = await decideAction(deps, MOVE.id, 'approved')

    expect(action).toMatchObject({ status: 'failed', reason: 'Linear is down' })
    expect(calls).toEqual(['decide approved', 'finish failed'])
  })

  it('does not move anything when rejected', async () => {
    const moves: string[] = []
    const { deps } = withLinear(async (issueId) => {
      moves.push(issueId)
      return 'moved'
    })

    const action = await decideAction(deps, MOVE.id, 'rejected', 'not now')

    expect(action.status).toBe('rejected')
    expect(moves).toEqual([])
  })

  it('refuses to approve, and leaves it pending, when Linear writes are not enabled', async () => {
    const { deps, actions } = setup({ action: MOVE })

    await expect(decideAction(deps, MOVE.id, 'approved')).rejects.toBeInstanceOf(ActionNotExecutableError)

    expect(actions.get(MOVE.id)?.status).toBe('pending')
  })

  it('refuses a payload that is not an issue id and a state, and leaves it pending', async () => {
    const bad = makeAction({ kind: 'linear_move', payload: { issueId: 5 } })
    const { deps, actions } = setup({ action: bad })
    const linear = { moveToState: async () => 'moved' as const, targetState: 'In Progress' }

    await expect(decideAction({ ...deps, linear }, bad.id, 'approved')).rejects.toBeInstanceOf(ActionNotExecutableError)

    expect(actions.get(bad.id)?.status).toBe('pending')
  })

  it('still just records an approval for a kind with no executor', async () => {
    const { deps, calls } = setup({ action: makeAction() })

    expect((await decideAction(deps, makeAction().id, 'approved')).status).toBe('approved')
    expect(calls).toEqual(['decide approved'])
  })
})
