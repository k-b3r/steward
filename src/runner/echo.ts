import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { AgentRunner, Job } from '../types'
import { createTranscriptWriter } from './transcript'

const SESSION_PREFIX = 'echo-'

type AgentEvent = { type: 'system' | 'assistant' | 'result'; [key: string]: unknown }

function systemEvent(sessionId: string): AgentEvent {
  return { type: 'system', subtype: 'init', sessionId, model: 'echo' }
}

function assistantEvent(text: string): AgentEvent {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

function resultEvent(sessionId: string): AgentEvent {
  return { type: 'result', subtype: 'success', sessionId, is_error: false }
}

/**
 * Phase-1 stand-in for the Claude Code runner. It writes deterministic transcript
 * lines so the API, worker and SSE tail can be built before a real agent exists.
 */
// TODO(phase-2): replace with the Claude Code runner
export function createEchoRunner(opts: {
  runsDir: string
  clock: () => Date
}): AgentRunner & { transcriptDir(jobId: string, runNumber?: number): string } {
  const { runsDir, clock } = opts
  const sessions = new Map<string, string>()

  /** `runs/<job-id>/<run-number>/`. Without a run number: the flat folder jobs used before runs existed. */
  const transcriptDir = (jobId: string, runNumber?: number): string =>
    runNumber === undefined ? join(runsDir, jobId) : join(runsDir, jobId, String(runNumber))

  /** The newest run's folder by number, the old flat folder if only that exists, else null. */
  const latestTranscriptDir = (jobId: string): string | null => {
    const jobDir = transcriptDir(jobId)
    if (!existsSync(jobDir)) return null
    const numbers = readdirSync(jobDir)
      .filter((name) => /^[1-9]\d*$/.test(name))
      .map(Number)
    if (numbers.length > 0) return transcriptDir(jobId, Math.max(...numbers))
    return existsSync(join(jobDir, 'transcript.jsonl')) ? jobDir : null
  }

  const jobIdForSession = (sessionId: string): string | undefined => {
    const known = sessions.get(sessionId)
    if (known !== undefined) {
      return known
    }
    if (sessionId.startsWith(SESSION_PREFIX) && sessionId.length > SESSION_PREFIX.length) {
      return sessionId.slice(SESSION_PREFIX.length)
    }
    return undefined
  }

  return {
    transcriptDir,

    async start(job: Job, runNumber: number): Promise<{ sessionId: string }> {
      const sessionId = `${SESSION_PREFIX}${job.id}`
      sessions.set(sessionId, job.id)

      const writer = createTranscriptWriter({ dir: transcriptDir(job.id, runNumber), clock })
      writer.writeOrchestrator('started', { jobId: job.id, sessionId })
      const system = systemEvent(sessionId)
      writer.writeAgent('system', system, JSON.stringify(system))
      const assistant = assistantEvent(`echo ${job.identifier}`)
      writer.writeAgent('assistant', assistant, JSON.stringify(assistant))
      const result = resultEvent(sessionId)
      writer.writeAgent('result', result, JSON.stringify(result))

      return { sessionId }
    },

    async resume(sessionId: string, feedback: string): Promise<void> {
      const jobId = jobIdForSession(sessionId)
      if (jobId === undefined) {
        throw new Error(`Unknown echo session: ${sessionId}`)
      }

      const dir = latestTranscriptDir(jobId)
      if (dir === null) {
        throw new Error(`Job ${jobId} has no run to resume`)
      }
      const writer = createTranscriptWriter({ dir, clock })
      const assistant = assistantEvent(feedback)
      writer.writeAgent('assistant', assistant, JSON.stringify(assistant))
    },

    async cancel(jobId: string): Promise<void> {
      // A job that never ran has nothing to cancel and no folder to write into.
      const dir = latestTranscriptDir(jobId)
      if (dir === null) return
      createTranscriptWriter({ dir, clock }).writeOrchestrator('cancelled', { jobId })
    },
  }
}
