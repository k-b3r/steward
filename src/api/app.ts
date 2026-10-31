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
  /** One job in wire shape, or null when the id is unknown; `src/jobs-queries.ts` getJob. */
  getJob(id: string): Promise<JobSummary | null>
  /** Newest first; `limit` defaults to 100 and must be 1..500; `src/jobs-queries.ts` listJobs. */
  listJobs(filter?: { state?: JobState; limit?: number }): Promise<JobSummary[]>
  /** Newest first, one status at a time, same 1..500 limit; `src/jobs-queries.ts` listActions. */
  listActions(filter?: { status?: string; limit?: number }): Promise<ActionSummary[]>
}

/**
 * The write side of the HTTP API: one function per person-facing command, each returning the row it
 * changed (a job, except `decideAction`, which returns the action). The routes below validate the
 * request, call one of these and turn the thrown errors into status codes. `src/composition/api.ts`
 * backs the port with `src/jobs-commands.ts` over Postgres, the queue and the runner; the app itself
 * opens no database and no queue, and `src/api/app.test.ts` passes fakes with a fixed clock.
 */
export type ApiCommands = {
  /** `proposed` to `queued`, then the job id goes on the queue; any other state is refused with 409. */
  confirm: (id: string) => Promise<Job>
  /** `proposed` to `declined`; stores the trimmed reason on the job event and queues nothing. */
  decline: (id: string, reason: string) => Promise<Job>
  /** `declined` back to `proposed`, so the job can be decided again. */
  reconsider: (id: string) => Promise<Job>
  /** `failed` or `cancelled` to `queued`, attempt reset to 0, then enqueued; the row is reused. */
  retry: (id: string) => Promise<Job>
  /** Stops the run first, then moves the job to `cancelled`; allowed from `queued` up to `changes_requested`. */
  cancel: (id: string) => Promise<Job>
  /** Decides one `pending` action; a second decision on the same action is refused with 409. */
  decideAction: (id: string, decision: 'approved' | 'rejected', reason?: string) => Promise<PendingAction>
}

/**
 * The slice of `Config` (`src/platform/config.ts`) the HTTP app needs, renamed to camelCase: the
 * token, the port and the two allow-lists, nothing else. `src/composition/api.ts` copies those four
 * fields out of the validated config, so the rest of it (database URL, tracker key, repo paths)
 * never reaches this layer. Local to this file: only `AppDeps.config` mentions it.
 */
type AppConfig = {
  /** The full `API_TOKEN` (at least 32 characters) a request must carry as its bearer token. */
  apiToken: string
  /** `API_PORT` (default 3000). The server binds `127.0.0.1` only, and the Host check compares against this port. */
  port: number
  /** Exact browser origins allowed by `ALLOWED_ORIGINS`; empty by default, which rejects every cross-origin call. */
  allowedOrigins: string[]
  /** Extra exact Host values a proxy or tunnel forwards, from `ALLOWED_HOSTS`; empty by default. */
  allowedHosts: string[]
}

/**
 * Everything `createApp` needs from the outside world: the read port, the write port, a transcript
 * reader, four config fields and a sleep. Nothing here opens Postgres, Redis, a queue or a job
 * folder, which is why the routes can be tested without them: `src/composition/api.ts` passes the
 * real implementations, `src/api/app.test.ts` passes fakes, a fixed date and a no-op sleep.
 */
export type AppDeps = {
  /** Read side, wired to `src/jobs-queries.ts` over the Postgres store in `src/composition/api.ts`. */
  reads: ApiReads
  /** Write side, wired to `src/jobs-commands.ts`; the route only validates input and maps errors. */
  commands: ApiCommands
  /** Transcript envelopes with `seq > afterSeq`; production reads `transcript.jsonl`, tests return arrays. */
  readLog(jobId: string, afterSeq: number): Promise<Envelope[]>
  /** Token, port and allow-lists copied from `Config` by `src/composition/api.ts`. */
  config: AppConfig
  /** Milliseconds between log polls (`LOG_POLL_MS`); production is `platform/delay`, tests pass a stub. */
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

/**
 * The one bit of a `@hono/zod-validator` result this file reads: whether the schema accepted the
 * path, query or body. The library's hook also hands over `data`, `error` and `target`; `rejectInvalid`
 * looks only at `success`, and on false answers 400 `invalid request`, so the zod issue list is never
 * echoed. Local to this file: `rejectInvalid` is its only user.
 */
type ValidationOutcome = {
  /** False when the zod schema rejected the input; the route then answers 400 `invalid request`. */
  success: boolean
}

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
