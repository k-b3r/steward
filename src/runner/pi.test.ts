import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { Job } from '../types'
import { readTranscript } from './transcript'
import { buildPrompt, createPiRunner, PiRunError } from './pi'
import type { PiChild, PiRunnerConfig } from './pi'

const FIXTURES = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'pi')
const SECRET = 'FAKE_MODEL_KEY_value_123'
const SESSION = '01a1bc14-37f0-71a2-b613-3a8867b37ba7'

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    source: 'linear',
    externalId: 'ext-1',
    identifier: 'TST-1',
    title: 'A job for the ticket',
    body: 'Do the thing',
    url: 'https://example.test/TST-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    state: 'running',
    attempt: 1,
    maxAttempts: 3,
    slot: 0,
    nextRunAt: null,
    failureKind: null,
    branch: null,
    ...overrides,
  }
}

type Exit = { code: number | null; signal: string | null }
type Script = { stdout?: string | string[]; stderr?: string; exit?: Exit | 'hang' }
type FakeChild = PiChild & { killCount: number }

function streamOf(text: string | string[]): AsyncIterable<string> {
  const parts = Array.isArray(text) ? text : [text]
  return (async function* (): AsyncIterable<string> {
    for (const part of parts) if (part !== '') yield part
  })()
}

function makeChild(script: Script): FakeChild {
  let finish: (value: Exit) => void = () => {}
  let done = false
  const exit = new Promise<Exit>((resolve) => {
    finish = (value): void => {
      if (done) return
      done = true
      resolve(value)
    }
  })
  if (script.exit !== 'hang') finish(script.exit ?? { code: 0, signal: null })

  const child: FakeChild = {
    stdout: streamOf(script.stdout ?? ''),
    stderr: streamOf(script.stderr ?? ''),
    exit,
    killCount: 0,
    kill() {
      child.killCount += 1
      finish({ code: null, signal: 'SIGTERM' })
    },
  }
  return child
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const BASE_CONFIG = {
  instance: 'personal',
  image: 'steward-pi:1.5.0',
  model: 'anthropic/claude-sonnet-5-5',
  limits: { cpus: 2, memoryMb: 4096, pidsLimit: 512 },
  env: { ANTHROPIC_API_KEY: SECRET },
  secrets: [SECRET],
}

function harness(scripts: Script[], config: Partial<PiRunnerConfig> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'steward-pi-'))
  dirs.push(runsDir)
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = []
  const podman: string[][] = []
  const children: FakeChild[] = []
  const sleeps: Array<{ ms: number; wake: () => void; cancelled: boolean }> = []
  const spawnFailure: { error: Error | null } = { error: null }

  const runner = createPiRunner({
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, env: opts.env })
      if (spawnFailure.error !== null) throw spawnFailure.error
      const child = makeChild(scripts[children.length] ?? {})
      children.push(child)
      return child
    },
    execPodman: async (args) => {
      podman.push(args)
      return { code: 0 }
    },
    clock: () => new Date('2026-01-02T03:04:05.000Z'),
    sleep: (ms) => {
      let resolve: () => void = () => {}
      const promise = new Promise<void>((done) => (resolve = done))
      const timer = {
        ms,
        promise,
        wake: (): void => resolve(),
        cancelled: false,
        cancel: (): void => void (timer.cancelled = true),
      }
      sleeps.push(timer)
      return timer
    },
    config: { ...BASE_CONFIG, runsDir, worktreePathFor: (jobId) => join(runsDir, 'worktrees', jobId), ...config },
  })

  return { runner, runsDir, calls, podman, children, sleeps, spawnFailure }
}

const dirOf = (h: ReturnType<typeof harness>, jobId: string, run = 1): string => h.runner.transcriptDir(jobId, run)

describe('buildPrompt', () => {
  it('names the ticket and its body, then the rules, and cuts the body at 4000 characters', () => {
    const prompt = buildPrompt(makeJob({ body: `${'x'.repeat(4000)}TAIL` }))

    expect(prompt).toContain('Ticket TST-1: A job for the ticket')
    expect(prompt).toContain('x'.repeat(4000))
    expect(prompt).not.toContain('TAIL')
    for (const rule of ['Work only inside /workspace', 'Do not run `git push`', '`.env*`', '.github/']) {
      expect(prompt).toContain(rule)
    }
  })
})

describe('pi runner', () => {
  it('replays a real run: session id, transcript kinds in order, success', async () => {
    const h = harness([{ stdout: fixture('real-run.jsonl') }])
    const job = makeJob()

    const { sessionId } = await h.runner.start(job, 1)

    expect(sessionId).toBe(SESSION)
    const envelopes = readTranscript(dirOf(h, job.id), 0)
    expect(envelopes.map((envelope) => envelope.kind)).toEqual([
      'orchestrator',
      'system',
      'assistant',
      'tool',
      'assistant',
      'result',
    ])

    const args = h.calls[0]?.args ?? []
    expect(args).toContain(`steward-personal-job-${job.id}-1`)
    expect(args).toContain(`${join(h.runsDir, 'worktrees', job.id)}:/workspace:rw`)
    expect(args).toContain(`${join(dirOf(h, job.id), 'session')}:/session:rw`)
    expect(args.at(-1)).toBe(buildPrompt(job))
    expect(statSync(join(dirOf(h, job.id), 'session')).mode & 0o777).toBe(0o700)
    expect(h.sleeps[0]?.cancelled).toBe(true)
  })

  it('fails with infra when podman exits non-zero, keeping the stderr tail as an error envelope', async () => {
    const h = harness([{ stdout: fixture('basic-run.jsonl'), stderr: 'podman: boom', exit: { code: 2, signal: null } }])

    await expect(h.runner.start(makeJob(), 1)).rejects.toMatchObject({ kind: 'infra' })

    const envelopes = readTranscript(dirOf(h, makeJob().id), 0)
    expect(envelopes.at(-1)?.data).toMatchObject({ msg: 'failed', kind: 'infra' })
    expect(JSON.stringify(envelopes)).toContain('podman: boom')
  })

  it('fails with infra when a clean exit never settles', async () => {
    const h = harness([{ stdout: fixture('noise.jsonl') }])

    await expect(h.runner.start(makeJob(), 1)).rejects.toMatchObject({ kind: 'infra', message: /agent_settled/ })
  })

  it('fails with infra on a provider hiccup, with agent when the error is not one', async () => {
    const provider = harness([{ stdout: fixture('provider-error.jsonl'), exit: { code: 1, signal: null } }])
    const model = harness([{ stdout: fixture('model-error.jsonl'), exit: { code: 1, signal: null } }])

    await expect(provider.runner.start(makeJob(), 1)).rejects.toMatchObject({ kind: 'infra', message: /429/ })
    await expect(model.runner.start(makeJob(), 1)).rejects.toMatchObject({ kind: 'agent', message: /context window/ })
  })

  it('fails with agent when the stream aborted, even after a provider error', async () => {
    const h = harness([{ stdout: fixture('aborted.jsonl') }])

    await expect(h.runner.start(makeJob(), 1)).rejects.toMatchObject({ kind: 'agent', message: /aborted/i })
  })

  it('kills the container when the turn cap is passed, and fails with agent', async () => {
    const h = harness([{ stdout: fixture('basic-run.jsonl').repeat(2), exit: 'hang' }], { turnCap: 1 })

    await expect(h.runner.start(makeJob(), 1)).rejects.toMatchObject({ kind: 'agent', message: /turn cap/i })

    expect(h.children[0]?.killCount).toBe(1)
    expect(h.podman).toEqual([['kill', `steward-personal-job-${makeJob().id}-1`]])
    const data = readTranscript(dirOf(h, makeJob().id), 0).map((envelope) => envelope.data)
    expect(data).toContainEqual({ msg: 'turn cap', turns: 2, cap: 1 })
  })

  it('kills the container after the run timeout and fails with infra', async () => {
    const h = harness([{ exit: 'hang' }], { runTimeoutMs: 5000 })
    const pending = h.runner.start(makeJob(), 1)

    expect(h.sleeps[0]?.ms).toBe(5000)
    h.sleeps[0]?.wake()

    await expect(pending).rejects.toMatchObject({ kind: 'infra', message: /timed out/i })
    expect(h.children[0]?.killCount).toBe(1)
  })

  it('cancels the child and the container, and writes a cancelled line', async () => {
    const h = harness([{ exit: 'hang' }])
    const job = makeJob()
    const pending = h.runner.start(job, 1)

    await h.runner.cancel(job.id)

    expect(h.children[0]?.killCount).toBe(1)
    expect(h.podman).toEqual([['kill', `steward-personal-job-${job.id}-1`]])
    const data = readTranscript(dirOf(h, job.id), 0).map((envelope) => envelope.data)
    expect(data).toContainEqual({ msg: 'cancelled', jobId: job.id })
    await expect(pending).rejects.toMatchObject({ kind: 'agent', message: /cancelled/i })

    await h.runner.cancel('never-ran')
    expect(existsSync(join(h.runsDir, 'never-ran'))).toBe(false)
  })

  it('resumes on the same transcript, with --session and the feedback as the prompt', async () => {
    const resumed = [
      JSON.stringify({ type: 'session', version: 3, id: SESSION }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } }),
      JSON.stringify({ type: 'agent_settled', aborted: false }),
      '',
    ].join('\n')
    const h = harness([{ stdout: fixture('real-run.jsonl') }, { stdout: resumed }])
    const job = makeJob()
    const { sessionId } = await h.runner.start(job, 1)

    await h.runner.resume(sessionId, 'please add a test')

    const args = h.calls[1]?.args ?? []
    expect(args).toContain('--session')
    expect(args).toContain(sessionId)
    expect(args.at(-1)).toBe('please add a test')
    const envelopes = readTranscript(dirOf(h, job.id), 0)
    expect(envelopes.map((envelope) => envelope.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(envelopes[6]?.data).toMatchObject({ msg: 'resumed' })
    await expect(h.runner.resume('missing', 'feedback')).rejects.toMatchObject({ kind: 'agent' })
  })

  it('fails with infra when podman cannot be spawned', async () => {
    const h = harness([{}])
    h.spawnFailure.error = new Error('spawn podman ENOENT')

    await expect(h.runner.start(makeJob(), 1)).rejects.toMatchObject({ kind: 'infra', message: /ENOENT/ })
  })

  it('passes only model key names, and the value never reaches args, the transcript or the error', async () => {
    const h = harness([{ stderr: `auth failed for ${SECRET}`, exit: { code: 1, signal: null } }], {
      env: { OPENCODE_API_KEY: SECRET, HOME: '/x' },
    })

    const error = await h.runner.start(makeJob(), 1).catch((caught: unknown) => caught)

    expect(h.calls[0]?.env).toEqual({ OPENCODE_API_KEY: SECRET })
    expect(JSON.stringify(h.calls[0]?.args)).not.toContain(SECRET)
    expect(error).toBeInstanceOf(PiRunError)
    expect((error as Error).message).not.toContain(SECRET)
    const transcript = readFileSync(join(dirOf(h, makeJob().id), 'transcript.jsonl'), 'utf8')
    expect(transcript).not.toContain(SECRET)
    expect(transcript).toContain('[REDACTED]')
  })
})
