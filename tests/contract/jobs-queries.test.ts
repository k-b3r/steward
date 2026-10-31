import { actionResponseSchema, jobResponseSchema } from '../../src/api/contract'
import { allowedActionsFor, type JobAction } from '../../src/jobs-commands'
import { getJob, listActions, listJobs, toActionSummary, type QueryDeps, type QueryStore } from '../../src/jobs-queries'
import { JOB_STATES, type Job, type PendingAction } from '../../src/types'

const JOB_A = '3f2c8a10-5b7e-4c1d-9a64-0e1f2a3b4c5d'
const JOB_B = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const JOB_C = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const ACTION_A = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const ACTION_B = 'b4a39281-7065-4f4e-9d3c-2b1a0f9e8d7c'
const ACTION_C = 'e5f60718-293a-4b4c-8d5e-6f708192a3b4'

const CREATED_AT = new Date('2026-03-04T04:00:00.000Z')
const DECIDED_AT = new Date('2026-03-04T04:30:00.000Z')
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

type JobFilter = Parameters<QueryStore['listJobs']>[0]
type ActionFilter = Parameters<QueryStore['listActions']>[0]

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_A,
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
    id: ACTION_A,
    jobId: JOB_A,
    kind: 'comment',
    payload: { body: 'hi' },
    status: 'pending',
    reason: null,
    createdAt: CREATED_AT,
    decidedAt: null,
    ...overrides,
  }
}

/**
 * In-memory QueryStore. Rows are seeded newest first, which is the order the port promises to return them in.
 * The list methods honour `state` / `status` and `limit`, and every call's filter is recorded.
 */
function createStore(seed: { jobs?: Job[]; actions?: PendingAction[] } = {}) {
  const jobs = seed.jobs ?? []
  const actions = seed.actions ?? []
  const getCalls: string[] = []
  const listJobsCalls: JobFilter[] = []
  const listActionsCalls: ActionFilter[] = []

  const store: QueryStore = {
    getJob: async (id) => {
      getCalls.push(id)
      await Promise.resolve()
      return jobs.find((job) => job.id === id) ?? null
    },
    listJobs: async (filter) => {
      listJobsCalls.push(filter)
      await Promise.resolve()
      const matching = jobs.filter((job) => filter?.state === undefined || job.state === filter.state)
      return filter?.limit === undefined ? matching : matching.slice(0, filter.limit)
    },
    listActions: async (filter) => {
      listActionsCalls.push(filter)
      await Promise.resolve()
      const matching = actions.filter((action) => filter?.status === undefined || action.status === filter.status)
      return filter?.limit === undefined ? matching : matching.slice(0, filter.limit)
    },
  }
  const deps: QueryDeps = { store }

  return { deps, getCalls, listJobsCalls, listActionsCalls }
}

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value, got nothing')
  return value
}

/** An ISO 8601 UTC date-time string that names the same instant as `date`. */
function expectIsoOf(value: string | null, date: Date): void {
  expect(typeof value).toBe('string')
  expect(value ?? '').toMatch(ISO_DATE_TIME)
  expect(new Date(value ?? '').getTime()).toBe(date.getTime())
}

const sorted = (actions: readonly JobAction[]): JobAction[] => [...actions].sort()

describe('getJob', () => {
  it('returns the job as a summary with exactly the documented fields', async () => {
    const job = makeJob({ id: JOB_A, ticketKey: 'TST-7', state: 'running', attempt: 1, maxAttempts: 3, slot: 2 })
    const { deps } = createStore({ jobs: [job] })

    const summary = present(await getJob(deps, JOB_A))

    expect(summary).toEqual({
      id: JOB_A,
      ticketKey: 'TST-7',
      source: 'linear',
      state: 'running',
      attempt: 1,
      maxAttempts: 3,
      slot: 2,
      nextRunAt: null,
      failureKind: null,
      allowedActions: summary.allowedActions,
    })
  })

  it('reads the job the id names', async () => {
    const rows = [makeJob({ id: JOB_A }), makeJob({ id: JOB_B, ticketKey: 'TST-2' })]
    const { deps, getCalls } = createStore({ jobs: rows })

    const summary = present(await getJob(deps, JOB_B))

    expect(summary.id).toBe(JOB_B)
    expect(summary.ticketKey).toBe('TST-2')
    expect(getCalls).toContain(JOB_B)
  })

  it('renders nextRunAt as an ISO string', async () => {
    const retryAt = new Date('2026-03-04T05:16:07.000Z')
    const job = makeJob({ state: 'queued', attempt: 1, failureKind: 'infra', nextRunAt: retryAt })
    const { deps } = createStore({ jobs: [job] })

    const summary = present(await getJob(deps, JOB_A))

    expectIsoOf(summary.nextRunAt, retryAt)
  })

  it('keeps nextRunAt null when no retry is scheduled', async () => {
    const { deps } = createStore({ jobs: [makeJob({ state: 'queued', nextRunAt: null })] })

    const summary = present(await getJob(deps, JOB_A))

    expect(summary.nextRunAt).toBeNull()
  })

  it('carries the failure kind of a failed job', async () => {
    const { deps } = createStore({ jobs: [makeJob({ state: 'failed', attempt: 1, failureKind: 'setup' })] })

    const summary = present(await getJob(deps, JOB_A))

    expect(summary.state).toBe('failed')
    expect(summary.failureKind).toBe('setup')
  })

  it('leaves the tracker source id out of the summary', async () => {
    const { deps } = createStore({ jobs: [makeJob({ sourceId: 'lin-issue-8e41c2' })] })

    const summary = present(await getJob(deps, JOB_A))

    expect(summary).not.toHaveProperty('sourceId')
    expect(JSON.stringify(summary)).not.toContain('lin-issue-8e41c2')
  })

  it.each(JOB_STATES)('derives allowedActions from the %s state', async (state) => {
    const { deps } = createStore({ jobs: [makeJob({ state })] })

    const summary = present(await getJob(deps, JOB_A))

    expect(sorted(summary.allowedActions)).toEqual(sorted(allowedActionsFor(state)))
  })

  it('produces a summary that satisfies the API job response schema', async () => {
    const retryAt = new Date('2026-03-04T05:16:07.000Z')
    const job = makeJob({ state: 'queued', attempt: 1, failureKind: 'infra', nextRunAt: retryAt })
    const { deps } = createStore({ jobs: [job] })

    const summary = present(await getJob(deps, JOB_A))

    expect(() => jobResponseSchema.parse(summary)).not.toThrow()
  })
})

describe('listJobs', () => {
  it('returns one summary per stored row, in the order the store returned them', async () => {
    const rows = [
      makeJob({ id: JOB_C, ticketKey: 'TST-3' }),
      makeJob({ id: JOB_B, ticketKey: 'TST-2' }),
      makeJob({ id: JOB_A, ticketKey: 'TST-1' }),
    ]
    const { deps } = createStore({ jobs: rows })

    const summaries = await listJobs(deps)

    expect(summaries.map((summary) => summary.id)).toEqual([JOB_C, JOB_B, JOB_A])
    expect(summaries.map((summary) => summary.ticketKey)).toEqual(['TST-3', 'TST-2', 'TST-1'])
  })

  it('gives each summary the allowed actions of its own state', async () => {
    const rows = [makeJob({ id: JOB_B, state: 'running' }), makeJob({ id: JOB_A, state: 'proposed' })]
    const { deps } = createStore({ jobs: rows })

    const summaries = await listJobs(deps)

    expect(summaries.map((summary) => sorted(summary.allowedActions))).toEqual([
      sorted(allowedActionsFor('running')),
      sorted(allowedActionsFor('proposed')),
    ])
  })

  it('passes the state filter to the store and returns only that state', async () => {
    const rows = [
      makeJob({ id: JOB_C, state: 'queued' }),
      makeJob({ id: JOB_B, state: 'proposed' }),
      makeJob({ id: JOB_A, state: 'proposed' }),
    ]
    const { deps, listJobsCalls } = createStore({ jobs: rows })

    const summaries = await listJobs(deps, { state: 'proposed' })

    const [filter] = listJobsCalls
    expect(filter?.state).toBe('proposed')
    expect(summaries.map((summary) => summary.id)).toEqual([JOB_B, JOB_A])
  })

  it('passes the limit the caller gives straight to the store', async () => {
    const rows = [makeJob({ id: JOB_C }), makeJob({ id: JOB_B }), makeJob({ id: JOB_A })]
    const { deps, listJobsCalls } = createStore({ jobs: rows })

    const summaries = await listJobs(deps, { limit: 2 })

    const [filter] = listJobsCalls
    expect(filter?.limit).toBe(2)
    expect(summaries.map((summary) => summary.id)).toEqual([JOB_C, JOB_B])
  })

  it('asks the store for 100 rows when the caller gives no limit', async () => {
    const { deps, listJobsCalls } = createStore({ jobs: [makeJob()] })

    await listJobs(deps)

    const [filter] = listJobsCalls
    expect(filter?.limit).toBe(100)
  })
})

describe('listActions', () => {
  it('maps a pending action to a summary with an ISO createdAt and no decision yet', async () => {
    const { deps } = createStore({ actions: [makeAction({ kind: 'comment', payload: { body: 'hi' } })] })

    const [summary] = await listActions(deps)

    const action = present(summary)
    expect(action).toEqual({
      id: ACTION_A,
      jobId: JOB_A,
      kind: 'comment',
      payload: { body: 'hi' },
      status: 'pending',
      reason: null,
      createdAt: action.createdAt,
      decidedAt: null,
    })
    expectIsoOf(action.createdAt, CREATED_AT)
  })

  it('maps a decided action to a summary with an ISO decidedAt and its reason', async () => {
    const decided = makeAction({ status: 'rejected', reason: 'wrong target', decidedAt: DECIDED_AT })
    const { deps } = createStore({ actions: [decided] })

    const [summary] = await listActions(deps)

    const action = present(summary)
    expect(action.status).toBe('rejected')
    expect(action.reason).toBe('wrong target')
    expectIsoOf(action.decidedAt, DECIDED_AT)
  })

  it('leaves the payload as the JSON it was stored as', async () => {
    const payload = { target: 'TST-1', labels: ['a', 'b'], nested: { count: 1, ok: true, none: null } }
    const { deps } = createStore({ actions: [makeAction({ kind: 'close_pr', payload })] })

    const [summary] = await listActions(deps)

    expect(present(summary).payload).toEqual(payload)
  })

  it('passes the status filter to the store and returns only that status', async () => {
    const actions = [
      makeAction({ id: ACTION_C, status: 'approved', decidedAt: DECIDED_AT }),
      makeAction({ id: ACTION_B, status: 'pending' }),
      makeAction({ id: ACTION_A, status: 'pending' }),
    ]
    const { deps, listActionsCalls } = createStore({ actions })

    const summaries = await listActions(deps, { status: 'pending' })

    const [filter] = listActionsCalls
    expect(filter?.status).toBe('pending')
    expect(summaries.map((summary) => summary.id)).toEqual([ACTION_B, ACTION_A])
  })

  it('returns the summaries in the order the store returned them', async () => {
    const actions = [makeAction({ id: ACTION_C }), makeAction({ id: ACTION_B }), makeAction({ id: ACTION_A })]
    const { deps } = createStore({ actions })

    const summaries = await listActions(deps)

    expect(summaries.map((summary) => summary.id)).toEqual([ACTION_C, ACTION_B, ACTION_A])
  })

  it('passes the limit the caller gives straight to the store', async () => {
    const actions = [makeAction({ id: ACTION_C }), makeAction({ id: ACTION_B }), makeAction({ id: ACTION_A })]
    const { deps, listActionsCalls } = createStore({ actions })

    const summaries = await listActions(deps, { limit: 1 })

    const [filter] = listActionsCalls
    expect(filter?.limit).toBe(1)
    expect(summaries.map((summary) => summary.id)).toEqual([ACTION_C])
  })

  it('produces summaries that satisfy the API action response schema', async () => {
    const decided = makeAction({ id: ACTION_B, status: 'approved', decidedAt: DECIDED_AT })
    const { deps } = createStore({ actions: [decided, makeAction({ id: ACTION_A })] })

    const summaries = await listActions(deps)

    expect(() => actionResponseSchema.array().parse(summaries)).not.toThrow()
  })
})

describe('toActionSummary', () => {
  it('maps an action of any status to its summary, dates as ISO strings', () => {
    const summary = toActionSummary(makeAction({ status: 'approved', reason: 'ok', decidedAt: DECIDED_AT }))

    expect(summary).toEqual({
      id: ACTION_A,
      jobId: JOB_A,
      kind: 'comment',
      payload: { body: 'hi' },
      status: 'approved',
      reason: 'ok',
      createdAt: summary.createdAt,
      decidedAt: summary.decidedAt,
    })
    expectIsoOf(summary.createdAt, CREATED_AT)
    expectIsoOf(summary.decidedAt, DECIDED_AT)
  })
})
