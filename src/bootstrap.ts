// Builds the objects both entry points share. It reads no environment itself:
// the entry points pass the parsed config in.
import type { Config } from './platform/config'
import { createDb, createPool, type Db } from './platform/db'
import { createLogger, type Logger } from './platform/logger'
import { createEchoRunner } from './runner/echo'
import { createPiRunner } from './runner/pi'
import { createPodmanSpawn, execPodman } from './runner/podman'
import type { BackoffOptions } from './retry-policy'
import { createJobQueue } from './worker/queue'

/** First retry waits 30 s; the delay doubles up to 10 minutes. */
export const BACKOFF: BackoffOptions = { baseMs: 30_000, maxMs: 600_000 }

/** Config values that must never appear in a log line or a transcript step. */
export function secretsOf(config: Config): string[] {
  return [
    config.DATABASE_URL,
    config.TEST_DATABASE_URL,
    config.REDIS_QUEUE_URL,
    config.REDIS_SLOT_URL,
    config.LINEAR_API_KEY,
    config.API_TOKEN,
    config.PI_MODEL_API_KEY,
  ].filter((value): value is string => value !== undefined && value.length > 0)
}

/**
 * The environment the agent container gets: the model key, under the provider's own variable name.
 * Nothing else. `buildPiRunArgs` refuses any other name, so this cannot grow by accident.
 */
export function runnerEnv(config: Config): Record<string, string> {
  if (config.PI_MODEL_API_KEY === undefined) return {}
  return { [config.PI_MODEL_API_KEY_ENV]: config.PI_MODEL_API_KEY }
}

/**
 * The runner the worker uses: the echo stub, or the real agent in a Podman container. The switch
 * lives here so nothing downstream knows which one it has.
 */
function createRunner(
  config: Config,
  clock: () => Date,
  runsDir: string,
  ambient: Readonly<Record<string, string | undefined>>,
) {
  if (config.RUNNER === 'echo') {
    return createEchoRunner({ runsDir, clock })
  }
  return createPiRunner({
    spawn: createPodmanSpawn(ambient),
    execPodman,
    clock,
    sleep: (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const promise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      })
      return {
        promise,
        cancel: () => {
          if (timer !== undefined) clearTimeout(timer)
        },
      }
    },
    config: {
      instance: config.INSTANCE,
      image: config.PI_IMAGE,
      ...(config.PI_MODEL === undefined ? {} : { model: config.PI_MODEL }),
      runsDir,
      worktreePathFor: (jobId) => `${runsDir}/${jobId}/worktree`,
      limits: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
      turnCap: config.PI_TURN_CAP,
      runTimeoutMs: config.PI_TIMEOUT_MS,
      env: runnerEnv(config),
      secrets: secretsOf(config),
    },
  })
}

export function createContext(
  config: Config,
  write: (line: string) => void,
  ambient: Readonly<Record<string, string | undefined>> = {},
) {
  const clock = (): Date => new Date()
  const logger: Logger = createLogger({ write, clock, secrets: secretsOf(config) })
  // A dropped connection is logged, never fatal: the worker must survive a Postgres restart.
  const pool = createPool(config.DATABASE_URL, (error) => logger.error('Postgres pool error', error))
  const db: Db = createDb(pool)
  const queue = createJobQueue({ redisUrl: config.REDIS_QUEUE_URL, queueName: `steward-${config.INSTANCE}` })
  const runner = createRunner(config, clock, config.RUNS_DIR, ambient)
  return { clock, logger, pool, db, queue, runner }
}
