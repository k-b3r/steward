import { StringDecoder } from 'node:string_decoder'

import type { TranscriptKind } from './transcript'

/** `writeAgent` kinds: everything in `TranscriptKind` except the orchestrator's own line. */
type AgentKind = Exclude<TranscriptKind, 'orchestrator'>

type PiRecord = Record<string, unknown>

/** One JSONL record, mapped to a transcript envelope or set aside. */
export type PiMapped =
  { type: 'skip' } | { type: 'event'; kind: AgentKind; event: PiRecord } | { type: 'invalid'; reason: string }

export interface PiLineSplitter {
  /** Complete lines from the chunk so far. A partial record stays inside for the next chunk. */
  push(chunk: string | Buffer): string[]
  /** The last line of a stream that ended without LF, or null when nothing is left. */
  flush(): string | null
}

const LF = '\n'
const CR = '\r'

/**
 * Splits `pi --mode json` output into records. LF is the only boundary: U+2028 and U+2029 are
 * legal inside JSON strings, and Node's `readline` treats them as line ends, so it cannot be used.
 * Feed one kind of chunk: a string is taken as is, a Buffer goes through a UTF-8 decoder that
 * holds a multi-byte character cut by the chunk boundary until the rest arrives.
 */
export function createPiLineSplitter(): PiLineSplitter {
  const decoder = new StringDecoder('utf8')
  let tail = ''

  return {
    push(chunk) {
      tail += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      const parts = tail.split(LF)
      tail = parts.pop() ?? ''
      return parts.map(stripCarriageReturn)
    },

    flush() {
      const rest = stripCarriageReturn(tail)
      tail = ''
      return rest === '' ? null : rest
    },
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith(CR) ? line.slice(0, -1) : line
}

/**
 * Maps one JSONL record from Pi 1.5.0 to what the transcript should hold. Never throws: a line
 * that is not a JSON object comes back as `invalid`, and a record type this mapper does not know
 * (a newer Pi) is skipped, so a new field cannot break a run.
 *
 * The original record goes into `event` unchanged, because the transcript stores agent events as
 * they arrived and the raw line is kept next to it.
 */
export function mapPiLine(line: string): PiMapped {
  if (line.trim() === '') return { type: 'skip' }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { type: 'invalid', reason: `invalid JSON: ${detail}` }
  }

  if (!isRecord(parsed)) return { type: 'invalid', reason: 'record is not a JSON object' }
  if (typeof parsed.type !== 'string') return { type: 'invalid', reason: 'record has no type' }

  const kind = kindForRecord(parsed, parsed.type)
  return kind === null ? { type: 'skip' } : { type: 'event', kind, event: parsed }
}

function kindForRecord(record: PiRecord, type: string): AgentKind | null {
  switch (type) {
    // The session header: id, version, timestamp, cwd. It plays the part of a Claude Code `system` line.
    case 'session':
      return 'system'
    case 'message_end':
      return kindForMessageEnd(record.message)
    // Pi's own abort flag decides. Both endings settle the run, so these are the terminal envelopes.
    case 'agent_settled':
      return record.aborted === true ? 'error' : 'result'
    default:
      // Progress and detail the transcript does not carry: agent_start/agent_end, turn_start/turn_end,
      // message_start/message_update, tool_execution_*, queue, compaction and retry records.
      return null
  }
}

function kindForMessageEnd(message: unknown): AgentKind | null {
  if (!isRecord(message)) return null
  // One record carries one tool result, so emitting here keeps each result to a single envelope.
  if (message.role === 'toolResult') return 'tool'
  // The user prompt is the orchestrator's line, not the agent's.
  if (message.role !== 'assistant') return null
  // A failed response gets its own envelope; the settle record that follows repeats the failure.
  return message.stopReason === 'error' ? 'error' : 'assistant'
}

function isRecord(value: unknown): value is PiRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The session id from the header record, or null for any other record. */
export function sessionIdFromHeader(record: unknown): string | null {
  if (!isRecord(record) || record.type !== 'session') return null
  return typeof record.id === 'string' && record.id !== '' ? record.id : null
}

/** The abort flag of `agent_settled`, which ends a run for good; null for any other record. */
export function isSettled(record: unknown): { aborted: boolean } | null {
  if (!isRecord(record) || record.type !== 'agent_settled' || typeof record.aborted !== 'boolean') return null
  return { aborted: record.aborted }
}

/** True for `turn_end`, so a runner can stop the process once the turn cap is reached. */
export function countTurn(record: unknown): boolean {
  return isRecord(record) && record.type === 'turn_end'
}
