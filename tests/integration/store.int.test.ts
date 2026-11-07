import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { migrateDb } from '../../src/db/migrate'
import { jobEvents, jobs, slots } from '../../src/db/schema'
import {
  acquireSlot,
  createAction,
  getAction,
  decideAction,
  getJob,
  heldSlots,
  insertJob,
  latestRunNumber,
  listJobEvents,
  listActions,
  listJobs,
  listRuns,
  releaseLeakedSlots,
  releaseSlot,
  transitionJob,
} from '../../src/db/store'
import { closePool, createDb, createPool } from '../../src/platform/db'
import { IllegalTransitionError } from '../../src/transitions'
import type { Job, WorkItem } from '../../src/types'

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

async function createJob(externalId = 'ext-1', now: Date = T0): Promise<Job> {
  const { job } = await insertJob(db, {
    item: makeItem({ externalId, identifier: `TST-${externalId}` }),
    state: 'proposed',
    maxAttempts: 3,
    now,
  })
  return job
}

async function eventsFor(jobId: string) {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(jobEvents.id)
}

async function countJobs(): Promise<number> {
  return (await db.select().from(jobs)).length
}

async function countSlots(): Promise<number> {
  return (await db.select().from(slots)).length
}

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closePool(pool)
})

describe('insertJob', () => {
  it('creates a job and its first event', async () => {
    const { job, created } = await insertJob(db, {
      item: makeItem(),
      state: 'proposed',
      maxAttempts: 3,
      now: T0,
    })

    expect(created).toBe(true)
    expect(job).toMatchObject({
      source: 'linear',
      externalId: 'ext-1',
      identifier: 'TST-1',
      state: 'proposed',
      attempt: 0,
      maxAttempts: 3,
      slot: null,
      nextRunAt: null,
      failureKind: null,
    })
    expect(await eventsFor(job.id)).toMatchObject([{ fromState: null, toState: 'proposed', at: T0 }])
  })

  it('returns the existing row, unchanged, on a duplicate and writes no event', async () => {
    const first = await insertJob(db, { item: makeItem(), state: 'proposed', maxAttempts: 3, now: T0 })
    const second = await insertJob(db, {
      item: makeItem({ title: 'Changed title' }),
      state: 'queued',
      maxAttempts: 9,
      now: at(5),
    })

    expect(second.created).toBe(false)
    expect(second.job.id).toBe(first.job.id)
    expect(second.job.state).toBe('proposed')
    expect(second.job.maxAttempts).toBe(3)
    expect(await countJobs()).toBe(1)
    expect(await eventsFor(first.job.id)).toHaveLength(1)
  })

  it('lets exactly one of ten concurrent inserts create the job', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => insertJob(db, { item: makeItem(), state: 'proposed', maxAttempts: 3, now: T0 })),
    )

    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1)
    expect(await countJobs()).toBe(1)
    expect(await eventsFor(results[0].job.id)).toHaveLength(1)
  })
})

describe('getJob and listJobs', () => {
  it('returns null for an unknown id and the mapped job otherwise', async () => {
    expect(await getJob(db, '00000000-0000-0000-0000-000000000000')).toBeNull()

    const job = await createJob()
    expect(await getJob(db, job.id)).toEqual(job)
  })

  it('lists newest first and filters by state', async () => {
    const older = await createJob('older', at(0))
    const newer = await createJob('newer', at(10))
    expect((await listJobs(db)).map((job) => job.id)).toEqual([newer.id, older.id])
    expect((await listJobs(db, { state: 'proposed' })).map((job) => job.id)).toEqual([newer.id, older.id])
    expect(await listJobs(db, { state: 'done' })).toEqual([])
  })
})

describe('transitionJob', () => {
  it('walks the legal path and appends ordered events, incrementing attempt on claiming', async () => {
    const job = await createJob()

    await transitionJob(db, job.id, 'queued', { now: at(1) })
    const claiming = await transitionJob(db, job.id, 'claiming', { now: at(2) })
    const running = await transitionJob(db, job.id, 'running', { now: at(3) })
    const done = await transitionJob(db, job.id, 'done', { now: at(4) })

    expect(claiming.attempt).toBe(1)
    expect(running.attempt).toBe(1)
    expect(done).toMatchObject({ state: 'done', attempt: 1 })
    expect((await eventsFor(job.id)).map((event) => [event.fromState, event.toState])).toEqual([
      [null, 'proposed'],
      ['proposed', 'queued'],
      ['queued', 'claiming'],
      ['claiming', 'running'],
      ['running', 'done'],
    ])
  })

  it('throws IllegalTransitionError and leaves the row and events untouched', async () => {
    const job = await createJob()

    await expect(transitionJob(db, job.id, 'running', { now: at(1) })).rejects.toBeInstanceOf(IllegalTransitionError)

    expect(await getJob(db, job.id)).toEqual(job)
    expect(await eventsFor(job.id)).toHaveLength(1)
  })

  it('throws a clear error for an unknown id', async () => {
    await expect(transitionJob(db, '00000000-0000-0000-0000-000000000000', 'queued', { now: T0 })).rejects.toThrow(
      /unknown job/i,
    )
  })

  it('lets exactly one of two concurrent transitions win', async () => {
    const job = await createJob()

    const results = await Promise.allSettled([
      transitionJob(db, job.id, 'queued', { now: at(1) }),
      transitionJob(db, job.id, 'declined', { now: at(1) }),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: expect.any(IllegalTransitionError) })

    const winner = fulfilled[0].status === 'fulfilled' ? fulfilled[0].value : undefined
    expect(['queued', 'declined']).toContain(winner?.state)
    expect((await eventsFor(job.id)).map((event) => event.toState)).toEqual(['proposed', winner?.state])
  })

  it('resets attempt and next_run_at on a manual retry from failed', async () => {
    const job = await createJob()
    await transitionJob(db, job.id, 'queued', { now: at(1) })
    await transitionJob(db, job.id, 'claiming', { now: at(2) })
    await transitionJob(db, job.id, 'running', { now: at(3) })
    await transitionJob(db, job.id, 'failed', { now: at(4), failureKind: 'infra', nextRunAt: at(9) })

    const retried = await transitionJob(db, job.id, 'queued', { now: at(10) })

    expect(retried).toMatchObject({ state: 'queued', attempt: 0, nextRunAt: null, failureKind: null })
  })

  it('clears the next run time once the retried job enters claiming', async () => {
    const job = await createJob()
    await transitionJob(db, job.id, 'queued', { now: at(1) })
    await transitionJob(db, job.id, 'claiming', { now: at(2) })
    await transitionJob(db, job.id, 'queued', { now: at(3), failureKind: 'infra', nextRunAt: at(8) })

    const claiming = await transitionJob(db, job.id, 'claiming', { now: at(8) })

    expect(claiming).toMatchObject({ state: 'claiming', attempt: 2, nextRunAt: null })
  })

  it('records failure kind and next run time on an automatic retry', async () => {
    const job = await createJob()
    await transitionJob(db, job.id, 'queued', { now: at(1) })
    await transitionJob(db, job.id, 'claiming', { now: at(2) })
    await transitionJob(db, job.id, 'running', { now: at(3) })

    const retried = await transitionJob(db, job.id, 'queued', {
      now: at(4),
      failureKind: 'infra',
      reason: 'container start failed',
      nextRunAt: at(8),
    })

    expect(retried).toMatchObject({ state: 'queued', attempt: 1, failureKind: 'infra', nextRunAt: at(8) })
    expect(await eventsFor(job.id)).toMatchObject([
      {},
      {},
      {},
      {},
      { fromState: 'running', toState: 'queued', failureKind: 'infra', reason: 'container start failed', at: at(4) },
    ])
  })

  it.each(['failed', 'done', 'pr_open'] as const)('releases the slot when running goes to %s', async (target) => {
    const job = await createJob()
    await transitionJob(db, job.id, 'queued', { now: at(1) })
    expect(await acquireSlot(db, job.id, 4, at(2))).toBe(0)
    await transitionJob(db, job.id, 'claiming', { now: at(2) })
    await transitionJob(db, job.id, 'running', { now: at(3) })

    const after = await transitionJob(db, job.id, target, { now: at(4) })

    expect(after.slot).toBeNull()
    expect(await heldSlots(db)).toEqual([])
    expect(await countSlots()).toBe(0)
  })
})

describe('slots', () => {
  it('allocates the lowest free slot and returns the same slot on a repeat', async () => {
    const first = await createJob('a')
    const second = await createJob('b')
    const third = await createJob('c')

    expect(await acquireSlot(db, first.id, 4, at(1))).toBe(0)
    expect(await acquireSlot(db, second.id, 4, at(1))).toBe(1)
    expect(await acquireSlot(db, third.id, 4, at(1))).toBe(2)
    expect(await acquireSlot(db, first.id, 4, at(2))).toBe(0)
  })

  it('returns null when every slot is taken, and reuses a released one', async () => {
    const first = await createJob('a')
    const second = await createJob('b')
    const third = await createJob('c')

    expect(await acquireSlot(db, first.id, 2, at(1))).toBe(0)
    expect(await acquireSlot(db, second.id, 2, at(1))).toBe(1)
    expect(await acquireSlot(db, third.id, 2, at(1))).toBeNull()

    await releaseSlot(db, first.id)
    expect(await acquireSlot(db, third.id, 2, at(2))).toBe(0)
  })

  it('gives exactly three distinct slots to twenty concurrent acquisitions', async () => {
    const created = await Promise.all(Array.from({ length: 20 }, (_, index) => createJob(`job-${index}`)))

    const results = await Promise.all(created.map((job) => acquireSlot(db, job.id, 3, at(1))))

    const won = results.filter((slot): slot is number => slot !== null)
    expect(won).toHaveLength(3)
    expect(new Set(won).size).toBe(3)
    expect(results.filter((slot) => slot === null)).toHaveLength(17)
    expect(await countSlots()).toBe(3)
  })

  it('releases idempotently', async () => {
    const job = await createJob()
    await acquireSlot(db, job.id, 2, at(1))

    await releaseSlot(db, job.id)
    await releaseSlot(db, job.id)

    expect(await heldSlots(db)).toEqual([])
  })

  it('reports held slots and frees leaked ones', async () => {
    const leaked = await createJob('leaked')
    const held = await createJob('held')
    await db.insert(slots).values({ slot: 2, jobId: leaked.id, acquiredAt: at(1) })
    expect(await acquireSlot(db, held.id, 4, at(1))).toBe(0)
    await transitionJob(db, held.id, 'queued', { now: at(1) })
    await transitionJob(db, held.id, 'claiming', { now: at(2) })

    expect(await heldSlots(db)).toEqual([
      { slot: 0, jobId: held.id, jobState: 'claiming' },
      { slot: 2, jobId: leaked.id, jobState: 'proposed' },
    ])
    expect(await releaseLeakedSlots(db)).toEqual([2])
    expect(await heldSlots(db)).toEqual([{ slot: 0, jobId: held.id, jobState: 'claiming' }])
    expect(await countSlots()).toBe(1)
  })
})

describe('pending actions', () => {
  it('reads one action by id, and null when it does not exist', async () => {
    const job = await createJob()
    const action = await createAction(db, { jobId: job.id, kind: 'comment', payload: { body: 'hi' }, now: T0 })

    expect(await getAction(db, action.id)).toMatchObject({ id: action.id, status: 'pending' })
    expect(await getAction(db, '123e4567-e89b-42d3-a456-426614174000')).toBeNull()
  })

  it('creates a pending action and approves it once', async () => {
    const job = await createJob()
    const action = await createAction(db, { jobId: job.id, kind: 'comment', payload: { body: 'hi' }, now: T0 })

    expect(action).toMatchObject({
      jobId: job.id,
      kind: 'comment',
      payload: { body: 'hi' },
      status: 'pending',
      reason: null,
      createdAt: T0,
      decidedAt: null,
    })

    const approved = await decideAction(db, action.id, 'approved', { now: at(5) })
    expect(approved).toMatchObject({ status: 'approved', reason: null, decidedAt: at(5) })
    await expect(decideAction(db, action.id, 'approved', { now: at(6) })).rejects.toThrow(/pending/i)
  })

  it('rejects without a reason and stores a reason when given', async () => {
    const job = await createJob()
    const plain = await createAction(db, { jobId: job.id, kind: 'comment', payload: {}, now: T0 })
    const withReason = await createAction(db, { jobId: job.id, kind: 'close_pr', payload: {}, now: T0 })

    await expect(decideAction(db, plain.id, 'rejected', { now: at(1) })).resolves.toMatchObject({
      status: 'rejected',
      reason: null,
    })
    await expect(
      decideAction(db, withReason.id, 'rejected', { now: at(2), reason: 'not wanted' }),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'not wanted' })

    expect((await listActions(db, { status: 'rejected' })).map((action) => action.id).sort()).toEqual(
      [plain.id, withReason.id].sort(),
    )
    expect(await listActions(db, { status: 'pending' })).toEqual([])
    expect(await listActions(db)).toHaveLength(2)
  })

  it('lists only pending actions when asked', async () => {
    const job = await createJob()
    const first = await createAction(db, { jobId: job.id, kind: 'comment', payload: {}, now: T0 })
    await createAction(db, { jobId: job.id, kind: 'comment', payload: {}, now: T0 })
    await decideAction(db, first.id, 'approved', { now: at(1) })

    expect(await listActions(db, { status: 'pending' })).toHaveLength(1)
    expect(await listActions(db, { status: 'approved' })).toHaveLength(1)
  })
})

describe('runs', () => {
  const queueAndClaim = async (jobId: string, startMinute: number): Promise<void> => {
    await transitionJob(db, jobId, 'queued', { now: at(startMinute) })
    await acquireSlot(db, jobId, 3, at(startMinute))
    await transitionJob(db, jobId, 'claiming', { now: at(startMinute + 1) })
  }

  it('opens run 1 when the job is claimed, with its slot and start time', async () => {
    const job = await createJob()
    await queueAndClaim(job.id, 1)

    expect(await listRuns(db, job.id)).toEqual([
      { jobId: job.id, number: 1, slot: 0, startedAt: at(2), endedAt: null, outcome: null, failureKind: null },
    ])
  })

  it('does not open another run when claiming moves on to running', async () => {
    const job = await createJob()
    await queueAndClaim(job.id, 1)
    await transitionJob(db, job.id, 'running', { now: at(3) })

    expect((await listRuns(db, job.id)).map((run) => run.number)).toEqual([1])
  })

  it('closes the run with its outcome when the job is done', async () => {
    const job = await createJob()
    await queueAndClaim(job.id, 1)
    await transitionJob(db, job.id, 'running', { now: at(3) })
    await transitionJob(db, job.id, 'done', { now: at(4) })

    expect(await listRuns(db, job.id)).toMatchObject([
      { number: 1, endedAt: at(4), outcome: 'done', failureKind: null },
    ])
  })

  it('records an automatic infra retry as outcome retry, and the next claim opens run 2', async () => {
    const job = await createJob()
    await queueAndClaim(job.id, 1)
    await transitionJob(db, job.id, 'queued', { now: at(3), failureKind: 'infra', reason: 'blip' })
    await acquireSlot(db, job.id, 3, at(4))
    await transitionJob(db, job.id, 'claiming', { now: at(5) })

    expect(await listRuns(db, job.id)).toMatchObject([
      { number: 1, endedAt: at(3), outcome: 'retry', failureKind: 'infra' },
      { number: 2, startedAt: at(5), endedAt: null, outcome: null },
    ])
  })

  it('numbers a manual retry as a new run: the attempt counter resets, the run number does not', async () => {
    const job = await createJob()
    await queueAndClaim(job.id, 1)
    await transitionJob(db, job.id, 'failed', { now: at(3), failureKind: 'setup', reason: 'bad repo' })
    await transitionJob(db, job.id, 'queued', { now: at(4), reason: 'retried by hand' })
    await acquireSlot(db, job.id, 3, at(5))
    const claimed = await transitionJob(db, job.id, 'claiming', { now: at(6) })

    expect(claimed.attempt).toBe(1)
    expect(await listRuns(db, job.id)).toMatchObject([
      { number: 1, outcome: 'failed', failureKind: 'setup' },
      { number: 2, outcome: null },
    ])
  })

  it('closes a cancelled run as cancelled', async () => {
    const job = await createJob()
    await queueAndClaim(job.id, 1)
    await transitionJob(db, job.id, 'cancelled', { now: at(3) })

    expect(await listRuns(db, job.id)).toMatchObject([{ number: 1, endedAt: at(3), outcome: 'cancelled' }])
  })

  it('opens a new run when a job waiting on red CI is resumed into running', async () => {
    const job = await createJob()
    await queueAndClaim(job.id, 1)
    await transitionJob(db, job.id, 'running', { now: at(3) })
    await transitionJob(db, job.id, 'pr_open', { now: at(4) })
    await transitionJob(db, job.id, 'ci_failed', { now: at(5) })
    await transitionJob(db, job.id, 'running', { now: at(6) })

    // The resume goes straight to `running`, so that run never took a slot. A resumed job needs
    // the claim path (queued -> claiming -> acquireSlot) before it holds one.
    expect(await listRuns(db, job.id)).toMatchObject([
      { number: 1, endedAt: at(4), outcome: 'pr_open' },
      { number: 2, startedAt: at(6), endedAt: null, outcome: null, slot: null },
    ])
  })

  it('has no runs for a job that never ran', async () => {
    const job = await createJob()

    expect(await listRuns(db, job.id)).toEqual([])
    expect(await latestRunNumber(db, job.id)).toBeNull()
  })

  it('reports the latest run number, and keeps the runs of different jobs apart', async () => {
    const first = await createJob('ext-1')
    const second = await createJob('ext-2')
    await queueAndClaim(first.id, 1)
    await transitionJob(db, first.id, 'queued', { now: at(3), failureKind: 'infra' })
    await acquireSlot(db, first.id, 3, at(4))
    await transitionJob(db, first.id, 'claiming', { now: at(5) })
    await queueAndClaim(second.id, 6)

    expect(await latestRunNumber(db, first.id)).toBe(2)
    expect(await latestRunNumber(db, second.id)).toBe(1)
    expect((await listRuns(db, second.id)).map((run) => run.jobId)).toEqual([second.id])
  })
})

describe('listJobEvents', () => {
  it('returns the state log oldest first, with reason and failure kind', async () => {
    const job = await createJob()
    await transitionJob(db, job.id, 'queued', { now: at(1), reason: 'confirmed' })
    await transitionJob(db, job.id, 'claiming', { now: at(2) })

    const events = await listJobEvents(db, job.id)

    expect(events.map((event) => [event.fromState, event.toState])).toEqual([
      [null, 'proposed'],
      ['proposed', 'queued'],
      ['queued', 'claiming'],
    ])
    expect(events[1]).toMatchObject({ reason: 'confirmed', failureKind: null })
  })

  it('keeps the newest events when the log is longer than the limit', async () => {
    const job = await createJob()
    await transitionJob(db, job.id, 'queued', { now: at(1) })
    await transitionJob(db, job.id, 'claiming', { now: at(2) })

    const events = await listJobEvents(db, job.id, 2)

    // The last two are the current state and how it got there; the creation event is older.
    expect(events.map((event) => event.toState)).toEqual(['queued', 'claiming'])
  })

  it('keeps the events of different jobs apart', async () => {
    const first = await createJob('ext-1')
    const second = await createJob('ext-2')
    await transitionJob(db, first.id, 'queued', { now: at(1) })

    expect(await listJobEvents(db, second.id)).toEqual([
      { fromState: null, toState: 'proposed', failureKind: null, reason: null, at: T0 },
    ])
    expect(await listJobEvents(db, first.id)).toHaveLength(2)
  })
})
