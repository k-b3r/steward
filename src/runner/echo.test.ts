import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Job } from '../types'
import { readTranscript } from './transcript'
import { createEchoRunner } from './echo'

const FIXED_TS = '2026-01-02T03:04:05.000Z'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    source: 'linear',
    sourceId: 'ext-1',
    ticketKey: 'TST-1',
    state: 'running',
    attempt: 1,
    maxAttempts: 3,
    slot: 0,
    nextRunAt: null,
    failureKind: null,
    ...overrides,
  }
}

describe('echo runner', () => {
  let runsDir: string

  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'steward-echo-'))
  })

  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true })
  })

  const clock = (): Date => new Date(FIXED_TS)

  it('writes an orchestrator line and fake system, assistant and result events on start', async () => {
    const runner = createEchoRunner({ runsDir, clock })
    const job = makeJob()

    const { sessionId } = await runner.start(job)

    expect(sessionId).toBe(`echo-${job.id}`)
    expect(runner.transcriptDir(job.id)).toBe(join(runsDir, job.id))
    const envelopes = readTranscript(runner.transcriptDir(job.id), 0)
    expect(envelopes.map((envelope) => envelope.kind)).toEqual(['orchestrator', 'system', 'assistant', 'result'])
    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4])
    expect(envelopes.map((envelope) => envelope.ts)).toEqual([FIXED_TS, FIXED_TS, FIXED_TS, FIXED_TS])
    expect(envelopes[0]?.data).toMatchObject({ msg: 'started', jobId: job.id, sessionId })
    expect(envelopes[1]?.data).toMatchObject({ type: 'system', sessionId })
    expect(envelopes[2]?.data).toMatchObject({ type: 'assistant' })
    expect(envelopes[3]?.data).toMatchObject({ type: 'result', sessionId })
  })

  it('writes each agent raw line as the JSON of its event', async () => {
    const runner = createEchoRunner({ runsDir, clock })
    const job = makeJob()

    await runner.start(job)

    const envelopes = readTranscript(runner.transcriptDir(job.id), 0).filter(
      (envelope) => envelope.kind !== 'orchestrator',
    )
    const rawLines = readFileSync(join(runner.transcriptDir(job.id), 'raw.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown)
    expect(rawLines).toEqual(envelopes.map((envelope) => envelope.data))
  })

  it('appends an assistant line with the feedback on resume', async () => {
    const runner = createEchoRunner({ runsDir, clock })
    const job = makeJob()
    const { sessionId } = await runner.start(job)

    await runner.resume(sessionId, 'please add a test')

    const envelopes = readTranscript(runner.transcriptDir(job.id), 0)
    expect(envelopes).toHaveLength(5)
    expect(envelopes[4]).toMatchObject({ seq: 5, kind: 'assistant' })
    expect(JSON.stringify(envelopes[4]?.data)).toContain('please add a test')
  })

  it('writes an orchestrator cancelled line on cancel', async () => {
    const runner = createEchoRunner({ runsDir, clock })
    const job = makeJob()

    await runner.cancel(job.id)

    const envelopes = readTranscript(runner.transcriptDir(job.id), 0)
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0]).toMatchObject({
      seq: 1,
      kind: 'orchestrator',
      data: { msg: 'cancelled', jobId: job.id },
    })
  })

  it('keeps jobs in separate transcript directories', async () => {
    const runner = createEchoRunner({ runsDir, clock })
    const first = makeJob({ id: '11111111-1111-1111-1111-111111111111', ticketKey: 'TST-1' })
    const second = makeJob({ id: '22222222-2222-2222-2222-222222222222', ticketKey: 'TST-2' })

    await runner.start(first)
    await runner.start(second)

    expect(readTranscript(runner.transcriptDir(first.id), 0).map((envelope) => envelope.kind)).not.toEqual([])
    expect(readTranscript(runner.transcriptDir(second.id), 0).map((envelope) => envelope.kind)).not.toEqual([])
    expect(runner.transcriptDir(first.id)).not.toBe(runner.transcriptDir(second.id))
  })

  it('resumes a session id from another runner instance', async () => {
    const first = createEchoRunner({ runsDir, clock })
    const job = makeJob()
    const { sessionId } = await first.start(job)

    const second = createEchoRunner({ runsDir, clock })
    await second.resume(sessionId, 'feedback after restart')

    const envelopes = readTranscript(second.transcriptDir(job.id), 0)
    expect(envelopes).toHaveLength(5)
    expect(JSON.stringify(envelopes[4]?.data)).toContain('feedback after restart')
  })

  it('rejects resuming a session that is not an echo session', async () => {
    const runner = createEchoRunner({ runsDir, clock })

    await expect(runner.resume('missing-session', 'feedback')).rejects.toThrow(/unknown echo session/i)
  })
})
