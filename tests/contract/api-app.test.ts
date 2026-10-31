import { createApp, type ApiCommands, type ApiReads, type AppDeps } from '../../src/api/app'
import { actionResponseSchema, jobResponseSchema } from '../../src/api/contract'
import { allowedActionsFor, type JobAction } from '../../src/jobs-commands'
import type { ActionSummary, JobSummary } from '../../src/jobs-queries'
import type { Envelope } from '../../src/runner/transcript'
import type { Job, JobState, PendingAction } from '../../src/types'

const TOKEN = 'steward-test-token-0123456789-abcdefghijklmnop'
const PORT = 4321
const NOW = new Date('2026-03-04T05:06:07.000Z')
const CREATED_AT = new Date('2026-03-04T04:00:00.000Z')
const JOB_A = '3f2c8a10-5b7e-4c1d-9a64-0e1f2a3b4c5d'
const JOB_B = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const JOB_C = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const ACTION_A = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const ACTION_B = 'b4a39281-7065-4f4e-9d3c-2b1a0f9e8d7c'
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const JOB_FIELDS = [
  'allowedActions',
  'attempt',
  'failureKind',
  'id',
  'maxAttempts',
  'nextRunAt',
  'slot',
  'source',
  'state',
  'ticketKey',
]

const LINE_1: Envelope = { seq: 1, ts: '2026-03-04T05:00:01.000Z', kind: 'system', data: { note: 'session started' } }
const LINE_2: Envelope = { seq: 2, ts: '2026-03-04T05:00:02.000Z', kind: 'assistant', data: { text: 'working on it' } }
const LINE_3: Envelope = { seq: 3, ts: '2026-03-04T05:00:03.000Z', kind: 'result', data: { ok: true } }

type App = ReturnType<typeof createApp>
type Seed = { jobs?: Job[]; actions?: PendingAction[] }
type Decision = 'approved' | 'rejected'

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

/** A job in wire shape, built the way the docs describe it: ISO dates, no source id, allowed actions by state. */
function summarizeJob(job: Job): JobSummary {
  return {
    id: job.id,
    ticketKey: job.ticketKey,
    source: job.source,
    state: job.state,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    slot: job.slot,
    nextRunAt: job.nextRunAt === null ? null : job.nextRunAt.toISOString(),
    failureKind: job.failureKind,
    allowedActions: allowedActionsFor(job.state),
  }
}

function summarizeAction(action: PendingAction): ActionSummary {
  return {
    id: action.id,
    jobId: action.jobId,
    kind: action.kind,
    payload: action.payload,
    status: action.status,
    reason: action.reason,
    createdAt: action.createdAt.toISOString(),
    decidedAt: action.decidedAt === null ? null : action.decidedAt.toISOString(),
  }
}

/**
 * One in-memory store behind both ports, so a command and a later read agree: whether a route builds its response
 * from the job the command returned or re-reads it through `reads.getJob`, it sees the same new state.
 * Rows are seeded newest first. Every call is recorded.
 */
function createWorld(seed: Seed = {}) {
  const jobs = new Map((seed.jobs ?? []).map((job) => [job.id, job] as const))
  const actions = new Map((seed.actions ?? []).map((action) => [action.id, action] as const))
  const getJobCalls: string[] = []
  const listJobsCalls: Array<Parameters<ApiReads['listJobs']>[0]> = []
  const listActionsCalls: Array<Parameters<ApiReads['listActions']>[0]> = []
  const confirmCalls: string[] = []
  const declineCalls: Array<{ id: string; reason: string }> = []
  const reconsiderCalls: string[] = []
  const retryCalls: string[] = []
  const cancelCalls: string[] = []
  const decideCalls: Array<{ id: string; decision: Decision; reason: string | undefined }> = []

  const moveJob = (id: string, to: JobState): Job => {
    const job = jobs.get(id)
    if (job === undefined) throw new Error(`fake world has no job ${id}`)
    const moved: Job = { ...job, state: to }
    jobs.set(id, moved)
    return moved
  }

  const reads: ApiReads = {
    getJob: async (id) => {
      getJobCalls.push(id)
      await Promise.resolve()
      const job = jobs.get(id)
      return job === undefined ? null : summarizeJob(job)
    },
    listJobs: async (filter) => {
      listJobsCalls.push(filter)
      await Promise.resolve()
      const matching = [...jobs.values()].filter((job) => filter?.state === undefined || job.state === filter.state)
      return (filter?.limit === undefined ? matching : matching.slice(0, filter.limit)).map((job) => summarizeJob(job))
    },
    listActions: async (filter) => {
      listActionsCalls.push(filter)
      await Promise.resolve()
      const matching = [...actions.values()].filter((a) => filter?.status === undefined || a.status === filter.status)
      return (filter?.limit === undefined ? matching : matching.slice(0, filter.limit)).map((a) => summarizeAction(a))
    },
  }

  const commands: ApiCommands = {
    confirm: async (id) => {
      confirmCalls.push(id)
      await Promise.resolve()
      return moveJob(id, 'queued')
    },
    decline: async (id, reason) => {
      declineCalls.push({ id, reason })
      await Promise.resolve()
      return moveJob(id, 'declined')
    },
    reconsider: async (id) => {
      reconsiderCalls.push(id)
      await Promise.resolve()
      return moveJob(id, 'proposed')
    },
    retry: async (id) => {
      retryCalls.push(id)
      await Promise.resolve()
      return moveJob(id, 'queued')
    },
    cancel: async (id) => {
      cancelCalls.push(id)
      await Promise.resolve()
      return moveJob(id, 'cancelled')
    },
    decideAction: async (id, decision, reason) => {
      decideCalls.push({ id, decision, reason })
      await Promise.resolve()
      const action = actions.get(id)
      if (action === undefined) throw new Error(`fake world has no action ${id}`)
      const decided: PendingAction = { ...action, status: decision, reason: reason ?? null, decidedAt: NOW }
      actions.set(id, decided)
      return decided
    },
  }

  const calls = {
    getJob: getJobCalls,
    listJobs: listJobsCalls,
    listActions: listActionsCalls,
    confirm: confirmCalls,
    decline: declineCalls,
    reconsider: reconsiderCalls,
    retry: retryCalls,
    cancel: cancelCalls,
    decide: decideCalls,
  }

  return { reads, commands, calls }
}

function configWith(overrides: Partial<AppDeps['config']> = {}): AppDeps['config'] {
  return { apiToken: TOKEN, port: PORT, allowedOrigins: [], allowedHosts: [], ...overrides }
}

function setup(seed: Seed = {}, overrides: Partial<AppDeps> = {}) {
  const world = createWorld(seed)
  const app = createApp({
    reads: world.reads,
    commands: world.commands,
    readLog: () => Promise.resolve([]),
    config: configWith(),
    sleep: () => Promise.resolve(),
    ...overrides,
  })
  return { app, world }
}

type CallOptions = {
  method?: 'GET' | 'POST'
  host?: string
  headers?: Record<string, string>
  json?: unknown
}

/** Sends a request with the bearer token and a Host that matches the URL, as a local client would. */
async function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  const host = options.host ?? `127.0.0.1:${PORT}`
  const headers: Record<string, string> = { host, authorization: `Bearer ${TOKEN}`, ...options.headers }
  if (options.json !== undefined) headers['content-type'] = 'application/json'
  const init: RequestInit = { method: options.method ?? 'GET', headers }
  if (options.json !== undefined) init.body = JSON.stringify(options.json)
  return await app.request(`http://${host}${path}`, init)
}

async function bodyOf(res: Response): Promise<unknown> {
  return await res.json()
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a JSON object')
  return Object.fromEntries(Object.entries(value))
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

type Frame = { id: string | undefined; data: string }

/** The complete SSE frames in `text`: blocks ended by a blank line. A trailing partial block is dropped. */
function parseFrames(text: string): Frame[] {
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n')
  blocks.pop()
  const frames: Frame[] = []
  for (const block of blocks) {
    let id: string | undefined
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const raw = colon === -1 ? '' : line.slice(colon + 1)
      const value = raw.startsWith(' ') ? raw.slice(1) : raw
      if (field === 'id') id = value
      if (field === 'data') data.push(value)
    }
    if (data.length > 0) frames.push({ id, data: data.join('\n') })
  }
  return frames
}

/** Reads the open stream until `count` complete frames have arrived, then disconnects like a client that left. */
async function readFrames(res: Response, count: number): Promise<Frame[]> {
  if (res.body === null) throw new Error('the response has no body to read')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (parseFrames(text).length < count) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel()
  }
  return parseFrames(text)
}

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/**
 * An app whose readLog serves `initial` filtered to `seq > afterSeq`, as documented, and records every call. The sleep
 * stub yields to the event loop and appends `later` on its first call, simulating lines written during the pause.
 * Once the test is over it never settles, so a poll loop that outlives the test cannot spin.
 */
function setupLog(initial: readonly Envelope[], later: readonly Envelope[] = []) {
  const lines = [...initial]
  const readLogCalls: Array<{ jobId: string; afterSeq: number }> = []
  let pending = [...later]
  let over = false
  cleanups.push(() => {
    over = true
  })

  const { app } = setup(
    { jobs: [makeJob({ id: JOB_A, state: 'running' })] },
    {
      readLog: async (jobId, afterSeq) => {
        readLogCalls.push({ jobId, afterSeq })
        await Promise.resolve()
        return lines.filter((line) => line.seq > afterSeq)
      },
      sleep: () => {
        if (over) return new Promise<void>(() => undefined)
        lines.push(...pending)
        pending = []
        return new Promise<void>((resolve) => {
          setImmediate(resolve)
        })
      },
    },
  )
  return { app, readLogCalls }
}

const jobRoutes = [
  { action: 'confirm', from: 'proposed', to: 'queued' },
  { action: 'reconsider', from: 'declined', to: 'proposed' },
  { action: 'retry', from: 'failed', to: 'queued' },
  { action: 'cancel', from: 'running', to: 'cancelled' },
] as const

describe('GET /v1/jobs', () => {
  it('lists the jobs from the read layer as wire-shape jobs, in the order it returns them', async () => {
    const jobs = [
      makeJob({ id: JOB_C, ticketKey: 'TST-3', state: 'running', slot: 0, attempt: 1 }),
      makeJob({ id: JOB_B, ticketKey: 'TST-2', state: 'queued' }),
      makeJob({ id: JOB_A, ticketKey: 'TST-1', state: 'proposed' }),
    ]
    const { app } = setup({ jobs })

    const res = await call(app, '/v1/jobs')

    expect(res.ok).toBe(true)
    expect(jobResponseSchema.array().parse(await bodyOf(res))).toEqual(jobs.map((job) => summarizeJob(job)))
  })

  it('passes the state query to the read layer and lists only that state', async () => {
    const jobs = [makeJob({ id: JOB_B, state: 'queued' }), makeJob({ id: JOB_A, state: 'proposed' })]
    const { app, world } = setup({ jobs })

    const res = await call(app, '/v1/jobs?state=proposed')

    expect(res.ok).toBe(true)
    const [filter] = world.calls.listJobs
    expect(filter?.state).toBe('proposed')
    expect(
      jobResponseSchema
        .array()
        .parse(await bodyOf(res))
        .map((job) => job.id),
    ).toEqual([JOB_A])
  })

  it('passes the limit query to the read layer as a number', async () => {
    const jobs = [makeJob({ id: JOB_C }), makeJob({ id: JOB_B }), makeJob({ id: JOB_A })]
    const { app, world } = setup({ jobs })

    const res = await call(app, '/v1/jobs?limit=2')

    expect(res.ok).toBe(true)
    const [filter] = world.calls.listJobs
    expect(filter?.limit).toBe(2)
    expect(
      jobResponseSchema
        .array()
        .parse(await bodyOf(res))
        .map((job) => job.id),
    ).toEqual([JOB_C, JOB_B])
  })
})

describe('GET /v1/jobs/:id', () => {
  it('returns the job the read layer finds, as a wire-shape job', async () => {
    const job = makeJob({ id: JOB_A, ticketKey: 'TST-1', state: 'running', slot: 1, attempt: 1 })
    const { app } = setup({ jobs: [job, makeJob({ id: JOB_B, ticketKey: 'TST-2' })] })

    const res = await call(app, `/v1/jobs/${JOB_A}`)

    expect(res.ok).toBe(true)
    expect(jobResponseSchema.parse(await bodyOf(res))).toEqual(summarizeJob(job))
  })
})

describe('POST /v1/jobs/:id/{confirm,reconsider,retry,cancel}', () => {
  it.each(jobRoutes)('POST /v1/jobs/:id/$action runs the $action command for the job in the path', async (route) => {
    const { app, world } = setup({ jobs: [makeJob({ id: JOB_A, state: route.from })] })

    const res = await call(app, `/v1/jobs/${JOB_A}/${route.action}`, { method: 'POST' })

    expect(res.ok).toBe(true)
    expect(world.calls[route.action]).toEqual([JOB_A])
  })

  it.each(jobRoutes)('POST /v1/jobs/:id/$action responds with the job in its new state, $to', async (route) => {
    const { app } = setup({ jobs: [makeJob({ id: JOB_A, state: route.from })] })

    const res = await call(app, `/v1/jobs/${JOB_A}/${route.action}`, { method: 'POST' })

    const job = jobResponseSchema.parse(await bodyOf(res))
    expect(job.id).toBe(JOB_A)
    expect(job.state).toBe(route.to)
  })

  it.each(jobRoutes)('POST /v1/jobs/:id/$action lists the actions its new state allows', async (route) => {
    const { app } = setup({ jobs: [makeJob({ id: JOB_A, state: route.from })] })

    const res = await call(app, `/v1/jobs/${JOB_A}/${route.action}`, { method: 'POST' })

    const job = jobResponseSchema.parse(await bodyOf(res))
    expect(sorted(job.allowedActions)).toEqual(sorted(allowedActionsFor(route.to)))
  })

  it('responds with exactly the documented job fields and no tracker source id', async () => {
    const { app } = setup({ jobs: [makeJob({ id: JOB_A, state: 'proposed', sourceId: 'lin-issue-8e41c2' })] })

    const res = await call(app, `/v1/jobs/${JOB_A}/confirm`, { method: 'POST' })

    const body = asRecord(await bodyOf(res))
    expect(Object.keys(body).sort()).toEqual([...JOB_FIELDS].sort())
    expect(JSON.stringify(body)).not.toContain('lin-issue-8e41c2')
  })
})

describe('POST /v1/jobs/:id/decline', () => {
  it('runs the decline command with the job id and the reason from the JSON body', async () => {
    const { app, world } = setup({ jobs: [makeJob({ id: JOB_A, state: 'proposed' })] })

    const res = await call(app, `/v1/jobs/${JOB_A}/decline`, { method: 'POST', json: { reason: 'not this quarter' } })

    expect(res.ok).toBe(true)
    expect(world.calls.decline).toEqual([{ id: JOB_A, reason: 'not this quarter' }])
  })

  it('responds with the declined job and the actions that state allows', async () => {
    const { app } = setup({ jobs: [makeJob({ id: JOB_A, state: 'proposed' })] })

    const res = await call(app, `/v1/jobs/${JOB_A}/decline`, { method: 'POST', json: { reason: 'not this quarter' } })

    const job = jobResponseSchema.parse(await bodyOf(res))
    expect(job.id).toBe(JOB_A)
    expect(job.state).toBe('declined')
    expect(sorted(job.allowedActions)).toEqual(sorted(allowedActionsFor('declined')))
  })
})

describe('GET /v1/actions', () => {
  it('passes the status query to the read layer and lists only that status', async () => {
    const actions = [
      makeAction({ id: ACTION_B, status: 'approved', decidedAt: NOW }),
      makeAction({ id: ACTION_A, status: 'pending' }),
    ]
    const { app, world } = setup({ actions })

    const res = await call(app, '/v1/actions?status=pending')

    expect(res.ok).toBe(true)
    const [filter] = world.calls.listActions
    expect(filter?.status).toBe('pending')
    expect(
      actionResponseSchema
        .array()
        .parse(await bodyOf(res))
        .map((action) => action.id),
    ).toEqual([ACTION_A])
  })

  it('lists the actions from the read layer as wire-shape actions with ISO dates', async () => {
    const decided = makeAction({ id: ACTION_B, status: 'approved', reason: 'ok', decidedAt: NOW })
    const { app } = setup({ actions: [decided, makeAction({ id: ACTION_A, status: 'pending' })] })

    const res = await call(app, '/v1/actions?status=approved')

    expect(res.ok).toBe(true)
    const [action] = actionResponseSchema.array().parse(await bodyOf(res))
    expect(present(action)).toEqual(summarizeAction(decided))
    expectIsoOf(present(action).createdAt, CREATED_AT)
    expectIsoOf(present(action).decidedAt, NOW)
  })
})

describe('POST /v1/actions/:id/approve', () => {
  it('runs the decide command with the approved decision for the action in the path', async () => {
    const { app, world } = setup({ actions: [makeAction({ id: ACTION_A })] })

    const res = await call(app, `/v1/actions/${ACTION_A}/approve`, { method: 'POST' })

    expect(res.ok).toBe(true)
    const [decision] = world.calls.decide
    expect(decision?.id).toBe(ACTION_A)
    expect(decision?.decision).toBe('approved')
  })

  it('responds with the decided action: approved, dates as ISO strings', async () => {
    const { app } = setup({ actions: [makeAction({ id: ACTION_A, payload: { body: 'hi' } })] })

    const res = await call(app, `/v1/actions/${ACTION_A}/approve`, { method: 'POST' })

    const action = actionResponseSchema.parse(await bodyOf(res))
    expect(action.id).toBe(ACTION_A)
    expect(action.jobId).toBe(JOB_A)
    expect(action.status).toBe('approved')
    expect(action.payload).toEqual({ body: 'hi' })
    expectIsoOf(action.createdAt, CREATED_AT)
    expectIsoOf(action.decidedAt, NOW)
  })
})

describe('POST /v1/actions/:id/reject', () => {
  it('runs the decide command with the rejected decision and the reason from the JSON body', async () => {
    const { app, world } = setup({ actions: [makeAction({ id: ACTION_A })] })

    const res = await call(app, `/v1/actions/${ACTION_A}/reject`, { method: 'POST', json: { reason: 'wrong target' } })

    expect(res.ok).toBe(true)
    expect(world.calls.decide).toEqual([{ id: ACTION_A, decision: 'rejected', reason: 'wrong target' }])
  })

  it('responds with the rejected action carrying the reason', async () => {
    const { app } = setup({ actions: [makeAction({ id: ACTION_A })] })

    const res = await call(app, `/v1/actions/${ACTION_A}/reject`, { method: 'POST', json: { reason: 'wrong target' } })

    const action = actionResponseSchema.parse(await bodyOf(res))
    expect(action.id).toBe(ACTION_A)
    expect(action.status).toBe('rejected')
    expect(action.reason).toBe('wrong target')
    expectIsoOf(action.decidedAt, NOW)
  })

  it('rejects an action when the JSON body carries no reason', async () => {
    const { app, world } = setup({ actions: [makeAction({ id: ACTION_A })] })

    const res = await call(app, `/v1/actions/${ACTION_A}/reject`, { method: 'POST', json: {} })

    expect(res.ok).toBe(true)
    const [decision] = world.calls.decide
    expect(decision?.id).toBe(ACTION_A)
    expect(decision?.decision).toBe('rejected')
  })
})

describe('GET /v1/jobs/:id/log', () => {
  it('answers with an event stream', async () => {
    const { app } = setupLog([LINE_1, LINE_2])

    const res = await call(app, `/v1/jobs/${JOB_A}/log`)

    expect(res.ok).toBe(true)
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream')
    await res.body?.cancel()
  })

  it('streams each envelope as the data of one frame whose id is its seq', async () => {
    const { app } = setupLog([LINE_1, LINE_2, LINE_3])

    const res = await call(app, `/v1/jobs/${JOB_A}/log?after=1`)

    const frames = await readFrames(res, 2)
    expect(frames.map((frame) => frame.id)).toEqual(['2', '3'])
    expect(frames.map((frame) => JSON.parse(frame.data))).toEqual([LINE_2, LINE_3])
  })

  it('reads the log of the job named in the path', async () => {
    const { app, readLogCalls } = setupLog([LINE_1, LINE_2])

    const res = await call(app, `/v1/jobs/${JOB_A}/log?after=1`)
    await readFrames(res, 1)

    const [first] = readLogCalls
    expect(first?.jobId).toBe(JOB_A)
  })

  it('resumes after the seq in the Last-Event-ID header', async () => {
    const { app } = setupLog([LINE_1, LINE_2, LINE_3])

    const res = await call(app, `/v1/jobs/${JOB_A}/log`, { headers: { 'last-event-id': '2' } })

    const frames = await readFrames(res, 1)
    expect(frames.map((frame) => frame.id)).toEqual(['3'])
    expect(frames.map((frame) => JSON.parse(frame.data))).toEqual([LINE_3])
  })

  it('resumes after the seq in the after query parameter', async () => {
    const { app } = setupLog([LINE_1, LINE_2, LINE_3])

    const res = await call(app, `/v1/jobs/${JOB_A}/log?after=2`)

    const frames = await readFrames(res, 1)
    expect(frames.map((frame) => frame.id)).toEqual(['3'])
    expect(frames.map((frame) => JSON.parse(frame.data))).toEqual([LINE_3])
  })

  it('keeps polling and streams a line that is written after the first batch', async () => {
    const { app } = setupLog([LINE_1, LINE_2], [LINE_3])

    const res = await call(app, `/v1/jobs/${JOB_A}/log?after=1`)

    const frames = await readFrames(res, 2)
    expect(frames.map((frame) => frame.id)).toEqual(['2', '3'])
    expect(frames.map((frame) => JSON.parse(frame.data))).toEqual([LINE_2, LINE_3])
  })
})

describe('the local guard on a request that carries the bearer token', () => {
  it('serves a request whose Host is localhost:<port>', async () => {
    const { app } = setup()

    const res = await call(app, '/v1/jobs', { host: `localhost:${PORT}` })

    expect(res.ok).toBe(true)
  })

  it('serves a request whose Host is one of the allowedHosts', async () => {
    const { app } = setup({}, { config: configWith({ allowedHosts: ['steward.example.test:8443'] }) })

    const res = await call(app, '/v1/jobs', { host: 'steward.example.test:8443' })

    expect(res.ok).toBe(true)
  })

  it('serves a request whose Origin is one of the allowedOrigins', async () => {
    const { app } = setup({}, { config: configWith({ allowedOrigins: ['https://dashboard.example.test'] }) })

    const res = await call(app, '/v1/jobs', { headers: { origin: 'https://dashboard.example.test' } })

    expect(res.ok).toBe(true)
  })
})
