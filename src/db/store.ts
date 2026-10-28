// Postgres-backed job store. Every function takes the drizzle handle and an
// explicit `now: Date`; nothing here reads the clock or the environment.
import { and, desc, eq, inArray } from 'drizzle-orm'

import { allocateSlot, findLeakedSlots, holdsSlot } from '../allocate'
import { assertTransition } from '../transitions'
import type { FailureKind, Job, JobState, WorkItem } from '../types'
import type { Db } from '../platform/db'
import { ACTION_STATUSES, jobEvents, jobs, pendingActions, slots, type ActionStatus } from './schema'

export type PendingAction = {
  id: string
  jobId: string
  kind: string
  payload: unknown
  status: ActionStatus
  reason: string | null
  createdAt: Date
  decidedAt: Date | null
}

type JobRow = typeof jobs.$inferSelect
type PendingActionRow = typeof pendingActions.$inferSelect
type JobWithSlot = { job: JobRow; slot: number | null }

function toJob(row: JobWithSlot): Job {
  return {
    id: row.job.id,
    source: row.job.source,
    externalId: row.job.externalId,
    identifier: row.job.identifier,
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

export async function listJobs(db: Db, filter: { state?: JobState } = {}): Promise<Job[]> {
  const condition = filter.state === undefined ? undefined : eq(jobs.state, filter.state)
  const rows = await db
    .select({ job: jobs, slot: slots.slot })
    .from(jobs)
    .leftJoin(slots, eq(slots.jobId, jobs.id))
    .where(condition)
    .orderBy(desc(jobs.createdAt))
  return rows.map((row) => toJob(row))
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

export async function listActions(db: Db, filter: { status?: string } = {}): Promise<PendingAction[]> {
  const requested = filter.status === undefined ? undefined : actionStatus(filter.status)
  if (filter.status !== undefined && requested === undefined) {
    return []
  }
  const condition = requested === undefined ? undefined : eq(pendingActions.status, requested)
  const rows = await db.select().from(pendingActions).where(condition).orderBy(desc(pendingActions.createdAt))
  return rows.map((row) => toPendingAction(row))
}
