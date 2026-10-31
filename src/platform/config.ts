import { isAbsolute } from 'node:path'

import { z } from 'zod'

const SECRET_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'REDIS_QUEUE_URL',
  'REDIS_SLOT_URL',
  'LINEAR_API_KEY',
  'API_TOKEN',
] as const

const SECRET_KEY_SET: ReadonlySet<string> = new Set(SECRET_KEYS)
const REDACTED = '[REDACTED]'

/**
 * The parsed instance settings: the value `loadConfig` returns, never the raw environment. Every value
 * is checked, coerced and defaulted in that loader, so an integer field is already a number and a list
 * field is already an array. Secrets are accepted only from the environment, and a secret key in the
 * JSON config file throws; the loader also refuses a `REDIS_QUEUE_URL` equal to `REDIS_SLOT_URL`.
 * Pass it to a composition root, and print it through `redactConfig` rather than raw.
 */
export type Config = {
  /** Required. Lowercase, letter first, up to 31 chars: `^[a-z][a-z0-9-]{0,30}$`. Names the BullMQ queue. */
  INSTANCE: string
  /** Secret. Required Postgres URL; the pool in `src/bootstrap.ts` connects with it. */
  DATABASE_URL: string
  /** Secret. Optional Postgres URL for integration tests only; an empty string counts as unset. */
  TEST_DATABASE_URL?: string
  /** Secret. Required Redis URL for BullMQ; must differ from `REDIS_SLOT_URL` or loading throws. */
  REDIS_QUEUE_URL: string
  /** Secret. Required Redis URL for slot state; validated and redacted, but no code connects to it yet. */
  REDIS_SLOT_URL: string
  /** Secret. Required Linear API key sent by the worker's feed client. */
  LINEAR_API_KEY: string
  /** Required Linear team key the feed filters tickets by; not a secret. */
  LINEAR_TEAM_KEY: string
  /** The GitHub account this instance pushes as. Never a token; the token is read at push time. */
  GH_ACCOUNT: string
  /** The author identity the agent commits with inside the container. */
  GIT_USER_NAME: string
  /** Required email; only `scripts/setup-repo.sh` reads it, to pin the clone's git identity. */
  GIT_USER_EMAIL: string
  /** Secret. Bearer token of at least 32 characters that every `/v1` request must send. */
  API_TOKEN: string
  /** Port the API binds on `127.0.0.1`; integer 1024..65535, default 3000. The Host check expects it too. */
  API_PORT: number
  /** Comma-separated URL origins the Origin check accepts; empty or absent lets in only requests with no Origin. */
  ALLOWED_ORIGINS: string[]
  /** Comma-separated extra Host values, for example `example.com:8443`; lowercased, empty by default. */
  ALLOWED_HOSTS: string[]
  /** Most jobs that may run at once; integer 1..16, default 3. Slot numbers run from 0 to `SLOT_COUNT - 1`. */
  SLOT_COUNT: number
  /** Milliseconds between intake polls; integer of at least 1000, default 30000. */
  POLL_INTERVAL_MS: number
  /** Most new `In Progress` tickets one poll may queue; the rest become proposals. Integer, min 0, default 2. */
  MAX_ENQUEUE_PER_POLL: number
  /** Most proposals that may wait for a decision at once, min 1, default 20; at the cap new ones are skipped. */
  MAX_OPEN_PROPOSALS: number
  /** Age in days for a run-folder sweep; integer of at least 1, default 30. Parsed only: nothing reads it yet. */
  RUN_RETENTION_DAYS: number
  /** Attempts a new job row starts with, min 1, default 3; copied into each row and used by the retry policy. */
  MAX_ATTEMPTS: number
  /**
   * Boolean, default true. The intake poll then logs each decision and writes no job row,
   * proposal or queue entry. Only while true is the raw Linear response logged.
   */
  DRY_RUN: boolean
  /** Absolute path of the git clone the worker creates worktrees from. */
  REPO_PATH: string
  /** Branch a new `agent/*` branch starts from. */
  BASE_BRANCH: string
  /** Built dashboard to serve from the API's origin; unset serves only /v1. */
  DASHBOARD_DIR?: string
  /** Tracker statuses the orchestrator may move a ticket into. Parsed only: nothing reads it until phase 4. */
  ALLOWED_STATUSES: string[]
  /** Root of the per-job output folders; default `$HOME/steward-instances/$INSTANCE/runs`, required without HOME. */
  RUNS_DIR: string
}

function parseInteger(value: unknown): unknown {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return Number(value)
  return value
}

function integerField(options: { min: number; max?: number; fallback?: number }) {
  const number = z.number().int().min(options.min)
  const bounded = options.max === undefined ? number : number.max(options.max)
  return z.preprocess((value) => (value === undefined ? options.fallback : parseInteger(value)), bounded)
}

function isUrlOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
  } catch {
    return false
  }
}

function parseOrigins(value: unknown): unknown {
  if (value === undefined) return []
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return []
  return trimmed.split(',').map((origin) => origin.trim())
}

function parseHosts(value: unknown): unknown {
  const hosts = parseOrigins(value)
  return Array.isArray(hosts) ? hosts.map((host) => (typeof host === 'string' ? host.toLowerCase() : host)) : hosts
}

const HOST_VALUE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/

function isHostValue(host: string): boolean {
  return HOST_VALUE.test(host)
}

/** The one status the orchestrator may move a ticket into, as a comma-separated list. */
function parseStatuses(value: unknown): unknown {
  if (value === undefined) return ['In Progress']
  if (typeof value !== 'string') return value
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function parseDryRun(value: unknown): unknown {
  if (value === undefined) return true
  if (value === 'true' || value === '1' || value === true) return true
  if (value === 'false' || value === '0' || value === false) return false
  return value
}

function pick(name: string, env: Record<string, string | undefined>, file: Record<string, unknown>): unknown {
  const fromEnv = env[name]
  if (fromEnv !== undefined) return fromEnv
  if (Object.hasOwn(file, name)) return file[name]
  return undefined
}

function providedSecretValues(env: Record<string, string | undefined>, file: Record<string, unknown>): string[] {
  const values = new Set<string>()
  for (const key of SECRET_KEYS) {
    const value = env[key] ?? file[key]
    if (typeof value === 'string' && value.length > 0) values.add(value)
  }
  return [...values].sort((left, right) => right.length - left.length)
}

function redactSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message
  for (const secret of secrets) redacted = redacted.split(secret).join(REDACTED)
  return redacted
}

const configSchema = z.object({
  INSTANCE: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'must match /^[a-z][a-z0-9-]{0,30}$/'),
  DATABASE_URL: z.string().min(1, 'must not be empty'),
  TEST_DATABASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1, 'must not be empty').optional(),
  ),
  REDIS_QUEUE_URL: z.string().min(1, 'must not be empty'),
  REDIS_SLOT_URL: z.string().min(1, 'must not be empty'),
  LINEAR_API_KEY: z.string().min(1, 'must not be empty'),
  LINEAR_TEAM_KEY: z.string().min(1, 'must not be empty'),
  GH_ACCOUNT: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, 'must be a GitHub account name'),
  GIT_USER_NAME: z.string().min(1, 'must not be empty'),
  GIT_USER_EMAIL: z.email('must be an email address'),
  API_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  API_PORT: integerField({ min: 1024, max: 65535, fallback: 3000 }),
  ALLOWED_ORIGINS: z.preprocess(
    parseOrigins,
    z.array(z.string()).refine((origins) => origins.every(isUrlOrigin), 'each entry must be a valid URL origin'),
  ),
  ALLOWED_HOSTS: z.preprocess(
    parseHosts,
    z
      .array(z.string())
      .refine((hosts) => hosts.every(isHostValue), 'each entry must be a host name, with an optional :port'),
  ),
  SLOT_COUNT: integerField({ min: 1, max: 16, fallback: 3 }),
  POLL_INTERVAL_MS: integerField({ min: 1000, fallback: 30000 }),
  MAX_ENQUEUE_PER_POLL: integerField({ min: 0, fallback: 2 }),
  MAX_OPEN_PROPOSALS: integerField({ min: 1, fallback: 20 }),
  RUN_RETENTION_DAYS: integerField({ min: 1, fallback: 30 }),
  MAX_ATTEMPTS: integerField({ min: 1, fallback: 3 }),
  DRY_RUN: z.preprocess(parseDryRun, z.boolean()),
  REPO_PATH: z
    .string()
    .min(1, 'must not be empty')
    .refine((value) => isAbsolute(value), 'must be an absolute path'),
  // Absent or empty means the default branch name, the same way an empty DASHBOARD_DIR means unset.
  BASE_BRANCH: z.preprocess((value) => (value === undefined || value === '' ? 'main' : value), z.string().min(1)),
  DASHBOARD_DIR: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .min(1, 'must not be empty')
      .refine((value) => isAbsolute(value), 'must be an absolute path')
      .optional(),
  ),
  ALLOWED_STATUSES: z.preprocess(parseStatuses, z.array(z.string().min(1)).min(1)),
  RUNS_DIR: z.string().min(1, 'must not be empty'),
})

/**
 * Validates and normalizes the instance config. `env` is the instance environment (read in the
 * entry point, never here); `file` is a non-secret JSON config whose keys use the same names.
 * Env values win over file values. Secrets are only accepted from `env`: a secret key in `file`
 * throws. Errors name keys and never include secret values.
 */
export function loadConfig(env: Record<string, string | undefined>, file: Record<string, unknown> = {}): Config {
  for (const key of SECRET_KEYS) {
    if (Object.hasOwn(file, key)) {
      throw new Error(`${key} is a secret and must be set in the environment, not in the config file`)
    }
  }

  const instance = pick('INSTANCE', env, file)
  const explicitRunsDir = pick('RUNS_DIR', env, file)
  const home = env.HOME
  const defaultRunsDir =
    typeof instance === 'string' && typeof home === 'string' && home.length > 0
      ? `${home}/steward-instances/${instance}/runs`
      : undefined

  const raw = {
    INSTANCE: instance,
    DATABASE_URL: pick('DATABASE_URL', env, file),
    TEST_DATABASE_URL: pick('TEST_DATABASE_URL', env, file),
    REDIS_QUEUE_URL: pick('REDIS_QUEUE_URL', env, file),
    REDIS_SLOT_URL: pick('REDIS_SLOT_URL', env, file),
    LINEAR_API_KEY: pick('LINEAR_API_KEY', env, file),
    LINEAR_TEAM_KEY: pick('LINEAR_TEAM_KEY', env, file),
    GH_ACCOUNT: pick('GH_ACCOUNT', env, file),
    GIT_USER_NAME: pick('GIT_USER_NAME', env, file),
    GIT_USER_EMAIL: pick('GIT_USER_EMAIL', env, file),
    API_TOKEN: pick('API_TOKEN', env, file),
    API_PORT: pick('API_PORT', env, file),
    ALLOWED_ORIGINS: pick('ALLOWED_ORIGINS', env, file),
    ALLOWED_HOSTS: pick('ALLOWED_HOSTS', env, file),
    SLOT_COUNT: pick('SLOT_COUNT', env, file),
    POLL_INTERVAL_MS: pick('POLL_INTERVAL_MS', env, file),
    MAX_ENQUEUE_PER_POLL: pick('MAX_ENQUEUE_PER_POLL', env, file),
    MAX_OPEN_PROPOSALS: pick('MAX_OPEN_PROPOSALS', env, file),
    RUN_RETENTION_DAYS: pick('RUN_RETENTION_DAYS', env, file),
    MAX_ATTEMPTS: pick('MAX_ATTEMPTS', env, file),
    DRY_RUN: pick('DRY_RUN', env, file),
    REPO_PATH: pick('REPO_PATH', env, file),
    BASE_BRANCH: pick('BASE_BRANCH', env, file),
    DASHBOARD_DIR: pick('DASHBOARD_DIR', env, file),
    ALLOWED_STATUSES: pick('ALLOWED_STATUSES', env, file),
    RUNS_DIR: explicitRunsDir ?? defaultRunsDir,
  }

  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'config'
      return `${path}: ${issue.message}`
    })
    const message = `Invalid configuration:\n${details.join('\n')}`
    throw new Error(redactSecrets(message, providedSecretValues(env, file)))
  }

  const config = parsed.data
  if (config.REDIS_QUEUE_URL === config.REDIS_SLOT_URL) {
    throw new Error('REDIS_QUEUE_URL and REDIS_SLOT_URL must point to different Redis instances')
  }
  return config
}

/** Returns a copy of the config safe to print: every secret key present becomes `[REDACTED]`. */
export function redactConfig(config: Config): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEY_SET.has(key)) {
      if (value !== undefined) redacted[key] = REDACTED
    } else if ((key === 'ALLOWED_ORIGINS' || key === 'ALLOWED_HOSTS') && Array.isArray(value)) {
      redacted[key] = [...value]
    } else {
      redacted[key] = value
    }
  }
  return redacted
}

/** External names derived from an instance name; hyphens are legal in units and networks. */
export function instanceNames(instance: string): { unit: string; dbName: string; redisNetwork: string } {
  return {
    unit: `steward@${instance}`,
    dbName: `steward_${instance.replaceAll('-', '_')}`,
    redisNetwork: `steward-${instance}-net`,
  }
}
