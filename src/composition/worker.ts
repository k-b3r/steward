// Builds the worker process: migrate, reconcile, consume the queue, poll the feed.
// The wiring lives here; src/entries/worker.ts only starts and stops it.
import { BACKOFF, createContext } from '../bootstrap'
import { createLinearClient } from '../linear'
import * as intakeQueries from '../db/intake-queries'
import { migrateDb } from '../db/migrate'
import * as store from '../db/store'
import { nextPollDelayMs, runIntakePoll } from '../intake'
import type { Config } from '../platform/config'
import { closePool } from '../platform/db'
import { sleep } from '../platform/delay'
import { createWorktree, removeWorktree } from '../platform/git'
import type { Logger } from '../platform/logger'
import { processJob } from '../worker/process-job'
import { reconcile } from '../worker/reconcile'

const RAW_RESPONSE_MESSAGE = 'Linear raw response'

/** Raw Linear responses hold ticket text: keep them for dry-run only. */
function withoutRawResponses(logger: Logger, dryRun: boolean): Logger {
  if (dryRun) return logger
  return { ...logger, info: (msg, fields) => (msg === RAW_RESPONSE_MESSAGE ? undefined : logger.info(msg, fields)) }
}

export function composeWorker(config: Config, write: (line: string) => void) {
  const ctx = createContext(config, write)
  const { db, queue, runner, logger, clock } = ctx
  let stopping = false

  const start = async (): Promise<void> => {
    await migrateDb(db)
    // No job survives a restart of this single worker process, so none has a live worker.
    const report = await reconcile(
      { db, queue, isWorkerAlive: () => Promise.resolve(false) },
      { now: clock(), rand: Math.random, backoff: BACKOFF, slotCount: config.SLOT_COUNT },
    )
    logger.info('Reconciled on startup', { ...report })

    await queue.startWorker((jobId) =>
      processJob(
        {
          db,
          runner,
          clock,
          rand: Math.random,
          config: {
            slotCount: config.SLOT_COUNT,
            repoPath: config.REPO_PATH,
            runsDir: config.RUNS_DIR,
            backoff: BACKOFF,
          },
          queue,
          git: { createWorktree, removeWorktree },
          log: (msg) => logger.info(msg),
        },
        jobId,
      ),
    )
    logger.info('Worker started', { instance: config.INSTANCE, dryRun: config.DRY_RUN })
  }

  const feed = createLinearClient({
    apiKey: config.LINEAR_API_KEY,
    teamKey: config.LINEAR_TEAM_KEY,
    fetch,
    logger: withoutRawResponses(logger, config.DRY_RUN),
    sleep,
    rand: Math.random,
  })

  const poll = async (): Promise<void> => {
    let failures = 0
    while (!stopping) {
      try {
        await runIntakePoll({
          feed,
          db,
          logger,
          queue,
          now: clock(),
          store: {
            insertJob: store.insertJob,
            knownExternalIds: intakeQueries.knownExternalIds,
            countJobsForSource: intakeQueries.countJobsForSource,
            countOpenProposals: intakeQueries.countOpenProposals,
          },
          config: {
            dryRun: config.DRY_RUN,
            maxEnqueuePerPoll: config.MAX_ENQUEUE_PER_POLL,
            maxOpenProposals: config.MAX_OPEN_PROPOSALS,
            maxAttempts: config.MAX_ATTEMPTS,
          },
        })
        failures = 0
      } catch (error) {
        failures += 1
        logger.error('Intake poll failed', { failures, error: error instanceof Error ? error.message : 'unknown' })
      }
      await sleep(nextPollDelayMs(config.POLL_INTERVAL_MS, Math.random(), failures))
    }
  }

  const close = async (): Promise<void> => {
    stopping = true
    await queue.close()
    await closePool(ctx.pool)
  }

  return { start, poll, close, logger }
}
