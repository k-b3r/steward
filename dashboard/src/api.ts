// Browser client for the Steward API. Types and schemas come from the shared contract only.
import { z } from 'zod'

import { actionResponseSchema, jobResponseSchema, transcriptEnvelopeSchema } from '../../src/api/contract'
import type { ActionResponse, JobResponse } from '../../src/api/contract'

export type { ActionResponse, JobResponse }

/**
 * One transcript line as the log stream delivers it, parsed by `transcriptEnvelopeSchema`; the server
 * builds the same shape in `src/runner/transcript.ts` and `src/api/contract.ts` asserts the two match.
 * `followLog` passes these to `job-detail.tsx`, which appends them to the log pane and keeps `seq` as
 * its resume cursor. There is no job id in it, because the stream is per job, and `data` stays
 * `unknown` for the caller to read.
 */
export type Envelope = z.infer<typeof transcriptEnvelopeSchema>

const TOKEN_KEY = 'steward.token'

// The token lives in sessionStorage only (see docs/security.md on the XSS trade-off).
export const token = {
  get: (): string | null => sessionStorage.getItem(TOKEN_KEY),
  set: (value: string): void => sessionStorage.setItem(TOKEN_KEY, value),
  clear: (): void => sessionStorage.removeItem(TOKEN_KEY),
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const bearer = token.get()
  const headers = new Headers(init.headers)
  if (bearer !== null) headers.set('Authorization', `Bearer ${bearer}`)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers })
  if (response.ok) return response
  const body: unknown = await response.json().catch(() => ({}))
  const message =
    typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `HTTP ${response.status}`
  throw new ApiError(response.status, message)
}

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await request(path)).json())
}

async function post<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const init: RequestInit = { method: 'POST' }
  if (body !== undefined) init.body = JSON.stringify(body)
  return schema.parse(await (await request(path, init)).json())
}

export const api = {
  jobs: () => getJson('/v1/jobs', z.array(jobResponseSchema)),
  job: (id: string) => getJson(`/v1/jobs/${id}`, jobResponseSchema),
  actions: () => getJson('/v1/actions', z.array(actionResponseSchema)),
  retry: (id: string) => post(`/v1/jobs/${id}/retry`, jobResponseSchema),
  cancel: (id: string) => post(`/v1/jobs/${id}/cancel`, jobResponseSchema),
  confirm: (id: string) => post(`/v1/jobs/${id}/confirm`, jobResponseSchema),
  decline: (id: string, reason: string) => post(`/v1/jobs/${id}/decline`, jobResponseSchema, { reason }),
  reconsider: (id: string) => post(`/v1/jobs/${id}/reconsider`, jobResponseSchema),
  approve: (id: string) => post(`/v1/actions/${id}/approve`, actionResponseSchema),
  reject: (id: string, reason?: string) =>
    post(`/v1/actions/${id}/reject`, actionResponseSchema, reason === undefined ? {} : { reason }),
}

/**
 * Follows a job's transcript over SSE. EventSource cannot send an Authorization header,
 * so this reads the fetch stream and parses the frames itself. Resolves when aborted.
 */
export async function followLog(
  jobId: string,
  opts: { after: number; signal: AbortSignal; onEnvelope: (e: Envelope) => void },
): Promise<void> {
  const response = await request(`/v1/jobs/${jobId}/log?after=${opts.after}`, {
    headers: { Accept: 'text/event-stream' },
    signal: opts.signal,
  })
  if (response.body === null) return
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += value
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data === '') continue
      // A frame that is not JSON is skipped. Throwing would end the stream, and the reconnect resumes
      // from the last good sequence number, so one bad frame would loop forever.
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      const parsed = transcriptEnvelopeSchema.safeParse(payload)
      if (parsed.success) opts.onEnvelope(parsed.data)
    }
  }
}
