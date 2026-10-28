import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TRANSCRIPT_KINDS, createTranscriptWriter, readTranscript, type Envelope } from './transcript'

const FIXED_TS = '2026-01-02T03:04:05.000Z'

describe('transcript', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steward-transcript-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const fixedClock = (): Date => new Date(FIXED_TS)

  it('exports the transcript kinds', () => {
    expect(TRANSCRIPT_KINDS).toEqual(['system', 'assistant', 'tool', 'result', 'error', 'orchestrator'])
  })

  it('writes an envelope with the shape and timestamp from the injected clock', () => {
    const writer = createTranscriptWriter({ dir, clock: fixedClock })

    const envelope = writer.writeOrchestrator('starting', { attempt: 1 })

    expect(envelope).toEqual({
      seq: 1,
      ts: FIXED_TS,
      kind: 'orchestrator',
      data: { msg: 'starting', attempt: 1 },
    })
    expect(readTranscript(dir, 0)).toEqual([envelope])
  })

  it('increments seq across both write methods', () => {
    const writer = createTranscriptWriter({ dir, clock: fixedClock })

    const first = writer.writeOrchestrator('one')
    const second = writer.writeAgent('assistant', { text: 'two' }, '{"text":"two"}')
    const third = writer.writeOrchestrator('three')

    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
    expect(readTranscript(dir, 0).map((envelope) => envelope.seq)).toEqual([1, 2, 3])
  })

  it('resumes seq from an existing transcript', () => {
    const firstWriter = createTranscriptWriter({ dir, clock: fixedClock })
    firstWriter.writeOrchestrator('one')
    firstWriter.writeAgent('tool', { name: 'ls' }, '{"name":"ls"}')

    const secondWriter = createTranscriptWriter({ dir, clock: fixedClock })
    const resumed = secondWriter.writeOrchestrator('three')

    expect(resumed.seq).toBe(3)
    expect(readTranscript(dir, 0).map((envelope) => envelope.seq)).toEqual([1, 2, 3])
  })

  it('creates the run directory recursively', () => {
    const nestedDir = join(dir, 'nested', 'run')
    const writer = createTranscriptWriter({ dir: nestedDir, clock: fixedClock })

    writer.writeOrchestrator('hello')

    expect(readTranscript(nestedDir, 0)).toHaveLength(1)
  })

  it('redacts secrets in nested strings and authorization keys, whatever their case', () => {
    const writer = createTranscriptWriter({
      dir,
      clock: fixedClock,
      secrets: ['super-secret'],
    })

    const envelope = writer.writeOrchestrator('starting', {
      prompt: 'token is super-secret',
      nested: {
        list: ['x super-secret y', { deep: 'super-secret' }],
      },
      headers: {
        Authorization: 'Bearer super-secret',
        authorization: 'plain',
        AUTHORIZATION: 'also-plain',
      },
    })

    expect(envelope.data).toEqual({
      msg: 'starting',
      prompt: 'token is [REDACTED]',
      nested: {
        list: ['x [REDACTED] y', { deep: '[REDACTED]' }],
      },
      headers: {
        Authorization: '[REDACTED]',
        authorization: '[REDACTED]',
        AUTHORIZATION: '[REDACTED]',
      },
    })
    expect(readTranscript(dir, 0)[0]?.data).toEqual(envelope.data)
  })

  it('does not redact agent events', () => {
    const writer = createTranscriptWriter({
      dir,
      clock: fixedClock,
      secrets: ['super-secret'],
    })
    const event = { text: 'super-secret', nested: { token: 'super-secret' } }

    const envelope = writer.writeAgent('assistant', event, '{"text":"super-secret"}')

    expect(envelope.data).toEqual(event)
    expect(readTranscript(dir, 0)[0]?.data).toEqual(event)
  })

  it('appends raw output byte-exactly and creates raw.jsonl with mode 0o600', () => {
    const writer = createTranscriptWriter({ dir, clock: fixedClock })
    const rawOne = '{"text":"héllo\\tworld","line":1}'
    const rawTwo = ' {"text":"second"} '

    writer.writeAgent('assistant', { text: 'héllo\tworld' }, rawOne)
    writer.writeAgent('assistant', { text: 'second' }, rawTwo)

    const rawPath = join(dir, 'raw.jsonl')
    expect(readFileSync(rawPath)).toEqual(Buffer.from(`${rawOne}\n${rawTwo}\n`))
    expect(statSync(rawPath).mode & 0o777).toBe(0o600)
  })

  it('reads only envelopes after the given seq', () => {
    const writer = createTranscriptWriter({ dir, clock: fixedClock })
    writer.writeOrchestrator('one')
    writer.writeAgent('result', { ok: true }, '{"ok":true}')
    writer.writeOrchestrator('three')

    expect(readTranscript(dir, 1).map((envelope) => envelope.seq)).toEqual([2, 3])
    expect(readTranscript(dir, 3)).toEqual([])
  })

  it('returns an empty list when the transcript file is missing', () => {
    expect(readTranscript(join(dir, 'missing'), 0)).toEqual([])
  })

  it('keeps new entries readable after a crash left a partial last line', () => {
    const first = createTranscriptWriter({ dir, clock: fixedClock })
    first.writeOrchestrator('one')
    appendFileSync(join(dir, 'transcript.jsonl'), '{"seq":2,"ts":"x"')

    const second = createTranscriptWriter({ dir, clock: fixedClock })
    const envelope = second.writeOrchestrator('two')

    expect(envelope.seq).toBe(2)
    expect(readTranscript(dir, 0).map((e) => e.seq)).toEqual([1, 2])
  })

  it('creates transcript.jsonl with mode 0o600', () => {
    createTranscriptWriter({ dir, clock: fixedClock }).writeOrchestrator('one')

    expect(statSync(join(dir, 'transcript.jsonl')).mode & 0o777).toBe(0o600)
  })

  it('ignores a partial trailing line', () => {
    const writer = createTranscriptWriter({ dir, clock: fixedClock })
    writer.writeOrchestrator('one')
    writer.writeOrchestrator('two')
    appendFileSync(join(dir, 'transcript.jsonl'), '{"seq":3,"ts":"2026-')

    const envelopes: Envelope[] = readTranscript(dir, 0)

    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2])
  })

  it('ignores empty secret strings', () => {
    const writer = createTranscriptWriter({
      dir,
      clock: fixedClock,
      secrets: ['', 'super-secret'],
    })

    const envelope = writer.writeOrchestrator('nothing to hide, super-secret stays hidden')

    expect(envelope.data).toEqual({
      msg: 'nothing to hide, [REDACTED] stays hidden',
    })
  })
})
