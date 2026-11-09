import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { countTurn, createPiLineSplitter, isSettled, mapPiLine, sessionIdFromHeader } from './pi-events'
import type { PiLineSplitter, PiMapped } from './pi-events'

const FIXTURES = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'pi')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** The fixture's records as the splitter sees them, without blank lines. */
function records(name: string): string[] {
  const splitter = createPiLineSplitter()
  const lines = splitter.push(fixture(name))
  const tail = splitter.flush()
  return (tail === null ? lines : [...lines, tail]).filter((line) => line.trim() !== '')
}

function kinds(name: string): string[] {
  return records(name).flatMap((line) => {
    const mapped = mapPiLine(line)
    return mapped.type === 'event' ? [mapped.kind] : []
  })
}

/** `mapPiLine` for a fixture line that must map to an event. */
function eventOf(line: string): Extract<PiMapped, { type: 'event' }> {
  const mapped = mapPiLine(line)
  if (mapped.type !== 'event') throw new Error(`expected an event, got ${JSON.stringify(mapped)}`)
  return mapped
}

describe('createPiLineSplitter', () => {
  it('returns one line per LF in a single chunk', () => {
    const splitter: PiLineSplitter = createPiLineSplitter()

    expect(splitter.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('holds a partial tail until the next chunk completes the record', () => {
    const splitter = createPiLineSplitter()

    expect(splitter.push('{"type":"agent_set')).toEqual([])
    expect(splitter.push('tled","aborted":false}\n')).toEqual(['{"type":"agent_settled","aborted":false}'])
  })

  it('strips one preceding CR from every line', () => {
    const splitter = createPiLineSplitter()

    expect(splitter.push('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('does not split on U+2028 or U+2029 inside a JSON string', () => {
    const splitter = createPiLineSplitter()
    const line = '{"text":"before\u2028after\u2029end"}'

    expect(splitter.push(`${line}\n`)).toEqual([line])
  })

  it('decodes a multi-byte character split across two chunks', () => {
    const splitter = createPiLineSplitter()
    const bytes = Buffer.from('{"text":"ünïcode"}\n', 'utf8')
    const cut = bytes.indexOf(Buffer.from('ü', 'utf8')) + 1

    expect(splitter.push(bytes.subarray(0, cut))).toEqual([])
    expect(splitter.push(bytes.subarray(cut))).toEqual(['{"text":"ünïcode"}'])
  })

  it('returns no lines for an empty chunk', () => {
    expect(createPiLineSplitter().push('')).toEqual([])
  })

  it('flush returns a final line that has no LF, then nothing', () => {
    const splitter = createPiLineSplitter()
    splitter.push('{"a":1}\n{"b":2}')

    expect(splitter.flush()).toBe('{"b":2}')
    expect(splitter.flush()).toBeNull()
  })

  it('flush returns null when every line already ended with LF', () => {
    const splitter = createPiLineSplitter()
    splitter.push('{"a":1}\n')

    expect(splitter.flush()).toBeNull()
  })
})

describe('mapPiLine', () => {
  it('maps the session header to a system event, keeping the record unmodified', () => {
    const [line] = records('basic-run.jsonl')
    if (line === undefined) throw new Error('fixture has no records')

    const { kind, event } = eventOf(line)

    expect(kind).toBe('system')
    expect(event).toStrictEqual(JSON.parse(line))
  })

  it('maps an assistant message_end to an assistant event', () => {
    const assistant = records('basic-run.jsonl').find(
      (line) => line.startsWith('{"type":"message_end"') && line.includes('"role":"assistant"'),
    )
    if (assistant === undefined) throw new Error('fixture has no assistant message_end')

    expect(eventOf(assistant).kind).toBe('assistant')
  })

  it('maps a tool-result message_end to exactly one tool event', () => {
    expect(kinds('tool-turn.jsonl')).toEqual(['system', 'assistant', 'tool', 'result'])
  })

  it('maps agent_settled without abort to a result', () => {
    expect(kinds('basic-run.jsonl')).toEqual(['system', 'assistant', 'result'])
  })

  it('maps agent_settled with abort to an error, and an error stop reason too', () => {
    expect(kinds('aborted.jsonl')).toEqual(['system', 'error', 'error'])
  })

  it('maps a whole run the same way with CRLF line endings', () => {
    expect(kinds('crlf.jsonl')).toEqual(['system', 'assistant', 'result'])
  })

  it('keeps a U+2028 separator inside the assistant text', () => {
    const mapped = kinds('unicode-separators.jsonl')
    const assistant = records('unicode-separators.jsonl').find((line) => line.includes('before'))

    expect(mapped).toEqual(['assistant', 'result'])
    expect(assistant).toBeDefined()
    expect(JSON.stringify(assistant && eventOf(assistant).event)).toContain('\u2028after')
  })

  it('skips progress and lifecycle records that are not transcript events', () => {
    for (const line of records('noise.jsonl')) {
      expect(mapPiLine(line)).toEqual({ type: 'skip' })
    }
  })

  it('skips blank lines', () => {
    expect(mapPiLine('')).toEqual({ type: 'skip' })
    expect(mapPiLine('   ')).toEqual({ type: 'skip' })
  })

  it('reports invalid JSON without throwing', () => {
    const truncated = records('invalid.jsonl').find((line) => line.startsWith('{"type":"message_end"'))

    expect(truncated).toBeDefined()
    const mapped = truncated === undefined ? undefined : mapPiLine(truncated)

    expect(mapped?.type).toBe('invalid')
    expect(mapped && 'reason' in mapped ? mapped.reason : '').toMatch(/JSON/i)
  })

  it('reports JSON that is not an object as invalid', () => {
    expect(mapPiLine('[1,2]').type).toBe('invalid')
    expect(mapPiLine('null').type).toBe('invalid')
  })

  it('reports a record without a type as invalid', () => {
    expect(mapPiLine('{"aborted":false}').type).toBe('invalid')
  })
})

describe('pi record helpers', () => {
  it('sessionIdFromHeader reads the header id and nothing else', () => {
    const [header] = records('basic-run.jsonl')
    const assistant = records('basic-run.jsonl').find(
      (line) => line.startsWith('{"type":"message_end"') && line.includes('"role":"assistant"'),
    )

    expect(header && sessionIdFromHeader(JSON.parse(header))).toBe('0f6f3a1c-6b0e-4a5e-9f7e-2f8b6c1d4e21')
    expect(assistant && sessionIdFromHeader(JSON.parse(assistant))).toBeNull()
    expect(sessionIdFromHeader({ type: 'session', version: 3 })).toBeNull()
  })

  it('isSettled reports the abort flag of agent_settled only', () => {
    expect(isSettled({ type: 'agent_settled', aborted: false })).toEqual({ aborted: false })
    expect(isSettled({ type: 'agent_settled', aborted: true })).toEqual({ aborted: true })
    expect(isSettled({ type: 'agent_end', messages: [], willRetry: false })).toBeNull()
    expect(isSettled({ type: 'agent_settled' })).toBeNull()
  })

  it('countTurn counts turn_end records only', () => {
    expect(countTurn({ type: 'turn_end', message: {}, toolResults: [] })).toBe(true)
    expect(countTurn({ type: 'turn_start' })).toBe(false)
    expect(countTurn({ type: 'agent_settled', aborted: false })).toBe(false)
  })
})

describe('a real run (recorded 2026-11-08, Pi 1.5.0, opencode-go/deepseek-v4.1-flash)', () => {
  // One tool call (create a file) and a final answer, from `pi -p --mode json` in the Pi container.
  it('maps to system, assistant, tool, assistant, result in order', () => {
    expect(kinds('real-run.jsonl')).toEqual(['system', 'assistant', 'tool', 'assistant', 'result'])
  })

  it('has the session header first, with an id, and agent_settled last with aborted false', () => {
    const lines = records('real-run.jsonl')
    expect(sessionIdFromHeader(JSON.parse(lines[0] ?? '{}'))).toMatch(/^[0-9a-f-]{36}$/)
    expect(isSettled(JSON.parse(lines[lines.length - 1] ?? '{}'))).toEqual({ aborted: false })
  })

  it('emits one tool envelope for the one tool result, and counts two turns', () => {
    const lines = records('real-run.jsonl')
    expect(kinds('real-run.jsonl').filter((kind) => kind === 'tool')).toHaveLength(1)
    expect(lines.filter((line) => countTurn(JSON.parse(line))).length).toBe(2)
  })
})
