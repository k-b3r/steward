import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentRunner, Job } from '../types'
import { MODEL_KEY_ENV_NAMES, buildPiRunArgs } from './pi-command'
import { countTurn, createPiLineSplitter, isSettled, mapPiLine, sessionIdFromHeader } from './pi-events'
import { createTranscriptWriter } from './transcript'
import type { TranscriptWriter } from './transcript'

type PiExit = { code: number | null; signal: string | null }

export type PiChild = {
  stdout: AsyncIterable<Buffer | string>
  stderr: AsyncIterable<Buffer | string>
  exit: Promise<PiExit>
  kill(): void
}

export type PiRunnerConfig = {
  instance: string
  image: string
  /** Pi model pattern. Omitted means Pi's own default. */
  model?: string
  runsDir: string
  worktreePathFor(jobId: string): string
  limits: { cpus: number; memoryMb: number; pidsLimit: number }
  turnCap?: number
  /** Wall-clock limit for the container. Default 20 minutes. */
  runTimeoutMs?: number
  env: Record<string, string>
  secrets: string[]
}

type RunSpec = {
  jobId: string
  jobIdentifier: string
  runNumber: number
  prompt: string
  resumeSessionId?: string
  verb: 'started' | 'resumed'
}

export type PiRunnerDeps = {
  spawn(cmd: string, args: string[], opts: { env: Record<string, string> }): PiChild
  execPodman(args: string[]): Promise<{ code: number }>
  clock: () => Date
  sleep(ms: number): { promise: Promise<void>; cancel(): void }
  config: PiRunnerConfig
}

export class PiRunError extends Error {
  readonly kind: 'infra' | 'agent'

  constructor(kind: 'infra' | 'agent', message: string) {
    super(message)
    this.name = 'PiRunError'
    this.kind = kind
  }
}

const DEFAULT_TURN_CAP = 40
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60 * 1000
const STDERR_TAIL_CHARS = 4096
const BODY_LIMIT = 4000

// A provider hiccup is worth a fresh container: overloaded, rate limited, 429, an HTTP 5xx, a
// timeout or a dropped connection. Pi retried it first (retry.* settings), so this is the second try.
const PROVIDER_HICCUP =
  /overloaded|rate[ _-]?limit|too many requests|\b429\b|bad gateway|service unavailable|gateway timeout|internal server error|\b(?:http|status|code|error)[^\d\n]{0,4}5\d\d\b|\btimeout\b|econn/i

/** The first prompt of a run: ticket text, then the fixed rules. Pure. */
export function buildPrompt(job: Job): string {
  return [
    `Ticket ${job.identifier}: ${job.title}`,
    '',
    (job.body ?? '').slice(0, BODY_LIMIT),
    '',
    'Rules:',
    '- Work only inside /workspace.',
    '- Make the smallest change that satisfies the ticket.',
    '- Do not run `git push`.',
    '- Do not touch `.env*` files or `.github/`.',
    '- You may commit locally.',
    '- Finish with a one-paragraph summary.',
  ].join('\n')
}

export function createPiRunner(deps: PiRunnerDeps): AgentRunner & {
  transcriptDir(jobId: string, runNumber?: number): string
} {
  const { config, clock } = deps
  const turnCap = config.turnCap ?? DEFAULT_TURN_CAP
  const runTimeoutMs = config.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const secrets = config.secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length)

  type Active = {
    child: PiChild
    containerName: string
    runNumber: number
    writer: TranscriptWriter
    cancelled: boolean
  }
  const active = new Map<string, Active>()
  const sessions = new Map<string, { jobId: string; runNumber: number; jobIdentifier: string }>()

  const redact = (text: string): string => {
    let result = text
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]')
    return result
  }

  const transcriptDir = (jobId: string, runNumber?: number): string =>
    runNumber === undefined ? join(config.runsDir, jobId) : join(config.runsDir, jobId, String(runNumber))

  const fail = (writer: TranscriptWriter, kind: 'infra' | 'agent', reason: string): PiRunError => {
    const message = redact(reason)
    writer.writeOrchestrator('failed', { kind, reason: message })
    return new PiRunError(kind, message)
  }

  /** Last stderr as a synthetic error envelope; `writeAgent` stores agent data unmodified, so redact here. */
  const writeStderr = (writer: TranscriptWriter, tail: string): void => {
    if (tail.trim() === '') return
    const text = redact(tail)
    writer.writeAgent('error', { type: 'stderr', text }, JSON.stringify({ type: 'stderr', text }))
  }

  const stop = async (entry: Active): Promise<void> => {
    entry.child.kill()
    await deps.execPodman(['kill', entry.containerName]).catch(() => ({ code: 1 }))
  }

  async function watch(entry: Active, spec: RunSpec, writer: TranscriptWriter): Promise<{ sessionId: string }> {
    const splitter = createPiLineSplitter()
    let sessionId: string | null = null
    let settled: { aborted: boolean } | null = null
    let errorText: string | null = null
    let turns = 0
    let stderrTail = ''
    let hitCap: () => void = () => {}
    const capHit = new Promise<void>((resolve) => {
      hitCap = resolve
    })

    const onRecord = (record: unknown): void => {
      const header = sessionIdFromHeader(record)
      if (header !== null) {
        sessionId = header
        sessions.set(header, { jobId: spec.jobId, runNumber: spec.runNumber, jobIdentifier: spec.jobIdentifier })
      }
      const settle = isSettled(record)
      if (settle !== null) settled = settle
      if (countTurn(record)) {
        turns += 1
        if (turns > turnCap) hitCap()
      }
      const text = assistantErrorText(record)
      if (text !== null) errorText = text
    }

    const handleLine = (line: string): boolean => {
      const mapped = mapPiLine(line)
      if (mapped.type === 'event') {
        writer.writeAgent(mapped.kind, mapped.event, line)
        onRecord(mapped.event)
      } else if (mapped.type === 'invalid') {
        writer.writeOrchestrator('invalid agent line', { reason: mapped.reason })
      } else {
        const record = tryParse(line)
        if (record !== null) onRecord(record)
      }
      return turns > turnCap
    }

    const consumeStdout = async (): Promise<void> => {
      for await (const chunk of entry.child.stdout) {
        for (const line of splitter.push(chunk)) {
          if (handleLine(line)) return
        }
      }
      const last = splitter.flush()
      if (last !== null) handleLine(last)
    }

    const consumeStderr = async (): Promise<void> => {
      for await (const chunk of entry.child.stderr) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS)
      }
    }

    const giveUp = (kind: 'infra' | 'agent', reason: string): never => {
      writeStderr(writer, stderrTail)
      throw fail(writer, kind, reason)
    }

    const stdoutDone = consumeStdout()
    const stderrDone = consumeStderr()
    const timeout = deps.sleep(runTimeoutMs)
    const first = await Promise.race([
      entry.child.exit.then((exit) => ({ kind: 'exit' as const, exit })),
      timeout.promise.then(() => ({ kind: 'timeout' as const })),
      capHit.then(() => ({ kind: 'cap' as const })),
    ])
    timeout.cancel()
    if (first.kind !== 'exit') await stop(entry)
    await Promise.all([stdoutDone, stderrDone])

    if (first.kind === 'timeout') giveUp('infra', `run timed out after ${String(runTimeoutMs)} ms`)
    if (first.kind === 'cap' || turns > turnCap) {
      writer.writeOrchestrator('turn cap', { turns, cap: turnCap })
      giveUp('agent', `turn cap reached: ${String(turns)} turns (cap ${String(turnCap)})`)
    }

    const exit = first.kind === 'exit' ? first.exit : { code: null, signal: null }
    const verdict = verdictFor({ cancelled: entry.cancelled, settled, exit, errorText })
    if (verdict !== null) giveUp(verdict.kind, verdict.reason)
    if (sessionId === null) {
      writeStderr(writer, stderrTail)
      throw fail(writer, 'infra', 'stream carried no session id')
    }

    return { sessionId }
  }

  async function execute(spec: RunSpec): Promise<{ sessionId: string }> {
    const dir = transcriptDir(spec.jobId, spec.runNumber)
    const sessionDir = join(dir, 'session')
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 })

    const writer = createTranscriptWriter({ dir, clock, secrets })
    writer.writeOrchestrator(spec.verb, { jobId: spec.jobId })

    const passEnv = MODEL_KEY_ENV_NAMES.filter((name) => config.env[name] !== undefined)
    const env = Object.fromEntries(passEnv.map((name) => [name, config.env[name] ?? '']))

    const args = buildPiRunArgs({
      instance: config.instance,
      jobId: spec.jobId,
      runNumber: spec.runNumber,
      image: config.image,
      worktreePath: config.worktreePathFor(spec.jobId),
      sessionDir,
      prompt: spec.prompt,
      resumeSessionId: spec.resumeSessionId,
      passEnv,
      limits: config.limits,
      model: config.model,
    })
    const containerName = containerNameOf(args)

    let child: PiChild
    try {
      child = deps.spawn('podman', args, { env })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw fail(writer, 'infra', `podman failed to start: ${detail}`)
    }

    const entry: Active = { child, containerName, runNumber: spec.runNumber, writer, cancelled: false }
    active.set(spec.jobId, entry)
    try {
      return await watch(entry, spec, writer)
    } finally {
      active.delete(spec.jobId)
    }
  }

  return {
    transcriptDir,

    async start(job: Job, runNumber: number): Promise<{ sessionId: string }> {
      return await execute({
        jobId: job.id,
        jobIdentifier: job.identifier,
        runNumber,
        prompt: buildPrompt(job),
        verb: 'started',
      })
    },

    async resume(sessionId: string, feedback: string): Promise<void> {
      const known = sessions.get(sessionId)
      if (known === undefined) {
        throw new PiRunError('agent', `unknown Pi session ${JSON.stringify(sessionId)}`)
      }
      await execute({ ...known, prompt: feedback, resumeSessionId: sessionId, verb: 'resumed' })
    },

    async cancel(jobId: string): Promise<void> {
      // Nothing active means nothing to kill: a finished run already wrote its own outcome.
      const entry = active.get(jobId)
      if (entry === undefined) return

      entry.cancelled = true
      // Before the kill, so the cancelled line always precedes the run's own failed line.
      entry.writer.writeOrchestrator('cancelled', { jobId })
      await stop(entry)
    },
  }
}

/** `infra` retries with backoff, `agent` does not. An aborted settle wins over the stream text. */
function verdictFor(done: {
  cancelled: boolean
  settled: { aborted: boolean } | null
  exit: PiExit
  errorText: string | null
}): { kind: 'infra' | 'agent'; reason: string } | null {
  const exitText = done.exit.signal === null ? `code ${String(done.exit.code)}` : `signal ${done.exit.signal}`
  if (done.cancelled) return { kind: 'agent', reason: 'cancelled' }
  if (done.settled?.aborted === true) return { kind: 'agent', reason: 'agent aborted the run' }
  if (done.exit.code !== 0) {
    // A model error that is not a provider hiccup will not pass on a retry: route it to the agent.
    const kind = done.errorText !== null && !PROVIDER_HICCUP.test(done.errorText) ? 'agent' : 'infra'
    const detail = done.errorText === null ? '' : `: ${done.errorText}`
    return { kind, reason: `podman exited with ${exitText}${detail}` }
  }
  if (done.settled === null) return { kind: 'infra', reason: `stream ended without agent_settled (exit ${exitText})` }
  if (done.errorText !== null) {
    const provider = PROVIDER_HICCUP.test(done.errorText)
    const label = provider ? 'provider' : 'agent'
    return { kind: provider ? 'infra' : 'agent', reason: `${label} error: ${done.errorText}` }
  }
  return null
}

function containerNameOf(args: readonly string[]): string {
  const index = args.indexOf('--name')
  const name = index === -1 ? undefined : args[index + 1]
  if (name === undefined) throw new PiRunError('infra', 'podman args carry no container name')
  return name
}

function assistantErrorText(record: unknown): string | null {
  if (!isRecord(record) || record.type !== 'message_end') return null
  const message = record.message
  if (!isRecord(message) || message.role !== 'assistant' || message.stopReason !== 'error') return null
  return typeof message.errorMessage === 'string' ? message.errorMessage : ''
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
