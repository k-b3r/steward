// Worker entry point: migrates, reconciles, consumes the queue and runs the intake poll.
import { readFileSync } from 'node:fs'

import { BACKOFF, createContext } from '../bootstrap'
import { createLinearClient } from '../linear'
import * as intakeQueries from '../db/intake-queries'
import { migrateDb } from '../db/migrate'
import * as store from '../db/store'
import { nextPollDelayMs, runIntakePoll } from '../intake'
import { loadConfig } from '../platform/config'
import { closePool } from '../platform/db'
import { sleep } from '../platform/delay'
import { createWorktree, removeWorktree } from '../platform/git'
import type { Logger } from '../platform/logger'
import { processJob } from './process-job'
import { reconcile } from './reconcile'

const RAW_RESPONSE_MESSAGE = 'Linear raw response'

/** Raw Linear responses hold ticket text: keep them for dry-run only. */
function withoutRawResponses(logger: Logger, dryRun: boolean): Logger {
  if (dryRun) return logger
  return { ...logger, info: (msg, fields) => (msg === RAW_RESPONSE_MESSAGE ? undefined : logger.info(msg, fields)) }
}

const configFile = process.env.STEWARD_CONFIG_FILE
const file: Record<string, unknown> | undefined =
  configFile === undefined ? undefined : (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>)
const config = loadConfig(process.env, file)
const ctx = createContext(config, (line) => process.stdout.write(`${line}\n`))
const { db, queue, runner, logger, clock } = ctx
let stopping = false

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
      config: { slotCount: config.SLOT_COUNT, repoPath: config.REPO_PATH, runsDir: config.RUNS_DIR, backoff: BACKOFF },
      queue,
      git: { createWorktree, removeWorktree },
      log: (msg) => logger.info(msg),
    },
    jobId,
  ),
)
logger.info('Worker started', { instance: config.INSTANCE, dryRun: config.DRY_RUN })

const feed = createLinearClient({
  apiKey: config.LINEAR_API_KEY,
  teamKey: config.LINEAR_TEAM_KEY,
  fetch,
  logger: withoutRawResponses(logger, config.DRY_RUN),
  sleep,
  rand: Math.random,
})

async function pollForever(): Promise<void> {
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

async function shutdown(): Promise<void> {
  stopping = true
  await queue.close()
  await closePool(ctx.pool)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

await pollForever()
