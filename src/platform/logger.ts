const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(['authorization', 'api_key', 'apikey', 'token', 'password'])

export type Logger = {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export type LoggerOptions = {
  write: (line: string) => void
  clock: () => Date
  secrets?: readonly string[]
}

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
