// Hono API factory. Everything time-related, storage-related and run-related is
// injected, so the routes can be tested without Postgres, Redis or a worker.
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

import type { Context } from 'hono'
import type { PendingAction } from '../db/store'
import { ACTION_STATUSES } from '../db/schema'
import type { Envelope } from '../runner/transcript'
import { IllegalTransitionError, canTransition } from '../transitions'
import { JOB_STATES } from '../types'
import type { FailureKind, Job, JobState } from '../types'
import { createAuthMiddleware } from './auth'
import { declineBodySchema, rejectBodySchema } from './contract'
import type { ActionResponse, JobResponse } from './contract'

const LOG_POLL_MS = 1000

export type ApiStore = {
  getJob(id: string): Promise<Job | null>
  listJobs(filter?: { state?: JobState }): Promise<Job[]>
  transitionJob(
    id: string,
    to: JobState,
    opts: { now: Date; reason?: string; failureKind?: FailureKind; nextRunAt?: Date | null },
  ): Promise<Job>
  listActions(filter?: { status?: string }): Promise<PendingAction[]>
  decideAction(
    id: string,
    decision: 'approved' | 'rejected',
    opts: { now: Date; reason?: string },
  ): Promise<PendingAction>
}

type AppConfig = {
  apiToken: string
  port: number
  allowedOrigins: string[]
}

export type AppDeps = {
  store: ApiStore
  enqueue(jobId: string): Promise<void>
  cancelRun(jobId: string): Promise<void>
  readLog(jobId: string, afterSeq: number): Promise<Envelope[]>
  clock: () => Date
  config: AppConfig
  sleep: (ms: number) => Promise<void>
}

const idParamSchema = z.object({ id: z.uuid() })
const actionParamSchema = z.object({ id: z.string().min(1) })
const jobFilterSchema = z.object({ state: z.enum(JOB_STATES).optional() })
const logQuerySchema = z.object({ after: z.coerce.number().int().min(0).optional() })
const actionFilterSchema = z.object({ status: z.enum(ACTION_STATUSES).optional() })

type ValidationOutcome = { success: boolean }

function rejectInvalid(result: ValidationOutcome, c: Context): Response | undefined {
  if (!result.success) return c.json({ error: 'invalid request' }, 400)
  return undefined
}

function toJobResponse(job: Job): JobResponse {
  return {
    id: job.id,
    source: job.source,
    externalId: job.externalId,
    identifier: job.identifier,
    state: job.state,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    slot: job.slot,
    nextRunAt: job.nextRunAt === null ? null : job.nextRunAt.toISOString(),
    failureKind: job.failureKind,
  }
}

function toActionResponse(action: PendingAction): ActionResponse {
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

function parseSequence(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const sequence = Number(value)
  return Number.isSafeInteger(sequence) ? sequence : null
}

function streamJobLog(c: Context, deps: AppDeps, jobId: string, after: number): Response {
  return streamSSE(c, async (stream) => {
    const signal = c.req.raw.signal
    let lastSeq = after
    let removeListener = (): void => undefined

    const isAborted = (): boolean => signal.aborted || stream.aborted

    const abortSignal = new Promise<void>((resolve) => {
      if (isAborted()) {
        resolve()
        return
      }
      const onAbort = (): void => resolve()
      signal.addEventListener('abort', onAbort, { once: true })
      stream.onAbort(() => resolve())
      removeListener = () => signal.removeEventListener('abort', onAbort)
      // Close the gap between the check above and registering the listeners.
      if (isAborted()) resolve()
    })

    const sendNewEnvelopes = async (): Promise<boolean> => {
      const envelopes = await deps.readLog(jobId, lastSeq)
      for (const envelope of envelopes) {
        if (isAborted()) return false
        await stream.writeSSE({ id: String(envelope.seq), data: JSON.stringify(envelope) })
        lastSeq = envelope.seq
      }
      return true
    }

    try {
      if (!(await sendNewEnvelopes())) return
      while (!isAborted()) {
        await Promise.race([deps.sleep(LOG_POLL_MS), abortSignal])
        if (isAborted()) return
        if (!(await sendNewEnvelopes())) return
      }
    } catch {
      // Headers are already sent, so report inside the stream without the error text.
      if (!isAborted()) {
        await stream.writeSSE({ data: JSON.stringify({ error: 'internal' }) }).catch(() => undefined)
      }
    } finally {
      removeListener()
    }
  })
}

export function createApp(deps: AppDeps) {
  const { store, config } = deps
  const app = new Hono()

  app.use('/v1/*', createAuthMiddleware(config))

  app.onError((error, c) => {
    if (error instanceof IllegalTransitionError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof HTTPException) {
      if (error.status >= 500) return c.json({ error: 'internal' }, 500)
      return c.json({ error: error.message }, error.status)
    }
    return c.json({ error: 'internal' }, 500)
  })

  const findAction = async (id: string): Promise<PendingAction | null> => {
    const actions = await store.listActions({})
    return actions.find((action) => action.id === id) ?? null
  }

  const decide = async (
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<{ action: PendingAction } | { notFound: true } | { conflict: string }> => {
    try {
      const action = await store.decideAction(id, decision, { now: deps.clock(), reason })
      return { action }
    } catch (error) {
      // The store reports both cases as plain errors; read the row to tell them apart.
      const existing = await findAction(id)
      if (existing === null) return { notFound: true }
      if (existing.status !== 'pending') {
        return { conflict: `Pending action is ${existing.status}, not pending` }
      }
      throw error
    }
  }

  return app
    .get('/v1/jobs', zValidator('query', jobFilterSchema, rejectInvalid), async (c) => {
      const { state } = c.req.valid('query')
      const jobs = await store.listJobs(state === undefined ? {} : { state })
      return c.json(jobs.map(toJobResponse))
    })
    .get('/v1/jobs/:id', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const { id } = c.req.valid('param')
      const job = await store.getJob(id)
      if (job === null) return c.json({ error: 'not found' }, 404)
      return c.json(toJobResponse(job))
    })
    .get(
      '/v1/jobs/:id/log',
      zValidator('param', idParamSchema, rejectInvalid),
      zValidator('query', logQuerySchema, rejectInvalid),
      async (c) => {
        const { id } = c.req.valid('param')
        const job = await store.getJob(id)
        if (job === null) return c.json({ error: 'not found' }, 404)

        const lastEventId = c.req.header('last-event-id')
        let after = c.req.valid('query').after ?? 0
        if (lastEventId !== undefined) {
          const sequence = parseSequence(lastEventId)
          if (sequence === null) return c.json({ error: 'invalid request' }, 400)
          after = sequence
        }

        return streamJobLog(c, deps, job.id, after)
      },
    )
    .post('/v1/jobs/:id/retry', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const { id } = c.req.valid('param')
      const job = await store.getJob(id)
      if (job === null) return c.json({ error: 'not found' }, 404)
      if (job.state !== 'failed' && job.state !== 'cancelled') {
        throw new IllegalTransitionError(job.state, 'queued')
      }

      const updated = await store.transitionJob(id, 'queued', { now: deps.clock() })
      await deps.enqueue(id)
      return c.json(toJobResponse(updated))
    })
    .post('/v1/jobs/:id/cancel', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const { id } = c.req.valid('param')
      const job = await store.getJob(id)
      if (job === null) return c.json({ error: 'not found' }, 404)
      if (!canTransition(job.state, 'cancelled')) {
        throw new IllegalTransitionError(job.state, 'cancelled')
      }

      await deps.cancelRun(id)
      const updated = await store.transitionJob(id, 'cancelled', { now: deps.clock() })
      return c.json(toJobResponse(updated))
    })
    .post('/v1/jobs/:id/confirm', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const { id } = c.req.valid('param')
      const job = await store.getJob(id)
      if (job === null) return c.json({ error: 'not found' }, 404)
      if (job.state !== 'proposed') {
        throw new IllegalTransitionError(job.state, 'queued')
      }

      const updated = await store.transitionJob(id, 'queued', { now: deps.clock() })
      await deps.enqueue(id)
      return c.json(toJobResponse(updated))
    })
    .post(
      '/v1/jobs/:id/decline',
      zValidator('param', idParamSchema, rejectInvalid),
      zValidator('json', declineBodySchema, rejectInvalid),
      async (c) => {
        const { id } = c.req.valid('param')
        const job = await store.getJob(id)
        if (job === null) return c.json({ error: 'not found' }, 404)

        const { reason } = c.req.valid('json')
        const updated = await store.transitionJob(id, 'declined', { now: deps.clock(), reason })
        return c.json(toJobResponse(updated))
      },
    )
    .post('/v1/jobs/:id/reconsider', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const { id } = c.req.valid('param')
      const job = await store.getJob(id)
      if (job === null) return c.json({ error: 'not found' }, 404)

      const updated = await store.transitionJob(id, 'proposed', { now: deps.clock() })
      return c.json(toJobResponse(updated))
    })
    .get('/v1/actions', zValidator('query', actionFilterSchema, rejectInvalid), async (c) => {
      const { status } = c.req.valid('query')
      const actions = await store.listActions(status === undefined ? {} : { status })
      return c.json(actions.map(toActionResponse))
    })
    .post('/v1/actions/:id/approve', zValidator('param', actionParamSchema, rejectInvalid), async (c) => {
      const { id } = c.req.valid('param')
      const result = await decide(id, 'approved')
      if ('notFound' in result) return c.json({ error: 'not found' }, 404)
      if ('conflict' in result) return c.json({ error: result.conflict }, 409)
      return c.json(toActionResponse(result.action))
    })
    .post(
      '/v1/actions/:id/reject',
      zValidator('param', actionParamSchema, rejectInvalid),
      zValidator('json', rejectBodySchema, rejectInvalid),
      async (c) => {
        const { id } = c.req.valid('param')
        const { reason } = c.req.valid('json')
        const result = await decide(id, 'rejected', reason)
        if ('notFound' in result) return c.json({ error: 'not found' }, 404)
        if ('conflict' in result) return c.json({ error: result.conflict }, 409)
        return c.json(toActionResponse(result.action))
      },
    )
}
