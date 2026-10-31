// Startup reconciler: repairs the gap between Postgres and the queue after a
// restart. The clock, randomness, queue and liveness probe are injected, so the
// function is deterministic in tests.
import { assertSlotCount, HOLDING_STATES } from '../allocate'
import { listJobs, releaseLeakedSlots, transitionJob } from '../db/store'
import type { Db } from '../platform/db'
import { decideAfterFailure } from '../retry-policy'
import type { BackoffOptions } from '../retry-policy'
import type { Job } from '../types'

/**
 * The two queue operations a reconcile pass needs, and no more. Production passes the `JobQueue` that
 * `createJobQueue` returns, which satisfies this structurally; the integration tests pass a
 * set-backed fake. Narrower than `JobQueue` on purpose: a pass may deliver and look up, but only the
 * composition root starts the consumer or closes the queue.
 */
export type ReconcileQueue = {
  /** True while a waiting, delayed, prioritized or active record exists for the job. */
  hasJob(jobId: string): Promise<boolean>
  /** Adds the job with an optional delay; a no-op when a pending record already exists for it. */
  enqueue(jobId: string, delayMs?: number): Promise<void>
}

/**
 * The outside world one pass reads and writes: the store, the queue and the liveness probe, all
 * supplied by the composition root. `isWorkerAlive` is a function rather than a flag because a later
 * multi-worker deployment could ask for real; production answers `false` today, since this process
 * is the only worker on the instance.
 */
export type ReconcileDeps = {
  /** The Postgres store the reconciler reads jobs from and writes states to. */
  db: Db
  /** The job queue; production passes the BullMQ queue, tests a fake that records enqueues. */
  queue: ReconcileQueue
  /** Whether a live worker still owns the job; production passes `() => false`, as the worker just restarted. */
  isWorkerAlive(jobId: string): Promise<boolean>
}

/**
 * The run-wide inputs of one pass: a single clock reading for every transition and delay, one jitter
 * value per retried job, the backoff limits, and the slot count. That count must equal `SLOT_COUNT`:
 * `assertSlotCount` rejects anything outside 1..16 before the pass writes. Tests pass a constant
 * `rand` and shorter backoff limits.
 */
export type ReconcileOptions = {
  /** The restart time, used for every transition and backoff delay in this run. */
  now: Date
  /** Number in [0, 1) for backoff jitter; production passes `Math.random`, tests a constant. */
  rand: () => number
  /** Retry delays; production passes `BACKOFF` from `src/bootstrap.ts`, tests shorter values. */
  backoff: BackoffOptions
  /** Total slots, checked by `assertSlotCount`: an integer in 1..16. Must match `SLOT_COUNT`. */
  slotCount: number
}

/**
 * What one pass changed, returned by `reconcile`. The composition root logs it as the fields of its
 * `Reconciled on startup` line and the integration tests assert on it; nothing else reads these
 * arrays. A job id appears in at most one of the three id lists. If any step fails, the pass throws
 * one `AggregateError` instead, so a partial report is never returned.
 */
export type ReconcileReport = {
  /** Job ids that were `queued` in Postgres but missing from the queue, and are now enqueued. */
  requeued: string[]
  /** Job ids that a dead worker left in a slot-holding state, now `queued` with a backoff delay. */
  retried: string[]
  /** Job ids a dead worker left behind with no attempt left, now `failed` with kind `infra`. */
  failed: string[]
  /** Slot numbers (0 to `slotCount - 1`) whose rows were deleted because no job holds them. */
  slotsFreed: number[]
}

const WORKER_LOST_REASON = 'worker lost on restart'
const RETRIES_EXHAUSTED_REASON = 'worker lost on restart; retries exhausted'

function delayMsFor(job: Job, now: Date): number {
  if (job.nextRunAt === null) {
    return 0
  }
  return Math.max(0, job.nextRunAt.getTime() - now.getTime())
}

/** Returns whether the job was retried (and therefore enqueued) or failed. */
async function recoverLostJob(deps: ReconcileDeps, job: Job, opts: ReconcileOptions): Promise<'retried' | 'failed'> {
  const decision = decideAfterFailure({
    kind: 'infra',
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    now: opts.now,
    rand: opts.rand(),
    backoff: opts.backoff,
  })

  if (decision.action === 'fail') {
    await transitionJob(deps.db, job.id, 'failed', {
      now: opts.now,
      failureKind: 'infra',
      reason: RETRIES_EXHAUSTED_REASON,
    })
    return 'failed'
  }

  await transitionJob(deps.db, job.id, 'queued', {
    now: opts.now,
    failureKind: 'infra',
    reason: WORKER_LOST_REASON,
    nextRunAt: decision.nextRunAt,
  })
  await deps.queue.enqueue(job.id, Math.max(0, decision.nextRunAt.getTime() - opts.now.getTime()))
  return 'retried'
}

/**
 * Repairs jobs left behind by a restart, before the worker takes new work.
 *
 * Claims with no live worker are retried with backoff or failed as `infra`,
 * leaked slots are released, and queued jobs missing from the queue are
 * enqueued. Running it twice in a row leaves the second run with nothing to do.
 * A failure on one job is collected so the others are still reconciled; the
 * collected errors are rethrown together at the end.
 */
export async function reconcile(deps: ReconcileDeps, opts: ReconcileOptions): Promise<ReconcileReport> {
  assertSlotCount(opts.slotCount)

  const report: ReconcileReport = { requeued: [], retried: [], failed: [], slotsFreed: [] }
  const errors: unknown[] = []
  const enqueuedRetries = new Set<string>()

  for (const state of HOLDING_STATES) {
    for (const job of await listJobs(deps.db, { state })) {
      try {
        if (await deps.isWorkerAlive(job.id)) {
          continue
        }
        const outcome = await recoverLostJob(deps, job, opts)
        if (outcome === 'retried') {
          report.retried.push(job.id)
          enqueuedRetries.add(job.id)
        } else {
          report.failed.push(job.id)
        }
      } catch (error) {
        errors.push(error)
      }
    }
  }

  try {
    report.slotsFreed = await releaseLeakedSlots(deps.db)
  } catch (error) {
    errors.push(error)
  }

  for (const job of await listJobs(deps.db, { state: 'queued' })) {
    if (enqueuedRetries.has(job.id)) {
      continue
    }
    try {
      if (await deps.queue.hasJob(job.id)) {
        continue
      }
      await deps.queue.enqueue(job.id, delayMsFor(job, opts.now))
      report.requeued.push(job.id)
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, `Reconciler could not repair ${errors.length} item(s)`)
  }

  return report
}
