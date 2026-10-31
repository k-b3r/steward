import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRANSCRIPT_KINDS = ['system', 'assistant', 'tool', 'result', 'error', 'orchestrator'] as const
export type TranscriptKind = (typeof TRANSCRIPT_KINDS)[number]

export type Envelope = {
  /** 1-based line number in the job's transcript, monotonic. Also the SSE `id`, so `Last-Event-ID` resumes after it. */
  seq: number
  /** ISO 8601 UTC string from the writer's clock at append time, for example `2026-01-02T03:04:05.000Z`. */
  ts: string
  /**
   * `orchestrator` for lines the orchestrator writes itself, otherwise the agent event's own type.
   * Every kind is written to `transcript.jsonl`; agent lines also copy the raw line to `raw.jsonl`.
   */
  kind: TranscriptKind
  /**
   * Parsed line body. Orchestrator lines hold `{ msg, ...extra }` with secrets redacted; agent lines
   * hold the event as the runner sent it, unredacted. `raw.jsonl` is never served by the API.
   */
  data: unknown
}

export interface TranscriptWriter {
  /** Appends one `orchestrator` line whose `data` is `{ msg, ...data }` with secrets and `authorization` redacted. */
  writeOrchestrator(msg: string, data?: Record<string, unknown>): Envelope
  /**
   * Appends `rawLine` byte-exact to `raw.jsonl` and `event` to the transcript under `kind`.
   * `orchestrator` is excluded because those lines come from `writeOrchestrator`.
   */
  writeAgent(kind: Exclude<TranscriptKind, 'orchestrator'>, event: unknown, rawLine: string): Envelope
}

const TRANSCRIPT_FILE = 'transcript.jsonl'
const RAW_FILE = 'raw.jsonl'
const REDACTED = '[REDACTED]'

export function createTranscriptWriter(opts: {
  dir: string
  clock: () => Date
  secrets?: readonly string[]
}): TranscriptWriter {
  const { dir, clock, secrets = [] } = opts
  const nonEmptySecrets = [...secrets]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const transcriptPath = join(dir, TRANSCRIPT_FILE)
  repairPartialLine(transcriptPath)
  let nextSeq = Math.max(0, ...readTranscript(dir, 0).map((envelope) => envelope.seq)) + 1

  const appendEnvelope = (kind: TranscriptKind, data: unknown): Envelope => {
    const envelope: Envelope = {
      seq: nextSeq,
      ts: clock().toISOString(),
      kind,
      data,
    }
    nextSeq += 1
    appendFileSync(transcriptPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 })
    return envelope
  }

  return {
    writeOrchestrator(msg, data = {}) {
      const redacted = redactRecord({ msg, ...data }, nonEmptySecrets)
      return appendEnvelope('orchestrator', redacted)
    },

    writeAgent(kind, event, rawLine) {
      appendFileSync(join(dir, RAW_FILE), `${rawLine}\n`, { mode: 0o600 })
      return appendEnvelope(kind, event)
    },
  }
}

/** A crash can leave the last line without its newline; end it so the next append starts a fresh line. */
function repairPartialLine(path: string): void {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return
    throw error
  }
  if (content.length > 0 && !content.endsWith('\n')) appendFileSync(path, '\n')
}

export function readTranscript(dir: string, afterSeq: number): Envelope[] {
  let content: string
  try {
    content = readFileSync(join(dir, TRANSCRIPT_FILE), 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return []
    throw error
  }

  const envelopes: Envelope[] = []
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A crash can leave the final append half written; earlier lines stay valid.
      continue
    }

    if (isEnvelope(parsed) && parsed.seq > afterSeq) envelopes.push(parsed)
  }
  return envelopes
}

function redactRecord(record: Record<string, unknown>, secrets: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = key.toLowerCase() === 'authorization' ? REDACTED : redactValue(value, secrets)
  }
  return result
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (isPlainObject(value)) return redactRecord(value, secrets)
  return value
}

function redactString(value: string, secrets: readonly string[]): string {
  let result = value
  for (const secret of secrets) {
    result = result.split(secret).join(REDACTED)
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isEnvelope(value: unknown): value is Envelope {
  if (!isPlainObject(value)) return false
  return (
    typeof value.seq === 'number' &&
    Number.isInteger(value.seq) &&
    typeof value.ts === 'string' &&
    isTranscriptKind(value.kind)
  )
}

function isTranscriptKind(value: unknown): value is TranscriptKind {
  return TRANSCRIPT_KINDS.some((kind) => kind === value)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
