// Hono API factory. Everything time-related, storage-related and run-related is
// injected, so the routes can be tested without Postgres, Redis or a worker.
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'

import type { Context } from 'hono'
import type { PendingAction } from '../types'
import { toActionSummary } from '../jobs-queries'
import type { ActionSummary, JobSummary } from '../jobs-queries'
import { ActionNotFoundError, ActionNotPendingError, JobNotFoundError } from '../jobs-commands'
import type { Envelope } from '../runner/transcript'
import { IllegalTransitionError } from '../transitions'
import { ACTION_STATUSES, JOB_STATES } from '../types'
import type { Job, JobState } from '../types'
import { createAuthMiddleware } from './auth'
import { declineBodySchema, rejectBodySchema } from './contract'

const LOG_POLL_MS = 1000

/** Commands return the domain row; the response is the read model, so re-read it once. */
async function reload(reads: ApiReads, id: string): Promise<JobSummary> {
  const view = await reads.getJob(id)
  if (view === null) throw new JobNotFoundError(id)
  return view
}

/** Reads, already shaped for the wire by src/jobs-queries.ts. */
export type ApiReads = {
  getJob(id: string): Promise<JobSummary | null>
  listJobs(filter?: { state?: JobState; limit?: number }): Promise<JobSummary[]>
  listActions(filter?: { status?: string; limit?: number }): Promise<ActionSummary[]>
}

export type ApiCommands = {
  confirm: (id: string) => Promise<Job>
  decline: (id: string, reason: string) => Promise<Job>
  reconsider: (id: string) => Promise<Job>
  retry: (id: string) => Promise<Job>
  cancel: (id: string) => Promise<Job>
  decideAction: (id: string, decision: 'approved' | 'rejected', reason?: string) => Promise<PendingAction>
}

type AppConfig = {
  apiToken: string
  port: number
  allowedOrigins: string[]
}

export type AppDeps = {
  reads: ApiReads
  commands: ApiCommands
  readLog(jobId: string, afterSeq: number): Promise<Envelope[]>
  config: AppConfig
  sleep: (ms: number) => Promise<void>
}

const idParamSchema = z.object({ id: z.uuid() })
const actionParamSchema = z.object({ id: z.string().min(1) })
const listQuerySchema = z.object({
  state: z.enum(JOB_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
const logQuerySchema = z.object({ after: z.coerce.number().int().min(0).optional() })
const actionFilterSchema = z.object({ status: z.enum(ACTION_STATUSES).optional() })

type ValidationOutcome = { success: boolean }

function rejectInvalid(result: ValidationOutcome, c: Context): Response | undefined {
  if (!result.success) return c.json({ error: 'invalid request' }, 400)
  return undefined
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
  const { reads, commands, config } = deps
  const app = new Hono()

  app.use('/v1/*', createAuthMiddleware(config))

  app.onError((error, c) => {
    if (error instanceof JobNotFoundError || error instanceof ActionNotFoundError) {
      return c.json({ error: 'not found' }, 404)
    }
    if (error instanceof IllegalTransitionError || error instanceof ActionNotPendingError) {
      return c.json({ error: error.message }, 409)
    }
    if (error instanceof HTTPException) {
      if (error.status >= 500) return c.json({ error: 'internal' }, 500)
      return c.json({ error: error.message }, error.status)
    }
    return c.json({ error: 'internal' }, 500)
  })

  return app
    .get('/v1/jobs', zValidator('query', listQuerySchema, rejectInvalid), async (c) => {
      const { state, limit } = c.req.valid('query')
      const jobs = await reads.listJobs(
        state === undefined && limit === undefined
          ? {}
          : { ...(state === undefined ? {} : { state }), ...(limit === undefined ? {} : { limit }) },
      )
      return c.json(jobs)
    })
    .get('/v1/jobs/:id', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const { id } = c.req.valid('param')
      const job = await reads.getJob(id)
      if (job === null) return c.json({ error: 'not found' }, 404)
      return c.json(job)
    })
    .get(
      '/v1/jobs/:id/log',
      zValidator('param', idParamSchema, rejectInvalid),
      zValidator('query', logQuerySchema, rejectInvalid),
      async (c) => {
        const { id } = c.req.valid('param')
        const job = await reads.getJob(id)
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
      const job = await commands.retry(c.req.valid('param').id)
      return c.json(await reload(reads, job.id))
    })
    .post('/v1/jobs/:id/cancel', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const job = await commands.cancel(c.req.valid('param').id)
      return c.json(await reload(reads, job.id))
    })
    .post('/v1/jobs/:id/confirm', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const job = await commands.confirm(c.req.valid('param').id)
      return c.json(await reload(reads, job.id))
    })
    .post(
      '/v1/jobs/:id/decline',
      zValidator('param', idParamSchema, rejectInvalid),
      zValidator('json', declineBodySchema, rejectInvalid),
      async (c) => {
        const { id } = c.req.valid('param')
        const job = await commands.decline(id, c.req.valid('json').reason)
        return c.json(await reload(reads, job.id))
      },
    )
    .post('/v1/jobs/:id/reconsider', zValidator('param', idParamSchema, rejectInvalid), async (c) => {
      const job = await commands.reconsider(c.req.valid('param').id)
      return c.json(await reload(reads, job.id))
    })
    .get('/v1/actions', zValidator('query', actionFilterSchema, rejectInvalid), async (c) => {
      const { status } = c.req.valid('query')
      const actions = await reads.listActions(status === undefined ? {} : { status })
      return c.json(actions)
    })
    .post('/v1/actions/:id/approve', zValidator('param', actionParamSchema, rejectInvalid), async (c) => {
      const action = await commands.decideAction(c.req.valid('param').id, 'approved')
      return c.json(toActionSummary(action))
    })
    .post(
      '/v1/actions/:id/reject',
      zValidator('param', actionParamSchema, rejectInvalid),
      zValidator('json', rejectBodySchema, rejectInvalid),
      async (c) => {
        const action = await commands.decideAction(c.req.valid('param').id, 'rejected', c.req.valid('json').reason)
        return c.json(toActionSummary(action))
      },
    )
}
