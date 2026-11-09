// Postgres-backed job store. Every function takes the drizzle handle and an
// explicit `now: Date`; nothing here reads the clock or the environment.
import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm'

import { allocateSlot, findLeakedSlots, holdsSlot } from '../allocate'
import { endsRun, runOutcomeFor, startsRun } from '../runs'
import { assertTransition } from '../transitions'
import type { FailureKind, Job, JobEvent, JobState, PendingAction, Run, WorkItem } from '../types'
import type { Db } from '../platform/db'
import { ACTION_STATUSES } from '../types'
import type { ActionStatus } from '../types'
import { jobEvents, jobs, pendingActions, runs, slots } from './schema'

/** A read that does not ask for a page still gets one: an unbounded list is a memory leak. */
type JobRow = typeof jobs.$inferSelect
type PendingActionRow = typeof pendingActions.$inferSelect
type RunRow = typeof runs.$inferSelect
type JobWithSlot = { job: JobRow; slot: number | null }

function toJob(row: JobWithSlot): Job {
  return {
    id: row.job.id,
    source: row.job.source,
    externalId: row.job.externalId,
    identifier: row.job.identifier,
    title: row.job.item.title,
    body: row.job.item.body,
    url: row.job.item.url,
    createdAt: row.job.createdAt,
    state: row.job.state,
    attempt: row.job.attempt,
    maxAttempts: row.job.maxAttempts,
    slot: row.slot,
    nextRunAt: row.job.nextRunAt,
    failureKind: row.job.failureKind,
  }
}

function toPendingAction(row: PendingActionRow): PendingAction {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  }
}

function toRun(row: RunRow): Run {
  return {
    jobId: row.jobId,
    number: row.runNumber,
    slot: row.slot,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    outcome: row.outcome,
    failureKind: row.failureKind,
  }
}

function isManualRetry(from: JobState, to: JobState): boolean {
  return to === 'queued' && (from === 'failed' || from === 'cancelled')
}

function recordsFailureKind(from: JobState, to: JobState): boolean {
  return to === 'failed' || (to === 'queued' && (from === 'claiming' || from === 'running'))
}

function nextAttempt(from: JobState, to: JobState, attempt: number): number {
  if (to === 'claiming') return attempt + 1
  if (isManualRetry(from, to)) return 0
  return attempt
}

/** Postgres unique_violation; used to detect a competing slot insert. Drizzle wraps driver errors, so walk `cause`. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && (current as { code?: unknown }).code === '23505') {
      return true
    }
    if (!('cause' in current)) {
      return false
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function actionStatus(value: string): ActionStatus | undefined {
  return ACTION_STATUSES.find((status) => status === value)
}

export async function insertJob(
  db: Db,
  input: { item: WorkItem; state: 'proposed' | 'queued'; maxAttempts: number; now: Date },
): Promise<{ job: Job; created: boolean }> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(jobs)
      .values({
        source: input.item.source,
        externalId: input.item.externalId,
        identifier: input.item.identifier,
        item: input.item,
        state: input.state,
        attempt: 0,
        maxAttempts: input.maxAttempts,
        nextRunAt: null,
        failureKind: null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: [jobs.source, jobs.externalId] })
      .returning()

    if (inserted !== undefined) {
      await tx.insert(jobEvents).values({
        jobId: inserted.id,
        fromState: null,
        toState: input.state,
        failureKind: null,
        reason: null,
        data: null,
        at: input.now,
      })
      return { job: toJob({ job: inserted, slot: null }), created: true }
    }

    const [existing] = await tx
      .select({ job: jobs, slot: slots.slot })
      .from(jobs)
      .leftJoin(slots, eq(slots.jobId, jobs.id))
      .where(and(eq(jobs.source, input.item.source), eq(jobs.externalId, input.item.externalId)))
      .limit(1)
    if (existing === undefined) {
      throw new Error(`Could not read the existing job for ${input.item.source}/${input.item.externalId}`)
    }
    return { job: toJob(existing), created: false }
  })
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  const [row] = await db
    .select({ job: jobs, slot: slots.slot })
    .from(jobs)
    .leftJoin(slots, eq(slots.jobId, jobs.id))
    .where(eq(jobs.id, id))
    .limit(1)
  return row === undefined ? null : toJob(row)
}

export async function listJobs(db: Db, filter: { state?: JobState; limit?: number } = {}): Promise<Job[]> {
  const condition = and(filter.state === undefined ? undefined : eq(jobs.state, filter.state))
  const base = db
    .select({ job: jobs, slot: slots.slot })
    .from(jobs)
    .leftJoin(slots, eq(slots.jobId, jobs.id))
    .where(condition)
    .orderBy(desc(jobs.createdAt))
  // Unbounded unless asked: the reconciler must see every holding job, not a page of them.
  const rows = await (filter.limit === undefined ? base : base.limit(filter.limit))
  return rows.map((row) => toJob(row))
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Opens or closes the job's run for one state change (rules in src/runs.ts). Called inside the
 * transition's transaction, where the job row is locked, so two transitions cannot pick the same
 * run number.
 */
async function recordRunChange(
  tx: Tx,
  change: {
    jobId: string
    from: JobState
    to: JobState
    failureKind: FailureKind | null
    slot: number | null
    now: Date
  },
): Promise<void> {
  const { jobId, from, to } = change
  if (startsRun(from, to)) {
    const [latest] = await tx
      .select({ number: max(runs.runNumber) })
      .from(runs)
      .where(eq(runs.jobId, jobId))
    await tx.insert(runs).values({
      jobId,
      runNumber: (latest?.number ?? 0) + 1,
      slot: change.slot,
      startedAt: change.now,
    })
  } else if (endsRun(from, to)) {
    await tx
      .update(runs)
      .set({ endedAt: change.now, outcome: runOutcomeFor(to), failureKind: change.failureKind })
      .where(and(eq(runs.jobId, jobId), isNull(runs.endedAt)))
  }
}

export async function transitionJob(
  db: Db,
  id: string,
  to: JobState,
  opts: { now: Date; reason?: string; failureKind?: FailureKind; nextRunAt?: Date | null },
): Promise<Job> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update')
    if (current === undefined) {
      throw new Error(`Unknown job id: ${id}`)
    }

    const from = current.state
    assertTransition(from, to)

    const manualRetry = isManualRetry(from, to)
    const failureKind = recordsFailureKind(from, to) ? (opts.failureKind ?? null) : null
    const nextRunAt =
      opts.nextRunAt !== undefined ? opts.nextRunAt : manualRetry || to === 'claiming' ? null : current.nextRunAt

    const [updated] = await tx
      .update(jobs)
      .set({
        state: to,
        attempt: nextAttempt(from, to, current.attempt),
        failureKind,
        nextRunAt,
        updatedAt: opts.now,
      })
      .where(eq(jobs.id, id))
      .returning()
    if (updated === undefined) {
      throw new Error(`Unknown job id: ${id}`)
    }

    await tx.insert(jobEvents).values({
      jobId: id,
      fromState: from,
      toState: to,
      failureKind,
      reason: opts.reason ?? null,
      data: null,
      at: opts.now,
    })

    if (holdsSlot(from) && !holdsSlot(to)) {
      await tx.delete(slots).where(eq(slots.jobId, id))
    }

    const [slotRow] = await tx.select({ slot: slots.slot }).from(slots).where(eq(slots.jobId, id)).limit(1)

    await recordRunChange(tx, { jobId: id, from, to, failureKind, slot: slotRow?.slot ?? null, now: opts.now })

    return toJob({ job: updated, slot: slotRow?.slot ?? null })
  })
}

/** One initial attempt plus three retries after a competing allocator wins. */
const SLOT_ACQUIRE_ATTEMPTS = 4

export async function acquireSlot(db: Db, jobId: string, slotCount: number, now: Date): Promise<number | null> {
  for (let attempt = 1; attempt <= SLOT_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const [existing] = await tx.select({ slot: slots.slot }).from(slots).where(eq(slots.jobId, jobId)).limit(1)
        if (existing !== undefined) {
          return existing.slot
        }

        const taken = await tx.select({ slot: slots.slot }).from(slots)
        const free = allocateSlot(
          slotCount,
          taken.map((row) => row.slot),
        )
        if (free === null) {
          return null
        }

        await tx.insert(slots).values({ slot: free, jobId, acquiredAt: now })
        return free
      })
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error
      }
    }
  }
  return null
}

export async function releaseSlot(db: Db, jobId: string): Promise<void> {
  await db.delete(slots).where(eq(slots.jobId, jobId))
}

/**
 * A job's state changes, oldest first. When there are more than `limit`, the newest are kept: those
 * hold the current state and the failure that put it there, which is what a person needs.
 */
export async function listJobEvents(db: Db, jobId: string, limit = 200): Promise<JobEvent[]> {
  const rows = await db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(desc(jobEvents.id))
    .limit(limit)
  return rows.reverse().map((row) => ({
    fromState: row.fromState,
    toState: row.toState,
    failureKind: row.failureKind,
    reason: row.reason,
    at: row.at,
  }))
}

/** A job's runs, oldest first. Empty for a job that never took a slot. */
export async function listRuns(db: Db, jobId: string): Promise<Run[]> {
  const rows = await db.select().from(runs).where(eq(runs.jobId, jobId)).orderBy(asc(runs.runNumber))
  return rows.map(toRun)
}

/** The number of the job's newest run, or null when it never ran. */
export async function latestRunNumber(db: Db, jobId: string): Promise<number | null> {
  const [row] = await db
    .select({ number: max(runs.runNumber) })
    .from(runs)
    .where(eq(runs.jobId, jobId))
  return row?.number ?? null
}

export async function heldSlots(db: Db): Promise<{ slot: number; jobId: string; jobState: JobState | null }[]> {
  const rows = await db
    .select({ slot: slots.slot, jobId: slots.jobId, jobState: jobs.state })
    .from(slots)
    .leftJoin(jobs, eq(jobs.id, slots.jobId))
    .orderBy(slots.slot)
  return rows.map((row) => ({ slot: row.slot, jobId: row.jobId, jobState: row.jobState }))
}

export async function releaseLeakedSlots(db: Db): Promise<number[]> {
  const leaked = findLeakedSlots(await heldSlots(db))
  if (leaked.length === 0) {
    return []
  }
  await db.delete(slots).where(inArray(slots.slot, leaked))
  return leaked
}

export async function createAction(
  db: Db,
  input: { jobId: string; kind: string; payload: unknown; now: Date },
): Promise<PendingAction> {
  const [row] = await db
    .insert(pendingActions)
    .values({
      jobId: input.jobId,
      kind: input.kind,
      payload: input.payload,
      status: 'pending',
      reason: null,
      createdAt: input.now,
      decidedAt: null,
    })
    .returning()
  if (row === undefined) {
    throw new Error(`Could not create pending action for job ${input.jobId}`)
  }
  return toPendingAction(row)
}

export async function getAction(db: Db, id: string): Promise<PendingAction | null> {
  const [row] = await db.select().from(pendingActions).where(eq(pendingActions.id, id)).limit(1)
  return row === undefined ? null : toPendingAction(row)
}

export async function decideAction(
  db: Db,
  id: string,
  decision: 'approved' | 'rejected',
  opts: { now: Date; reason?: string },
): Promise<PendingAction> {
  const [row] = await db
    .update(pendingActions)
    .set({ status: decision, reason: opts.reason ?? null, decidedAt: opts.now })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, 'pending')))
    .returning()
  if (row !== undefined) {
    return toPendingAction(row)
  }

  const [existing] = await db.select().from(pendingActions).where(eq(pendingActions.id, id)).limit(1)
  if (existing === undefined) {
    throw new Error(`Unknown pending action: ${id}`)
  }
  throw new Error(`Pending action ${id} is ${existing.status}, not pending`)
}

export async function listActions(db: Db, filter: { status?: string; limit?: number } = {}): Promise<PendingAction[]> {
  const requested = filter.status === undefined ? undefined : actionStatus(filter.status)
  if (filter.status !== undefined && requested === undefined) {
    return []
  }
  const condition = requested === undefined ? undefined : eq(pendingActions.status, requested)
  const base = db.select().from(pendingActions).where(condition).orderBy(desc(pendingActions.createdAt))
  const rows = await (filter.limit === undefined ? base : base.limit(filter.limit))
  return rows.map((row) => toPendingAction(row))
}
