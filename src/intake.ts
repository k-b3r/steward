// One intake poll: collect the feed, decide with the pure policy, then create
// jobs and enqueue only the newly created queued ones. The poll timer lives in
// the caller; this file only computes the next delay.

import { decideIntake } from './intake-policy'
import type { Db } from './platform/db'
import type { Logger } from './platform/logger'
import type { Job, WorkFeed, WorkItem } from './types'

const MAX_POLL_DELAY_MS = 10 * 60_000
const JITTER_RATIO = 0.1

export type IntakeStore = {
  insertJob(
    db: Db,
    input: { item: WorkItem; state: 'proposed' | 'queued'; maxAttempts: number; now: Date },
  ): Promise<{ job: Job; created: boolean }>
  knownExternalIds(db: Db, source: string): Promise<Set<string>>
  countJobsForSource(db: Db, source: string): Promise<number>
  countOpenProposals(db: Db): Promise<number>
}

type IntakeConfig = {
  dryRun: boolean
  maxEnqueuePerPoll: number
  maxOpenProposals: number
  maxAttempts: number
}

export type IntakeDeps = {
  feed: WorkFeed
  db: Db
  logger: Logger
  queue: { enqueue(jobId: string): Promise<void> }
  config: IntakeConfig
  now: Date
  /** The real functions come from db/store and db/intake-queries; unit tests pass fakes. */
  store: IntakeStore
}

export type IntakeCounts = {
  queued: number
  proposed: number
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
    store.knownExternalIds(db, source),
    store.countJobsForSource(db, source),
    store.countOpenProposals(db),
  ])

  const result = decideIntake({
    items,
    knownExternalIds: known,
    sourceHasJobs: jobsForSource > 0,
    openProposals,
    maxOpenProposals: config.maxOpenProposals,
    maxEnqueuePerPoll: config.maxEnqueuePerPoll,
  })

  for (const decision of result.decisions) {
    logger.info('Intake decision', {
      source,
      externalId: decision.item.externalId,
      identifier: decision.item.identifier,
      action: decision.action,
      reason: decision.reason,
    })
  }
  for (const skip of result.skipped) {
    logger.info('Intake skipped', {
      source,
      externalId: skip.item.externalId,
      identifier: skip.item.identifier,
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
        externalId: decision.item.externalId,
        identifier: decision.item.identifier,
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
