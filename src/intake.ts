// One intake poll: collect the feed, decide with the pure policy, then create
// jobs and enqueue only the newly created queued ones. The poll timer lives in
// the caller; this file only computes the next delay.

import { decideIntake } from './intake-policy'
import type { Db } from './platform/db'
import type { Logger } from './platform/logger'
import type { Job, WorkFeed, WorkItem } from './types'

const MAX_POLL_DELAY_MS = 10 * 60_000
const JITTER_RATIO = 0.1

/**
 * The database side of one poll, behind an interface so `runIntakePoll` can be tested without Postgres.
 * Production passes `insertJob` from src/db/store.ts plus the three reads from src/db/intake-queries.ts, all
 * wired in src/composition/worker.ts; src/intake.test.ts passes an in-memory fake.
 */
export type IntakeStore = {
  /**
   * Inserts the job row and its first `job_events` row in one transaction. `created` is false when a
   * job for this source and source id already exists; the existing row comes back instead.
   */
  insertJob(
    db: Db,
    input: { item: WorkItem; state: 'proposed' | 'queued'; maxAttempts: number; now: Date },
  ): Promise<{ job: Job; created: boolean }>
  /** Source ids that already have a job for this source; the policy skips those items. */
  knownSourceIds(db: Db, source: string): Promise<Set<string>>
  /** Number of job rows for this source. 0 tells the policy that this poll is the baseline. */
  countJobsForSource(db: Db, source: string): Promise<number>
  /** Count of `proposed` jobs across every source, not just this one, for the proposal cap. */
  countOpenProposals(db: Db): Promise<number>
}

/**
 * The four settings one poll needs, already validated and defaulted. src/composition/worker.ts builds it
 * from the `Config` in src/platform/config.ts (`DRY_RUN`, `MAX_ENQUEUE_PER_POLL`, `MAX_OPEN_PROPOSALS`,
 * `MAX_ATTEMPTS`); the defaults and bounds live in that zod schema, not in this file.
 */
type IntakeConfig = {
  /** When true, log the decisions and counts but insert no job and enqueue nothing. Defaults to true. */
  dryRun: boolean
  /** `MAX_ENQUEUE_PER_POLL`, default 2. More new In Progress items than this turns them all into proposals. */
  maxEnqueuePerPoll: number
  /** `MAX_OPEN_PROPOSALS`, default 20 and at least 1; proposals made in this poll count too. */
  maxOpenProposals: number
  /** `MAX_ATTEMPTS`, default 3 and at least 1; copied into each new job row. */
  maxAttempts: number
}

export type IntakeDeps = {
  /** The tracker feed. `poll()` is called once and drained fully. */
  feed: WorkFeed
  /** Drizzle handle, passed unchanged to every store call. */
  db: Db
  /** Gets one info line per decision and per skip, plus a finished line with the counts. */
  logger: Logger
  /** Only `enqueue` is used, once per newly created `queued` job. Dry runs never call it. */
  queue: { enqueue(jobId: string): Promise<void> }
  /** Parsed worker config: the caps and the dry-run flag, as validated by platform/config. */
  config: IntakeConfig
  /** One clock reading for the whole poll; it becomes each new row's `created_at` and event time. */
  now: Date
  /** The real functions come from db/store and db/intake-queries; unit tests pass fakes. */
  store: IntakeStore
}

export type IntakeCounts = {
  /** Jobs created as `queued` and enqueued; in a dry run, the number that would have been. */
  queued: number
  /** Jobs created as `proposed`; in a dry run, the number that would have been. */
  proposed: number
  /** Skipped items; outside a dry run it also counts inserts that lost the race for the same issue. */
  skipped: number
}

function logFinished(logger: Logger, dryRun: boolean, counts: IntakeCounts): void {
  logger.info('Intake poll finished', { dryRun, ...counts })
}

/**
 * Runs one intake poll. In dry-run mode it logs every decision and the counts
 * but creates no job and calls no enqueue.
 */
export async function runIntakePoll(deps: IntakeDeps): Promise<IntakeCounts> {
  const { feed, db, logger, queue, config, now, store } = deps

  const items: WorkItem[] = []
  for await (const item of feed.poll()) {
    items.push(item)
  }

  const source = items[0]?.source
  if (source === undefined) {
    const empty = { queued: 0, proposed: 0, skipped: 0 }
    logFinished(logger, config.dryRun, empty)
    return empty
  }

  const [known, jobsForSource, openProposals] = await Promise.all([
    store.knownSourceIds(db, source),
    store.countJobsForSource(db, source),
    store.countOpenProposals(db),
  ])

  const result = decideIntake({
    items,
    knownSourceIds: known,
    sourceHasJobs: jobsForSource > 0,
    openProposals,
    maxOpenProposals: config.maxOpenProposals,
    maxEnqueuePerPoll: config.maxEnqueuePerPoll,
  })

  for (const decision of result.decisions) {
    logger.info('Intake decision', {
      source,
      sourceId: decision.item.sourceId,
      ticketKey: decision.item.ticketKey,
      action: decision.action,
      reason: decision.reason,
    })
  }
  for (const skip of result.skipped) {
    logger.info('Intake skipped', {
      source,
      sourceId: skip.item.sourceId,
      ticketKey: skip.item.ticketKey,
      reason: skip.reason,
    })
  }

  if (config.dryRun) {
    const counts = {
      queued: result.decisions.filter((decision) => decision.action === 'queue').length,
      proposed: result.decisions.filter((decision) => decision.action === 'propose').length,
      skipped: result.skipped.length,
    }
    logFinished(logger, true, counts)
    return counts
  }

  let queued = 0
  let proposed = 0
  let duplicates = 0

  for (const decision of result.decisions) {
    const state = decision.action === 'queue' ? 'queued' : 'proposed'
    const { job, created } = await store.insertJob(db, {
      item: decision.item,
      state,
      maxAttempts: config.maxAttempts,
      now,
    })

    if (!created) {
      duplicates += 1
      logger.info('Intake duplicate between decision and insert', {
        source,
        sourceId: decision.item.sourceId,
        ticketKey: decision.item.ticketKey,
      })
      continue
    }

    if (decision.action === 'queue') {
      await queue.enqueue(job.id)
      queued += 1
    } else {
      proposed += 1
    }
  }

  const counts = { queued, proposed, skipped: result.skipped.length + duplicates }
  logFinished(logger, false, counts)
  return counts
}

/**
 * Delay before the next poll. With no consecutive failures it is the interval
 * plus up to ±10% jitter; each failure doubles it, capped at ten minutes.
 * `rand` is in [0, 1).
 */
export function nextPollDelayMs(intervalMs: number, rand: number, failures: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError(`intervalMs must be a positive number, got ${String(intervalMs)}`)
  }
  if (!(rand >= 0 && rand < 1)) {
    throw new RangeError(`rand must be in [0, 1), got ${String(rand)}`)
  }
  if (!Number.isInteger(failures) || failures < 0) {
    throw new RangeError(`failures must be an integer >= 0, got ${String(failures)}`)
  }

  const base = Math.min(MAX_POLL_DELAY_MS, intervalMs * 2 ** failures)
  const jittered = base * (1 - JITTER_RATIO + 2 * JITTER_RATIO * rand)
  return Math.min(MAX_POLL_DELAY_MS, Math.round(jittered))
}
