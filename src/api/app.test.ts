import { describe, expect, it, vi } from 'vitest'

import { assertTransition } from '../transitions'
import type { Job, JobState } from '../types'
import type { PendingAction } from '../db/store'
import type { Envelope } from '../runner/transcript'
import {
  cancelJob,
  confirmJob,
  decideAction as decideActionCommand,
  declineJob,
  reconsiderJob,
  retryJob,
  type CommandStore,
} from '../jobs-commands'
import { createApp, type ApiCommands, type ApiQueries, type AppDeps } from './app'

const TOKEN = 'test-token-0123456789abcdef0123456789'
const PORT = 3000
const ORIGIN = 'http://dashboard.local:5173'
const CLOCK = new Date('2026-01-02T03:04:05.000Z')

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_JOB_ID = '22222222-2222-4222-8222-222222222222'
const ACTION_ID = '33333333-3333-4333-8333-333333333333'
const MISSING_JOB_ID = '99999999-9999-4999-8999-999999999999'
const MISSING_ACTION_ID = '88888888-8888-4888-8888-888888888888'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
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
    id: ACTION_ID,
    jobId: JOB_ID,
    kind: 'comment',
    payload: { body: 'hello' },
    status: 'pending',
    reason: null,
    createdAt: CLOCK,
    decidedAt: null,
    ...overrides,
  }
}

type FakeStore = ApiQueries &
  CommandStore & {
    jobs: Map<string, Job>
    actions: Map<string, PendingAction>
    transitions: { id: string; to: JobState; reason?: string; at: Date }[]
    decisions: { id: string; decision: 'approved' | 'rejected'; reason?: string }[]
  }

function createFakeStore(options: { jobs?: Job[]; actions?: PendingAction[] } = {}): FakeStore {
  const jobs = new Map((options.jobs ?? []).map((job) => [job.id, job]))
  const actions = new Map((options.actions ?? []).map((action) => [action.id, action]))
  const transitions: { id: string; to: JobState; reason?: string; at: Date }[] = []
  const decisions: { id: string; decision: 'approved' | 'rejected'; reason?: string }[] = []

  return {
    jobs,
    actions,
    transitions,
    decisions,
    async getJob(id) {
      return jobs.get(id) ?? null
    },
    async listJobs(filter = {}) {
      return [...jobs.values()].filter((job) => filter.state === undefined || job.state === filter.state)
    },
    async transitionJob(id, to, opts) {
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`Unknown job id: ${id}`)
      assertTransition(job.state, to)
      const updated = { ...job, state: to }
      jobs.set(id, updated)
      transitions.push({ id, to, reason: opts.reason, at: opts.now })
      return updated
    },
    async listActions(filter = {}) {
      return [...actions.values()].filter((action) => filter.status === undefined || action.status === filter.status)
    },
    async getAction(id) {
      return actions.get(id) ?? null
    },
    async decideAction(id, decision, opts) {
      const action = actions.get(id)
      if (action === undefined) throw new Error(`Unknown pending action: ${id}`)
      if (action.status !== 'pending') throw new Error(`Pending action ${id} is ${action.status}, not pending`)
      const updated = { ...action, status: decision, reason: opts.reason ?? null, decidedAt: opts.now }
      actions.set(id, updated)
      decisions.push({ id, decision, reason: opts.reason })
      return updated
    },
  }
}

type Setup = {
  app: ReturnType<typeof createApp>
  store: ReturnType<typeof createFakeStore>
  enqueued: string[]
  cancelled: string[]
  readLogCalls: { jobId: string; afterSeq: number }[]
}

function setup(
  options: {
    jobs?: Job[]
    actions?: PendingAction[]
    readLog?: (jobId: string, afterSeq: number) => Promise<Envelope[]>
    sleep?: AppDeps['sleep']
  } = {},
): Setup {
  const store = createFakeStore({ jobs: options.jobs, actions: options.actions })
  const enqueued: string[] = []
  const cancelled: string[] = []
  const readLogCalls: { jobId: string; afterSeq: number }[] = []

  // The routes call the real commands, so the rules they enforce are tested here too.
  const commandDeps = {
    store: store as unknown as CommandStore,
    clock: () => CLOCK,
    enqueue: async (jobId: string) => {
      enqueued.push(jobId)
    },
    cancelRun: async (jobId: string) => {
      cancelled.push(jobId)
    },
  }
  const commands: ApiCommands = {
    confirm: (id) => confirmJob(commandDeps, id),
    decline: (id, reason) => declineJob(commandDeps, id, reason),
    reconsider: (id) => reconsiderJob(commandDeps, id),
    retry: (id) => retryJob(commandDeps, id),
    cancel: (id) => cancelJob(commandDeps, id),
    decideAction: (id, decision, reason) => decideActionCommand(commandDeps, id, decision, reason),
  }

  const app = createApp({
    queries: store,
    commands,
    readLog: async (jobId, afterSeq) => {
      readLogCalls.push({ jobId, afterSeq })
      return options.readLog === undefined ? [] : options.readLog(jobId, afterSeq)
    },
    config: { apiToken: TOKEN, port: PORT, allowedOrigins: [ORIGIN] },
    sleep: options.sleep ?? (async () => {}),
  })

  return { app, store, enqueued, cancelled, readLogCalls }
}

type RequestOptions = {
  method?: string
  body?: unknown
  token?: string | null
  host?: string
  origin?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function request(
  app: ReturnType<typeof createApp>,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set('Host', options.host ?? `localhost:${PORT}`)
  if (options.token !== null) headers.set('Authorization', `Bearer ${options.token ?? TOKEN}`)
  if (options.origin !== undefined) headers.set('Origin', options.origin)
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')

  return app.request(`http://localhost:${PORT}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function expectNoToken(text: string): void {
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain(`Bearer ${TOKEN}`)
}

async function readSseUntil(response: Response, done: (text: string) => boolean): Promise<string> {
  const body = response.body
  if (body === null) throw new Error('expected an SSE response body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!done(text)) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  return text
}

describe('auth', () => {
  it('rejects a request with no token', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', { token: null })

    expect(response.status).toBe(401)
    expect(await json(response)).toEqual({ error: 'unauthorized' })
  })

  it('rejects a wrong token', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', { token: 'wrong-token-that-is-long-enough' })

    expect(response.status).toBe(401)
  })

  it('rejects a token of a different length without throwing', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', { token: 'short' })

    expect(response.status).toBe(401)
    expect(await json(response)).toEqual({ error: 'unauthorized' })
  })

  it('rejects a bad Host header', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', { host: 'evil.example:3000' })

    expect(response.status).toBe(403)
    expect(await json(response)).toEqual({ error: 'forbidden' })
  })

  it('accepts 127.0.0.1 when the port matches', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', { host: `127.0.0.1:${PORT}` })

    expect(response.status).toBe(200)
  })

  it('rejects a bad Origin', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', { origin: 'https://evil.example' })

    expect(response.status).toBe(403)
  })

  it('allows a request with no Origin', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs')

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('sends CORS headers for an allowed Origin', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', { origin: ORIGIN })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('vary')).toContain('Origin')
  })

  it('answers a preflight for an allowed Origin without a token', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', {
      method: 'OPTIONS',
      token: null,
      origin: ORIGIN,
      headers: { 'Access-Control-Request-Method': 'POST' },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
  })

  it('rejects a preflight from a bad Origin', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs', {
      method: 'OPTIONS',
      token: null,
      origin: 'https://evil.example',
    })

    expect(response.status).toBe(403)
  })
})

describe('GET /v1/jobs', () => {
  it('lists jobs with ISO dates', async () => {
    const nextRunAt = new Date('2026-02-03T04:05:06.000Z')
    const { app } = setup({ jobs: [makeJob({ nextRunAt })] })
    const response = await request(app, '/v1/jobs')

    expect(response.status).toBe(200)
    const body = await json<{ id: string; state: string; nextRunAt: string | null }[]>(response)
    expect(body).toHaveLength(1)
    expect(body[0]?.id).toBe(JOB_ID)
    expect(body[0]?.state).toBe('proposed')
    expect(body[0]?.nextRunAt).toBe(nextRunAt.toISOString())
  })

  it('filters by state', async () => {
    const { app } = setup({
      jobs: [makeJob(), makeJob({ id: OTHER_JOB_ID, state: 'failed', failureKind: 'infra' })],
    })
    const response = await request(app, '/v1/jobs?state=failed')

    expect(response.status).toBe(200)
    const body = await json<{ id: string }[]>(response)
    expect(body.map((job) => job.id)).toEqual([OTHER_JOB_ID])
  })

  it('returns 400 for an unknown state filter', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs?state=bogus')

    expect(response.status).toBe(400)
  })
})

describe('GET /v1/jobs/:id', () => {
  it('returns one job', async () => {
    const { app } = setup({ jobs: [makeJob()] })
    const response = await request(app, `/v1/jobs/${JOB_ID}`)

    expect(response.status).toBe(200)
    expect((await json<{ id: string }>(response)).id).toBe(JOB_ID)
  })

  it('returns 404 for a missing job', async () => {
    const { app } = setup()
    const response = await request(app, `/v1/jobs/${MISSING_JOB_ID}`)

    expect(response.status).toBe(404)
  })

  it('returns 400 for a non-uuid id', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/jobs/not-a-uuid')

    expect(response.status).toBe(400)
  })
})

describe('POST /v1/jobs/:id/retry', () => {
  it('retries a failed job', async () => {
    const { app, enqueued, store } = setup({ jobs: [makeJob({ state: 'failed', failureKind: 'infra' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/retry`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect((await json<{ state: string }>(response)).state).toBe('queued')
    expect(enqueued).toEqual([JOB_ID])
    expect(store.transitions).toEqual([{ id: JOB_ID, to: 'queued', reason: 'retried by hand', at: CLOCK }])
  })

  it('retries a cancelled job', async () => {
    const { app, enqueued } = setup({ jobs: [makeJob({ state: 'cancelled' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/retry`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect(enqueued).toEqual([JOB_ID])
  })

  it('returns 409 for a done job and names both states', async () => {
    const { app, enqueued } = setup({ jobs: [makeJob({ state: 'done' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/retry`, { method: 'POST' })

    expect(response.status).toBe(409)
    const body = await json<{ error: string }>(response)
    expect(body.error).toContain('done')
    expect(body.error).toContain('queued')
    expect(enqueued).toEqual([])
  })

  it('returns 409 for a proposed job', async () => {
    const { app } = setup({ jobs: [makeJob({ state: 'proposed' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/retry`, { method: 'POST' })

    expect(response.status).toBe(409)
  })

  it('returns 404 for a missing job', async () => {
    const { app } = setup()
    const response = await request(app, `/v1/jobs/${MISSING_JOB_ID}/retry`, { method: 'POST' })

    expect(response.status).toBe(404)
  })
})

describe('POST /v1/jobs/:id/cancel', () => {
  it('cancels a queued job', async () => {
    const { app, cancelled, store } = setup({ jobs: [makeJob({ state: 'queued' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/cancel`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect((await json<{ state: string }>(response)).state).toBe('cancelled')
    expect(cancelled).toEqual([JOB_ID])
    expect(store.transitions[0]?.to).toBe('cancelled')
  })

  it('returns 409 for a done job without cancelling a run', async () => {
    const { app, cancelled } = setup({ jobs: [makeJob({ state: 'done' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/cancel`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(cancelled).toEqual([])
  })
})

describe('POST /v1/jobs/:id/confirm', () => {
  it('queues a proposed job and enqueues it', async () => {
    const { app, enqueued } = setup({ jobs: [makeJob({ state: 'proposed' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/confirm`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect((await json<{ state: string }>(response)).state).toBe('queued')
    expect(enqueued).toEqual([JOB_ID])
  })

  it('returns 409 for a job that is not proposed', async () => {
    const { app, enqueued } = setup({ jobs: [makeJob({ state: 'queued' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/confirm`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(enqueued).toEqual([])
  })
})

describe('POST /v1/jobs/:id/decline', () => {
  it('declines a proposed job with a reason', async () => {
    const { app, store } = setup({ jobs: [makeJob({ state: 'proposed' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/decline`, {
      method: 'POST',
      body: { reason: 'not now' },
    })

    expect(response.status).toBe(200)
    expect((await json<{ state: string }>(response)).state).toBe('declined')
    expect(store.transitions[0]?.reason).toBe('not now')
  })

  it('returns 400 without a reason', async () => {
    const { app } = setup({ jobs: [makeJob({ state: 'proposed' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/decline`, { method: 'POST' })

    expect(response.status).toBe(400)
  })

  it('returns 400 for an empty reason', async () => {
    const { app } = setup({ jobs: [makeJob({ state: 'proposed' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/decline`, {
      method: 'POST',
      body: { reason: '   ' },
    })

    expect(response.status).toBe(400)
  })

  it('returns 409 when the job is not proposed', async () => {
    const { app } = setup({ jobs: [makeJob({ state: 'queued' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/decline`, {
      method: 'POST',
      body: { reason: 'too late' },
    })

    expect(response.status).toBe(409)
  })
})

describe('POST /v1/jobs/:id/reconsider', () => {
  it('moves a declined job back to proposed', async () => {
    const { app } = setup({ jobs: [makeJob({ state: 'declined' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/reconsider`, { method: 'POST' })

    expect(response.status).toBe(200)
    expect((await json<{ state: string }>(response)).state).toBe('proposed')
  })

  it('returns 409 when the job is not declined', async () => {
    const { app } = setup({ jobs: [makeJob({ state: 'queued' })] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/reconsider`, { method: 'POST' })

    expect(response.status).toBe(409)
  })
})

describe('actions', () => {
  it('lists actions', async () => {
    const { app } = setup({ actions: [makeAction()] })
    const response = await request(app, '/v1/actions')

    expect(response.status).toBe(200)
    const body = await json<{ id: string; createdAt: string; decidedAt: string | null }[]>(response)
    expect(body).toHaveLength(1)
    expect(body[0]?.id).toBe(ACTION_ID)
    expect(body[0]?.createdAt).toBe(CLOCK.toISOString())
    expect(body[0]?.decidedAt).toBeNull()
  })

  it('filters actions by status', async () => {
    const { app } = setup({
      actions: [makeAction(), makeAction({ id: '44444444-4444-4444-8444-444444444444', status: 'approved' })],
    })
    const response = await request(app, '/v1/actions?status=pending')

    expect(response.status).toBe(200)
    const body = await json<{ id: string }[]>(response)
    expect(body.map((action) => action.id)).toEqual([ACTION_ID])
  })

  it('returns 400 for an unknown action status filter', async () => {
    const { app } = setup()
    const response = await request(app, '/v1/actions?status=bogus')

    expect(response.status).toBe(400)
  })

  it('approves a pending action', async () => {
    const { app, store } = setup({ actions: [makeAction()] })
    const response = await request(app, `/v1/actions/${ACTION_ID}/approve`, { method: 'POST' })

    expect(response.status).toBe(200)
    const body = await json<{ status: string; decidedAt: string | null }>(response)
    expect(body.status).toBe('approved')
    expect(body.decidedAt).toBe(CLOCK.toISOString())
    expect(store.decisions).toEqual([{ id: ACTION_ID, decision: 'approved', reason: undefined }])
  })

  it('rejects a pending action with a reason', async () => {
    const { app, store } = setup({ actions: [makeAction()] })
    const response = await request(app, `/v1/actions/${ACTION_ID}/reject`, {
      method: 'POST',
      body: { reason: 'wrong wording' },
    })

    expect(response.status).toBe(200)
    const body = await json<{ status: string; reason: string | null }>(response)
    expect(body.status).toBe('rejected')
    expect(body.reason).toBe('wrong wording')
    expect(store.decisions[0]).toEqual({ id: ACTION_ID, decision: 'rejected', reason: 'wrong wording' })
  })

  it('rejects a pending action without a body', async () => {
    const { app } = setup({ actions: [makeAction()] })
    const response = await request(app, `/v1/actions/${ACTION_ID}/reject`, { method: 'POST' })

    expect(response.status).toBe(200)
    const body = await json<{ status: string; reason: string | null }>(response)
    expect(body.status).toBe('rejected')
    expect(body.reason).toBeNull()
  })

  it('returns 404 for an unknown action', async () => {
    const { app } = setup()
    const response = await request(app, `/v1/actions/${MISSING_ACTION_ID}/approve`, { method: 'POST' })

    expect(response.status).toBe(404)
  })

  it('returns 409 for an action that is not pending', async () => {
    const { app, store } = setup({ actions: [makeAction({ status: 'approved' })] })
    const response = await request(app, `/v1/actions/${ACTION_ID}/approve`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(store.decisions).toEqual([])
  })
})

describe('errors', () => {
  it('maps an unknown error to 500 without a stack trace or the token', async () => {
    const { app, store } = setup()
    store.listJobs = async () => {
      throw new Error(`boom ${TOKEN}`)
    }
    const response = await request(app, '/v1/jobs')

    expect(response.status).toBe(500)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: 'internal' })
    expectNoToken(text)
    expect(text).not.toContain('stack')
  })

  it('never puts the token in a response body', async () => {
    const { app } = setup({ jobs: [makeJob()], actions: [makeAction()] })
    const bodies: string[] = []
    const responses = await Promise.all([
      request(app, '/v1/jobs'),
      request(app, `/v1/jobs/${JOB_ID}`),
      request(app, `/v1/jobs/${JOB_ID}/confirm`, { method: 'POST' }),
      request(app, `/v1/jobs/${JOB_ID}/decline`, { method: 'POST', body: { reason: 'no' } }),
      request(app, '/v1/actions'),
      request(app, `/v1/actions/${ACTION_ID}/approve`, { method: 'POST' }),
      request(app, '/v1/jobs', { token: 'wrong' }),
      request(app, '/v1/jobs', { token: null }),
    ])
    for (const response of responses) bodies.push(await response.text())
    expectNoToken(bodies.join('\n'))
  })
})

describe('GET /v1/jobs/:id/log (SSE)', () => {
  const envelopes: Envelope[] = [
    { seq: 1, ts: '2026-01-02T03:04:05.000Z', kind: 'system', data: { msg: 'one' } },
    { seq: 2, ts: '2026-01-02T03:04:06.000Z', kind: 'assistant', data: { text: 'two' } },
    { seq: 3, ts: '2026-01-02T03:04:07.000Z', kind: 'tool', data: { name: 'three' } },
  ]

  it('emits existing envelopes with id = seq and data = JSON', async () => {
    const controller = new AbortController()
    const { app, readLogCalls } = setup({
      jobs: [makeJob()],
      readLog: async (_jobId, afterSeq) => envelopes.filter((envelope) => envelope.seq > afterSeq),
      sleep: () => new Promise<void>(() => {}),
    })
    const response = await request(app, `/v1/jobs/${JOB_ID}/log`, { signal: controller.signal })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const text = await readSseUntil(response, (value) => value.includes('id: 3'))
    controller.abort()

    expect(text).toContain('id: 1')
    expect(text).toContain('id: 2')
    expect(text).toContain('id: 3')
    expect(text).toContain('"seq":1')
    expect(text).toContain('"kind":"assistant"')
    expect(readLogCalls[0]).toEqual({ jobId: JOB_ID, afterSeq: 0 })
  })

  it('resumes after Last-Event-ID and skips earlier sequences', async () => {
    const controller = new AbortController()
    const { app, readLogCalls } = setup({
      jobs: [makeJob()],
      readLog: async (_jobId, afterSeq) => envelopes.filter((envelope) => envelope.seq > afterSeq),
      sleep: () => new Promise<void>(() => {}),
    })
    const response = await request(app, `/v1/jobs/${JOB_ID}/log?after=0`, {
      signal: controller.signal,
      headers: { 'Last-Event-ID': '2' },
    })

    const text = await readSseUntil(response, (value) => value.includes('id: 3'))
    controller.abort()

    expect(readLogCalls[0]).toEqual({ jobId: JOB_ID, afterSeq: 2 })
    expect(text).toContain('id: 3')
    expect(text).not.toContain('id: 1')
    expect(text).not.toContain('id: 2')
  })

  it('uses ?after= when Last-Event-ID is absent', async () => {
    const controller = new AbortController()
    const { app, readLogCalls } = setup({
      jobs: [makeJob()],
      readLog: async (_jobId, afterSeq) => envelopes.filter((envelope) => envelope.seq > afterSeq),
      sleep: () => new Promise<void>(() => {}),
    })
    const response = await request(app, `/v1/jobs/${JOB_ID}/log?after=1`, { signal: controller.signal })

    const text = await readSseUntil(response, (value) => value.includes('id: 3'))
    controller.abort()

    expect(readLogCalls[0]).toEqual({ jobId: JOB_ID, afterSeq: 1 })
    expect(text).not.toContain('id: 1')
    expect(text).toContain('id: 2')
  })

  it('returns 400 for an invalid ?after=', async () => {
    const { app } = setup({ jobs: [makeJob()] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/log?after=-1`)

    expect(response.status).toBe(400)
  })

  it('returns 400 for an invalid Last-Event-ID', async () => {
    const { app } = setup({ jobs: [makeJob()] })
    const response = await request(app, `/v1/jobs/${JOB_ID}/log`, {
      headers: { 'Last-Event-ID': 'nope' },
    })

    expect(response.status).toBe(400)
  })

  it('returns 404 for a missing job', async () => {
    const { app } = setup()
    const response = await request(app, `/v1/jobs/${MISSING_JOB_ID}/log`)

    expect(response.status).toBe(404)
  })

  it('stops polling after the request aborts', async () => {
    const controller = new AbortController()
    let readCalls = 0
    let sleepCalls = 0

    const { app } = setup({
      jobs: [makeJob()],
      readLog: async () => {
        readCalls += 1
        return []
      },
      sleep: async () => {
        sleepCalls += 1
        if (sleepCalls === 2) controller.abort()
      },
    })
    const response = await request(app, `/v1/jobs/${JOB_ID}/log`, { signal: controller.signal })
    expect(response.status).toBe(200)

    await vi.waitFor(() => {
      expect(controller.signal.aborted).toBe(true)
    })
    await new Promise((resolve) => setImmediate(resolve))

    const readsAfterAbort = readCalls
    expect(sleepCalls).toBe(2)
    expect(readsAfterAbort).toBe(2)

    await new Promise((resolve) => setImmediate(resolve))
    expect(readCalls).toBe(readsAfterAbort)
  })
})
