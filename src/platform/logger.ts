const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(['authorization', 'api_key', 'apikey', 'token', 'password'])

/**
 * The logging interface the rest of `src/` takes, built by `createLogger` and passed down from the
 * composition roots. Each call writes one JSON line whose message and string fields are redacted
 * against the secrets the logger was given, and whose credential-named keys are always `[REDACTED]`.
 * Nothing filters by level: every call writes.
 */
export type Logger = {
  /** One JSON line: `ts`, `level`, `msg`, then the redacted fields. A field named `msg` overrides it. */
  info(msg: string, fields?: Record<string, unknown>): void
  /** Level `warn`, used for a recovered problem such as a retried Linear request. Same shape as `info`. */
  warn(msg: string, fields?: Record<string, unknown>): void
  /** Level `error`, used for a failed intake poll. Same shape as `info`; no stack trace is added. */
  error(msg: string, fields?: Record<string, unknown>): void
}

/**
 * What `createLogger` cannot read for itself: the sink, the clock and the secret values. All three are
 * injected, which is why a test captures lines in an array and stamps them with a fixed date, while
 * production writes each line to stdout with `() => new Date()`.
 */
export type LoggerOptions = {
  /** Receives each finished line without a newline; production writes it to stdout with one added. */
  write: (line: string) => void
  /** Source of `ts`, through `toISOString()`. Production passes `() => new Date()`; tests a fixed date. */
  clock: () => Date
  /** Values replaced by `[REDACTED]` wherever they appear; empty strings are ignored. */
  secrets?: readonly string[]
}

/**
 * The severity a line can carry, from least to most serious, written as its `level` field. Local to
 * this file: `Logger` exposes one method per value, so a caller cannot invent another level.
 */
type LogLevel = 'info' | 'warn' | 'error'

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) redacted = redacted.split(secret).join(REDACTED)
  return redacted
}

function redactRecord(
  record: Record<string, unknown>,
  secrets: readonly string[],
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactValue(value, secrets, ancestors)
  }
  return redacted
}

function redactValue(value: unknown, secrets: readonly string[], ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (ancestors.has(value)) return CIRCULAR

  ancestors.add(value)
  const redacted = Array.isArray(value)
    ? value.map((item) => redactValue(item, secrets, ancestors))
    : redactRecord(value as Record<string, unknown>, secrets, ancestors)
  ancestors.delete(value)
  return redacted
}

/**
 * Creates a logger that writes one JSON line per call. Known secrets are replaced everywhere in
 * the message and fields (including nested strings), values under credential-like keys are always
 * `[REDACTED]`, and circular references become `[Circular]`. All I/O is injected for tests.
 */
export function createLogger(options: LoggerOptions): Logger {
  const secrets = [...new Set((options.secrets ?? []).filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  )

  function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const safeFields = redactRecord(fields, secrets, new WeakSet<object>())
    const line = JSON.stringify({
      ts: options.clock().toISOString(),
      level,
      msg: redactText(msg, secrets),
      ...safeFields,
    })
    options.write(line)
  }

  return {
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  }
}
