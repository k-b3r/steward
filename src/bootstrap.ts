// Builds the objects both entry points share. It reads no environment itself:
// the entry points pass the parsed config in.
import type { Config } from './platform/config'
import { createDb, createPool, type Db } from './platform/db'
import { createLogger, type Logger } from './platform/logger'
import { createEchoRunner } from './runner/echo'
import type { BackoffOptions } from './retry-policy'
import { createJobQueue } from './worker/queue'

/** First retry waits 30 s; the delay doubles up to 10 minutes. */
export const BACKOFF: BackoffOptions = { baseMs: 30_000, maxMs: 600_000 }

function secretsOf(config: Config): string[] {
  return [
    config.DATABASE_URL,
    config.TEST_DATABASE_URL,
    config.REDIS_QUEUE_URL,
    config.REDIS_SLOT_URL,
    config.LINEAR_API_KEY,
    config.API_TOKEN,
  ].filter((value): value is string => value !== undefined && value.length > 0)
}

export function createContext(config: Config, write: (line: string) => void) {
  const clock = (): Date => new Date()
  const logger: Logger = createLogger({ write, clock, secrets: secretsOf(config) })
  const pool = createPool(config.DATABASE_URL)
  const db: Db = createDb(pool)
  const queue = createJobQueue({ redisUrl: config.REDIS_QUEUE_URL, queueName: `steward-${config.INSTANCE}` })
  // TODO(phase-2): replace the echo runner with the Claude Code runner.
  const runner = createEchoRunner({ runsDir: config.RUNS_DIR, clock })
  return { clock, logger, pool, db, queue, runner }
}
