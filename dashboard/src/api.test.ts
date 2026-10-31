import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api, followLog, token } from './api'
import type { Envelope } from './api'

const JOB = {
  id: '11111111-1111-4111-8111-111111111111',
  source: 'linear',
  ticketKey: 'TST-1',
  state: 'queued',
  attempt: 0,
  maxAttempts: 3,
  slot: null,
  nextRunAt: null,
  failureKind: null,
  allowedActions: ['confirm', 'decline'],
}

function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size
    },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const frame = (seq: number, msg: string): string =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, ts: '2026-01-01T00:00:00.000Z', kind: 'orchestrator', data: { msg } })}\n\n`

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('token', () => {
  it('lives in sessionStorage and can be cleared', () => {
    expect(token.get()).toBeNull()
    token.set('abc')
    expect(token.get()).toBe('abc')
    expect(sessionStorage.getItem('steward.token')).toBe('abc')
    token.clear()
    expect(token.get()).toBeNull()
  })
})

describe('requests', () => {
  it('sends the token as a Bearer header', async () => {
    token.set('secret-token')
    fetchMock.mockResolvedValue(json([JOB]))

    await api.jobs()

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer secret-token')
  })

  it('sends no Authorization header when signed out', async () => {
    fetchMock.mockResolvedValue(json([JOB]))

    await api.jobs()

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false)
  })

  it('turns an error body into an ApiError with the server message and status', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Illegal job state transition: done -> queued' }, 409))

    const failure = await api.retry(JOB.id).catch((caught: unknown) => caught)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 409, message: 'Illegal job state transition: done -> queued' })
  })

  it('falls back to the status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 502 }))

    await expect(api.jobs()).rejects.toMatchObject({ status: 502, message: 'HTTP 502' })
  })

  it('rejects a response that does not match the contract', async () => {
    fetchMock.mockResolvedValue(json([{ ...JOB, state: 'exploded' }]))

    await expect(api.jobs()).rejects.toThrow()
  })

  it('posts the decline reason as JSON', async () => {
    fetchMock.mockResolvedValue(json({ ...JOB, state: 'declined' }))

    await api.decline(JOB.id, 'not for the agent')

    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ reason: 'not for the agent' }))
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
  })
})

describe('followLog', () => {
  const run = async (chunks: string[], after = 0): Promise<Envelope[]> => {
    fetchMock.mockResolvedValue(sse(chunks))
    const seen: Envelope[] = []
    await followLog(JOB.id, { after, signal: new AbortController().signal, onEnvelope: (e) => seen.push(e) })
    return seen
  }

  it('asks for lines after the given sequence number', async () => {
    await run([], 7)

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/v1/jobs/${JOB.id}/log?after=7`)
  })

  it('reads frames that arrive whole, in order', async () => {
    const seen = await run([frame(1, 'one') + frame(2, 'two')])

    expect(seen.map((e) => e.seq)).toEqual([1, 2])
  })

  it('reassembles a frame split across chunks', async () => {
    const whole = frame(1, 'split me')
    const seen = await run([whole.slice(0, 20), whole.slice(20, 50), whole.slice(50)])

    expect(seen).toHaveLength(1)
    expect(seen[0]?.data).toEqual({ msg: 'split me' })
  })

  it('handles CRLF line endings', async () => {
    const seen = await run([frame(1, 'crlf').replace(/\n/g, '\r\n')])

    expect(seen.map((e) => e.seq)).toEqual([1])
  })

  it('ignores frames that are not transcript envelopes, such as the in-stream error notice', async () => {
    const seen = await run(['data: {"error":"internal"}\n\n', frame(1, 'ok')])

    expect(seen.map((e) => e.seq)).toEqual([1])
  })

  it('skips a malformed frame instead of ending the stream', async () => {
    const seen = await run(['data: {not json\n\n', frame(2, 'after the bad one')])

    expect(seen.map((e) => e.seq)).toEqual([2])
  })
})
