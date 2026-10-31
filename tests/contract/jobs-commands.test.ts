import {
  allowedActionsFor,
  cancelJob,
  confirmJob,
  decideAction,
  declineJob,
  reconsiderJob,
  retryJob,
  type CommandDeps,
  type CommandStore,
  type JobAction,
} from '../../src/jobs-commands'
import { assertTransition } from '../../src/transitions'
import { JOB_STATES, type Job, type JobState, type PendingAction } from '../../src/types'

const NOW = new Date('2026-03-04T05:06:07.000Z')
const JOB_ID = '3f2c8a10-5b7e-4c1d-9a64-0e1f2a3b4c5d'
const ACTION_ID = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

type TransitionOpts = Parameters<CommandStore['transitionJob']>[2]
type DecideOpts = Parameters<CommandStore['decideAction']>[2]
type Decision = 'approved' | 'rejected'
type JobCommand = (deps: CommandDeps, id: string) => Promise<Job>

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    source: 'linear',
    sourceId: 'lin-issue-8e41c2',
    ticketKey: 'TST-1',
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
    id: ACTION_ID,
    jobId: JOB_ID,
    kind: 'comment',
    payload: { body: 'hi' },
    status: 'pending',
    reason: null,
    createdAt: new Date('2026-03-04T04:00:00.000Z'),
    decidedAt: null,
    ...overrides,
  }
}

/**
 * In-memory CommandStore and CommandDeps that record every call. The store follows the documented port: it loads
 * rows, applies a move after re-checking the state machine edge, and returns the row it changed. The clock is fixed.
 * `events` records the order of side effects: a store write is logged when it starts and again when it finishes.
 */
function createHarness(seed: { jobs?: Job[]; actions?: PendingAction[] } = {}) {
  const jobs = new Map((seed.jobs ?? []).map((job) => [job.id, job] as const))
  const actions = new Map((seed.actions ?? []).map((action) => [action.id, action] as const))
  const events: string[] = []
  const transitions: Array<{ id: string; to: JobState; opts: TransitionOpts }> = []
  const decisions: Array<{ id: string; decision: Decision; opts: DecideOpts }> = []
  const enqueued: string[] = []
  const stopped: string[] = []

  const store: CommandStore = {
    getJob: async (id) => {
      await Promise.resolve()
      return jobs.get(id) ?? null
    },
    getAction: async (id) => {
      await Promise.resolve()
      return actions.get(id) ?? null
    },
    transitionJob: async (id, to, opts) => {
      events.push(`transition:${to}`)
      transitions.push({ id, to, opts })
      await Promise.resolve()
      const current = jobs.get(id)
      if (current === undefined) throw new Error(`fake store has no job ${id}`)
      assertTransition(current.state, to)
      const changed: Job = { ...current, state: to }
      jobs.set(id, changed)
      events.push(`transition:${to}:done`)
      return changed
    },
    decideAction: async (id, decision, opts) => {
      decisions.push({ id, decision, opts })
      await Promise.resolve()
      const current = actions.get(id)
      if (current === undefined) throw new Error(`fake store has no action ${id}`)
      if (current.status !== 'pending') throw new Error(`fake store: action ${id} is not pending`)
      const changed: PendingAction = { ...current, status: decision, reason: opts.reason ?? null, decidedAt: opts.now }
      actions.set(id, changed)
      return changed
    },
  }

  const deps: CommandDeps = {
    store,
    clock: () => NOW,
    enqueue: async (jobId) => {
      events.push('enqueue')
      enqueued.push(jobId)
      await Promise.resolve()
    },
    cancelRun: async (jobId) => {
      stopped.push(jobId)
      await Promise.resolve()
      events.push('cancelRun:done')
    },
  }

  return { deps, jobs, actions, events, transitions, decisions, enqueued, stopped }
}

function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items
  if (first === undefined || rest.length > 0) throw new Error(`expected exactly one item, got ${items.length}`)
  return first
}

function expectOrder(events: readonly string[], first: string, second: string): void {
  const trail = `events: ${events.join(', ')}`
  const firstAt = events.indexOf(first)
  const secondAt = events.indexOf(second)
  expect(firstAt, `${first} never happened (${trail})`).toBeGreaterThanOrEqual(0)
  expect(secondAt, `${second} never happened (${trail})`).toBeGreaterThanOrEqual(0)
  expect(firstAt, `${first} should come before ${second} (${trail})`).toBeLessThan(secondAt)
}

const sorted = (actions: readonly JobAction[]): JobAction[] => [...actions].sort()

const jobCommands: Array<{ name: string; from: JobState; to: JobState; run: JobCommand }> = [
  { name: 'confirmJob', from: 'proposed', to: 'queued', run: confirmJob },
  { name: 'declineJob', from: 'proposed', to: 'declined', run: (deps, id) => declineJob(deps, id, 'not now') },
  { name: 'reconsiderJob', from: 'declined', to: 'proposed', run: reconsiderJob },
  { name: 'retryJob', from: 'failed', to: 'queued', run: retryJob },
  { name: 'cancelJob', from: 'running', to: 'cancelled', run: cancelJob },
]

const commandFor: Record<JobAction, JobCommand> = {
  confirm: confirmJob,
  decline: (deps, id) => declineJob(deps, id, 'not now'),
  reconsider: reconsiderJob,
  retry: retryJob,
  cancel: cancelJob,
}

describe('allowedActionsFor', () => {
  it('offers confirm and decline for a proposed job', () => {
    expect(sorted(allowedActionsFor('proposed'))).toEqual(['confirm', 'decline'])
  })

  it('offers only reconsider for a declined job', () => {
    expect(allowedActionsFor('declined')).toEqual(['reconsider'])
  })

  it.each(['queued', 'claiming', 'running', 'pr_open', 'in_review', 'changes_requested'] as const)(
    'offers only cancel for a %s job',
    (state) => {
      expect(allowedActionsFor(state)).toEqual(['cancel'])
    },
  )

  it('offers retry for a failed job and no action outside retry and cancel', () => {
    const actions = allowedActionsFor('failed')
    expect(actions).toContain('retry')
    expect(actions.filter((action) => action !== 'retry' && action !== 'cancel')).toEqual([])
  })

  it('offers only retry for a cancelled job', () => {
    expect(allowedActionsFor('cancelled')).toEqual(['retry'])
  })

  it.each(['merged', 'done'] as const)('offers nothing for a %s job', (state) => {
    expect(allowedActionsFor(state)).toEqual([])
  })

  it.each(JOB_STATES)('lists only actions whose command accepts a %s job', async (state) => {
    for (const action of allowedActionsFor(state)) {
      const harness = createHarness({ jobs: [makeJob({ state })] })
      await expect(commandFor[action](harness.deps, JOB_ID), `${action} on a ${state} job`).resolves.toBeDefined()
    }
  })
})

describe('every job command', () => {
  it.each(jobCommands)('$name asks the store to move the job to $to', async ({ from, to, run }) => {
    const harness = createHarness({ jobs: [makeJob({ state: from })] })
    await run(harness.deps, JOB_ID)
    const transition = only(harness.transitions)
    expect(transition.id).toBe(JOB_ID)
    expect(transition.to).toBe(to)
  })

  it.each(jobCommands)('$name stamps the move with the clock reading', async ({ from, run }) => {
    const harness = createHarness({ jobs: [makeJob({ state: from })] })
    await run(harness.deps, JOB_ID)
    expect(only(harness.transitions).opts.now).toEqual(NOW)
  })

  it.each(jobCommands)('$name returns the job row the store changed', async ({ from, to, run }) => {
    const harness = createHarness({ jobs: [makeJob({ state: from })] })
    const result = await run(harness.deps, JOB_ID)
    expect(result).toEqual(harness.jobs.get(JOB_ID))
    expect(result.state).toBe(to)
  })
})

describe('confirmJob', () => {
  it('puts the job id on the queue once the row is queued', async () => {
    const harness = createHarness({ jobs: [makeJob({ state: 'proposed' })] })
    await confirmJob(harness.deps, JOB_ID)
    expect(harness.enqueued).toEqual([JOB_ID])
    expectOrder(harness.events, 'transition:queued:done', 'enqueue')
  })
})

describe('declineJob', () => {
  it('parks the job as declined with the reason it was given', async () => {
    const harness = createHarness({ jobs: [makeJob({ state: 'proposed' })] })
    await declineJob(harness.deps, JOB_ID, 'Out of scope for this quarter')
    const transition = only(harness.transitions)
    expect(transition.to).toBe('declined')
    expect(transition.opts.reason).toBe('Out of scope for this quarter')
  })

  it('queues nothing', async () => {
    const harness = createHarness({ jobs: [makeJob({ state: 'proposed' })] })
    await declineJob(harness.deps, JOB_ID, 'Out of scope for this quarter')
    expect(harness.enqueued).toEqual([])
  })
})

describe('retryJob', () => {
  it('puts the job id on the queue once the failed job is queued again', async () => {
    const harness = createHarness({ jobs: [makeJob({ state: 'failed', attempt: 3, failureKind: 'infra' })] })
    await retryJob(harness.deps, JOB_ID)
    expect(harness.enqueued).toEqual([JOB_ID])
    expectOrder(harness.events, 'transition:queued:done', 'enqueue')
  })

  it('retries a cancelled job the same way', async () => {
    const harness = createHarness({ jobs: [makeJob({ state: 'cancelled' })] })
    await retryJob(harness.deps, JOB_ID)
    expect(only(harness.transitions).to).toBe('queued')
    expect(harness.enqueued).toEqual([JOB_ID])
  })
})

describe('cancelJob', () => {
  it('stops the run before the row changes', async () => {
    const harness = createHarness({ jobs: [makeJob({ state: 'running', slot: 1 })] })
    await cancelJob(harness.deps, JOB_ID)
    expect(harness.stopped).toEqual([JOB_ID])
    expectOrder(harness.events, 'cancelRun:done', 'transition:cancelled')
  })

  it.each(['queued', 'claiming', 'running', 'pr_open', 'in_review', 'changes_requested'] as const)(
    'cancels a job that is %s',
    async (state) => {
      const harness = createHarness({ jobs: [makeJob({ state })] })
      const result = await cancelJob(harness.deps, JOB_ID)
      expect(only(harness.transitions).to).toBe('cancelled')
      expect(result.state).toBe('cancelled')
    },
  )
})

describe('decideAction', () => {
  it('approves a pending action through the store', async () => {
    const harness = createHarness({ actions: [makeAction()] })
    await decideAction(harness.deps, ACTION_ID, 'approved')
    const decision = only(harness.decisions)
    expect(decision.id).toBe(ACTION_ID)
    expect(decision.decision).toBe('approved')
  })

  it('rejects a pending action through the store', async () => {
    const harness = createHarness({ actions: [makeAction()] })
    await decideAction(harness.deps, ACTION_ID, 'rejected')
    const decision = only(harness.decisions)
    expect(decision.id).toBe(ACTION_ID)
    expect(decision.decision).toBe('rejected')
  })

  it('passes the reason given with the decision to the store', async () => {
    const harness = createHarness({ actions: [makeAction()] })
    await decideAction(harness.deps, ACTION_ID, 'rejected', 'wrong target')
    expect(only(harness.decisions).opts.reason).toBe('wrong target')
  })

  it('stamps the decision with the clock reading', async () => {
    const harness = createHarness({ actions: [makeAction()] })
    await decideAction(harness.deps, ACTION_ID, 'approved')
    expect(only(harness.decisions).opts.now).toEqual(NOW)
  })

  it('returns the action row the store changed', async () => {
    const harness = createHarness({ actions: [makeAction()] })
    const result = await decideAction(harness.deps, ACTION_ID, 'approved')
    expect(result).toEqual(harness.actions.get(ACTION_ID))
    expect(result.status).toBe('approved')
  })
})
