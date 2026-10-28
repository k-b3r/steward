import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { migrateDb } from '../../src/db/migrate'
import { jobEvents, slots } from '../../src/db/schema'
import { acquireSlot, getJob, heldSlots, insertJob, transitionJob } from '../../src/db/store'
import { closePool, createDb, createPool } from '../../src/platform/db'
import type { BackoffOptions } from '../../src/retry-policy'
import type { Job, WorkItem } from '../../src/types'
import { reconcile } from '../../src/worker/reconcile'
import type { ReconcileOptions, ReconcileQueue } from '../../src/worker/reconcile'

const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl === undefined) {
  throw new Error('TEST_DATABASE_URL is required for integration tests')
}

// The reset below drops whole schemas, so refuse any database that is not clearly a test one.
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
if (!databaseName.includes('test')) {
  throw new Error(`Refusing to run: TEST_DATABASE_URL database "${databaseName}" must contain "test"`)
}

const T0 = new Date('2025-01-01T00:00:00.000Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
const NOW = at(10)

const BACKOFF: BackoffOptions = { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0 }

const pool = createPool(databaseUrl)
const db = createDb(pool)

const sqlDropDrizzleSchema = sql`drop schema if exists drizzle cascade`
const sqlDropPublicSchema = sql`drop schema if exists public cascade`
const sqlCreatePublicSchema = sql`create schema public`

async function resetDatabase(): Promise<void> {
  // The migrator keeps its journal in the `drizzle` schema, so dropping only
  // `public` would make the next migration run a no-op.
  await db.execute(sqlDropDrizzleSchema)
  await db.execute(sqlDropPublicSchema)
  await db.execute(sqlCreatePublicSchema)
  await migrateDb(db)
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    source: 'linear',
    externalId: 'ext-1',
    identifier: 'TST-1',
    title: 'A job',
    body: 'Do the thing',
    labels: ['agent'],
    url: 'https://example.test/TST-1',
    status: 'Todo',
    ...overrides,
  }
}

async function makeJob(externalId: string, state: 'proposed' | 'queued' = 'queued', maxAttempts = 3): Promise<Job> {
  const { job } = await insertJob(db, {
    item: makeItem({ externalId, identifier: `TST-${externalId}` }),
    state,
    maxAttempts,
    now: T0,
  })
  return job
}

async function makeQueuedJob(externalId: string, maxAttempts = 3): Promise<Job> {
  return makeJob(externalId, 'queued', maxAttempts)
}

async function startJob(job: Job, when: Date = at(1)): Promise<Job> {
  const slot = await acquireSlot(db, job.id, 4, when)
  if (slot === null) {
    throw new Error(`No slot available for ${job.id}`)
  }
  await transitionJob(db, job.id, 'claiming', { now: when })
  return transitionJob(db, job.id, 'running', { now: when })
}

async function eventsFor(jobId: string) {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(jobEvents.id)
}

type Enqueued = { jobId: string; delayMs: number | undefined }
type FakeQueue = ReconcileQueue & { present: Set<string>; enqueued: Enqueued[] }

function makeQueue(options: { present?: string[]; failing?: string[] } = {}): FakeQueue {
  const present = new Set(options.present ?? [])
  const failing = new Set(options.failing ?? [])
  const enqueued: Enqueued[] = []

  return {
    present,
    enqueued,
    async hasJob(jobId: string): Promise<boolean> {
      if (failing.has(jobId)) {
        throw new Error(`queue hasJob failed for ${jobId}`)
      }
      return present.has(jobId)
    },
    async enqueue(jobId: string, delayMs?: number): Promise<void> {
      if (failing.has(jobId)) {
        throw new Error(`queue enqueue failed for ${jobId}`)
      }
      present.add(jobId)
      enqueued.push({ jobId, delayMs })
    },
  }
}

function makeOptions(overrides: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return { now: NOW, rand: () => 0.5, backoff: BACKOFF, slotCount: 4, ...overrides }
}

const noWorkersAlive = async (): Promise<boolean> => false

const aliveOnly =
  (ids: string[]) =>
  async (jobId: string): Promise<boolean> =>
    ids.includes(jobId)

async function runReconcile(
  queue: FakeQueue,
  options: ReconcileOptions = makeOptions(),
  isWorkerAlive: (jobId: string) => Promise<boolean> = noWorkersAlive,
) {
  return reconcile({ db, queue, isWorkerAlive }, options)
}

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closePool(pool)
})

describe('reconcile: abandoned workers', () => {
  it('retries a running job whose worker is gone and frees its slot', async () => {
    const job = await startJob(await makeQueuedJob('retry', 3))
    expect(await heldSlots(db)).toHaveLength(1)
    const queue = makeQueue()

    const report = await runReconcile(queue)

    expect(report).toEqual({ requeued: [], retried: [job.id], failed: [], slotsFreed: [] })
    expect(await getJob(db, job.id)).toMatchObject({
      state: 'queued',
      attempt: 1,
      failureKind: 'infra',
      nextRunAt: new Date(NOW.getTime() + 1_000),
      slot: null,
    })
    expect(await heldSlots(db)).toEqual([])
    expect(queue.enqueued).toEqual([{ jobId: job.id, delayMs: 1_000 }])
    expect(queue.present.has(job.id)).toBe(true)
    expect((await eventsFor(job.id)).at(-1)).toMatchObject({
      fromState: 'running',
      toState: 'queued',
      failureKind: 'infra',
      reason: 'worker lost on restart',
      at: NOW,
    })
  })

  it('fails a running job whose retries are exhausted, freeing its slot and not enqueuing it', async () => {
    const job = await startJob(await makeQueuedJob('exhausted', 2))
    await transitionJob(db, job.id, 'queued', { now: at(2), failureKind: 'infra', nextRunAt: at(3) })
    expect(await acquireSlot(db, job.id, 4, at(3))).toBe(0)
    await transitionJob(db, job.id, 'claiming', { now: at(3) })
    await transitionJob(db, job.id, 'running', { now: at(3) })
    expect(await getJob(db, job.id)).toMatchObject({ attempt: 2, maxAttempts: 2, slot: 0 })
    const queue = makeQueue()

    const report = await runReconcile(queue)

    expect(report).toEqual({ requeued: [], retried: [], failed: [job.id], slotsFreed: [] })
    expect(await getJob(db, job.id)).toMatchObject({
      state: 'failed',
      attempt: 2,
      failureKind: 'infra',
      slot: null,
    })
    expect(await heldSlots(db)).toEqual([])
    expect(queue.enqueued).toEqual([])
    expect(queue.present.has(job.id)).toBe(false)
    expect((await eventsFor(job.id)).at(-1)).toMatchObject({
      fromState: 'running',
      toState: 'failed',
      failureKind: 'infra',
      reason: 'worker lost on restart; retries exhausted',
      at: NOW,
    })
  })

  it('leaves a running job with a live worker alone and keeps its slot', async () => {
    const job = await startJob(await makeQueuedJob('alive'))
    const before = await getJob(db, job.id)
    const queue = makeQueue()

    const report = await runReconcile(queue, makeOptions(), aliveOnly([job.id]))

    expect(report).toEqual({ requeued: [], retried: [], failed: [], slotsFreed: [] })
    expect(await getJob(db, job.id)).toEqual(before)
    expect(await heldSlots(db)).toEqual([{ slot: 0, jobId: job.id, jobState: 'running' }])
    expect(queue.enqueued).toEqual([])
  })

  it('handles a claiming job that holds no slot and has no live worker', async () => {
    const job = await makeQueuedJob('claiming')
    await transitionJob(db, job.id, 'claiming', { now: at(1) })
    expect(await heldSlots(db)).toEqual([])
    const queue = makeQueue()

    const report = await runReconcile(queue)

    expect(report).toEqual({ requeued: [], retried: [job.id], failed: [], slotsFreed: [] })
    expect(await getJob(db, job.id)).toMatchObject({ state: 'queued', attempt: 1, failureKind: 'infra', slot: null })
    expect(queue.enqueued).toEqual([{ jobId: job.id, delayMs: 1_000 }])
  })
})

describe('reconcile: queued jobs', () => {
  it('enqueues a queued job missing from the queue, and not one already present', async () => {
    const missing = await makeQueuedJob('missing')
    const present = await makeQueuedJob('present')
    const queue = makeQueue({ present: [present.id] })

    const report = await runReconcile(queue)

    expect(report).toEqual({ requeued: [missing.id], retried: [], failed: [], slotsFreed: [] })
    expect(queue.enqueued).toEqual([{ jobId: missing.id, delayMs: 0 }])
    expect(await getJob(db, missing.id)).toEqual(missing)
  })

  it('uses the next run time as the delay, and zero for a past one', async () => {
    const future = await makeJob('future', 'proposed')
    const past = await makeJob('past', 'proposed')
    await transitionJob(db, future.id, 'queued', { now: at(1), nextRunAt: at(30) })
    await transitionJob(db, past.id, 'queued', { now: at(1), nextRunAt: at(2) })
    const queue = makeQueue()

    const report = await runReconcile(queue)

    expect(report.requeued).toEqual(expect.arrayContaining([future.id, past.id]))
    expect(report.requeued).toHaveLength(2)
    expect(queue.enqueued).toEqual(
      expect.arrayContaining([
        { jobId: future.id, delayMs: 20 * 60_000 },
        { jobId: past.id, delayMs: 0 },
      ]),
    )
    expect(queue.enqueued).toHaveLength(2)
  })

  it('leaves queued jobs already handled as retries in step one to the retry path', async () => {
    const job = await startJob(await makeQueuedJob('retried-once'))
    const queue = makeQueue()

    const report = await runReconcile(queue)

    expect(report).toEqual({ requeued: [], retried: [job.id], failed: [], slotsFreed: [] })
    expect(queue.enqueued).toEqual([{ jobId: job.id, delayMs: 1_000 }])
  })
})

describe('reconcile: leaked slots', () => {
  it('frees a leaked slot row on a done job', async () => {
    const job = await startJob(await makeQueuedJob('done'))
    await transitionJob(db, job.id, 'done', { now: at(2) })
    await db.insert(slots).values({ slot: 2, jobId: job.id, acquiredAt: at(3) })
    expect(await heldSlots(db)).toEqual([{ slot: 2, jobId: job.id, jobState: 'done' }])
    const queue = makeQueue()

    const report = await runReconcile(queue)

    expect(report.slotsFreed).toEqual([2])
    expect(await heldSlots(db)).toEqual([])
    expect(queue.enqueued).toEqual([])
  })
})

describe('reconcile: robustness', () => {
  it('changes nothing on a second run straight after the first', async () => {
    const job = await startJob(await makeQueuedJob('idempotent'))
    const queue = makeQueue()

    await runReconcile(queue)
    const afterFirst = await getJob(db, job.id)
    const eventsAfterFirst = await eventsFor(job.id)

    const second = await runReconcile(queue)

    expect(second).toEqual({ requeued: [], retried: [], failed: [], slotsFreed: [] })
    expect(await getJob(db, job.id)).toEqual(afterFirst)
    expect(await eventsFor(job.id)).toHaveLength(eventsAfterFirst.length)
    expect(queue.enqueued).toEqual([{ jobId: job.id, delayMs: 1_000 }])
    expect(await heldSlots(db)).toEqual([])
  })

  it('keeps reconciling other jobs when one job throws, then rethrows an AggregateError', async () => {
    const broken = await makeQueuedJob('broken')
    const first = await makeQueuedJob('first')
    const second = await makeQueuedJob('second')
    const queue = makeQueue({ failing: [broken.id] })

    const caught: unknown = await runReconcile(queue).then(
      () => null,
      (error: unknown) => error,
    )

    expect(caught).toBeInstanceOf(AggregateError)
    const aggregate = caught as AggregateError
    expect(aggregate.errors.map((error: unknown) => (error as Error).message)).toEqual([
      `queue hasJob failed for ${broken.id}`,
    ])
    expect(queue.enqueued.map((entry) => entry.jobId).sort()).toEqual([first.id, second.id].sort())
    expect(queue.present.has(broken.id)).toBe(false)
  })
})
