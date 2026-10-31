import { join } from 'node:path'

import type { AgentRunner, Job } from '../types'
import { createTranscriptWriter } from './transcript'

const SESSION_PREFIX = 'echo-'

type AgentEvent = {
  /** Type of agent event; the echo runner emits only these three, as init, message and success. */
  type: 'system' | 'assistant' | 'result'
  /** Other fields the event carries (`subtype`, `sessionId`, `model`, `message`); passed to the transcript unread. */
  [key: string]: unknown
}

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
}): AgentRunner & { transcriptDir(jobId: string): string } {
  const { runsDir, clock } = opts
  const sessions = new Map<string, string>()

  const transcriptDir = (jobId: string): string => join(runsDir, jobId)

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

    async start(job: Job): Promise<{ sessionId: string }> {
      const sessionId = `${SESSION_PREFIX}${job.id}`
      sessions.set(sessionId, job.id)

      const writer = createTranscriptWriter({ dir: transcriptDir(job.id), clock })
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

      const writer = createTranscriptWriter({ dir: transcriptDir(jobId), clock })
      const assistant = assistantEvent(feedback)
      writer.writeAgent('assistant', assistant, JSON.stringify(assistant))
    },

    async cancel(jobId: string): Promise<void> {
      const writer = createTranscriptWriter({ dir: transcriptDir(jobId), clock })
      writer.writeOrchestrator('cancelled', { jobId })
    },
  }
}
