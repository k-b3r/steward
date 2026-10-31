import { describe, expect, it } from 'vitest'

import { createLinearClient, type LinearClientOptions } from './linear'
import { LinearMapError } from './linear-map'
import { createLogger } from './platform/logger'
import type { WorkItem } from './types'

const API_KEY = 'fake-linear-key-for-tests'
const TEAM_KEY = 'TST'
const CLOCK = new Date('2026-10-27T00:00:00.000Z')

type FetchCall = {
  input: string | URL | Request
  init: RequestInit | undefined
}

type FakeFetch = {
  fetch: typeof fetch
  calls: FetchCall[]
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return jsonResponse({ errors: [{ message: `synthetic ${String(status)}` }] }, status, headers)
}

function fakeFetch(responses: (() => Response)[]): FakeFetch {
  const calls: FetchCall[] = []
  let index = 0

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init })
    const response = responses[index]
    index += 1
    if (response === undefined) {
      throw new Error('Unexpected extra fetch call')
    }
    return response()
  }

  return { fetch: fetchImpl as typeof fetch, calls }
}

function captureLogger() {
  const lines: string[] = []
  const logger = createLogger({ write: (line) => lines.push(line), clock: () => CLOCK })
  return { logger, lines }
}

function captureSleep() {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number): Promise<void> => {
      delays.push(ms)
    },
  }
}

function makeClient(
  fetchImpl: typeof fetch,
  options: {
    logger?: ReturnType<typeof captureLogger>['logger']
    sleep?: (ms: number) => Promise<void>
    source?: string
  } = {},
) {
  const captured = captureLogger()
  const sleeper = captureSleep()
  const opts: LinearClientOptions = {
    apiKey: API_KEY,
    teamKey: TEAM_KEY,
    fetch: fetchImpl,
    logger: options.logger ?? captured.logger,
    sleep: options.sleep ?? sleeper.sleep,
    rand: () => 0.5,
    ...(options.source === undefined ? {} : { source: options.source }),
  }
  return { client: createLinearClient(opts), lines: captured.lines, delays: sleeper.delays }
}

function linearNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lin_synthetic_0001',
    identifier: 'TST-1',
    title: 'Synthetic ticket',
    description: 'Synthetic body',
    url: 'https://example.com/tst/issues/TST-1',
    branchName: 'tst-1-synthetic',
    labels: { nodes: [{ name: 'bug' }] },
    state: { name: 'Todo' },
    ...overrides,
  }
}

function pageOf(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
): unknown {
  return { data: { issues: { nodes, pageInfo } } }
}

async function collect(feed: AsyncIterable<WorkItem>): Promise<WorkItem[]> {
  const items: WorkItem[] = []
  for await (const item of feed) {
    items.push(item)
  }
  return items
}

function requestBody(call: FetchCall): {
  query: string
  variables: { teamKey: string; after: string | null; first: number }
} {
  return JSON.parse(String(call.init?.body)) as {
    query: string
    variables: { teamKey: string; after: string | null; first: number }
  }
}

function requestHeaders(call: FetchCall): Headers {
  return new Headers(call.init?.headers)
}

describe('createLinearClient', () => {
  it('posts the GraphQL query with the raw API key and no Bearer prefix', async () => {
    const fake = fakeFetch([() => jsonResponse(pageOf([linearNode()]))])
    const { client } = makeClient(fake.fetch)

    const items = await collect(client.poll())

    expect(items.map((item) => item.ticketKey)).toEqual(['TST-1'])
    expect(fake.calls).toHaveLength(1)
    const [call] = fake.calls
    expect(String(call?.input)).toBe('https://api.linear.app/graphql')
    expect(call?.init?.method).toBe('POST')
    const headers = requestHeaders(call as FetchCall)
    expect(headers.get('authorization')).toBe(API_KEY)
    expect(headers.get('authorization')).not.toContain('Bearer')
    expect(headers.get('content-type')).toContain('application/json')

    const body = requestBody(call as FetchCall)
    expect(body.query).toContain('issues')
    expect(body.query).toContain('isMe')
    expect(body.variables).toEqual({ teamKey: TEAM_KEY, after: null, first: 50 })
  })

  it('uses the default source "linear" and accepts an override', async () => {
    const fake = fakeFetch([() => jsonResponse(pageOf([linearNode()]))])
    const { client } = makeClient(fake.fetch)
    const [item] = await collect(client.poll())
    expect(item?.source).toBe('linear')

    const overrideFake = fakeFetch([() => jsonResponse(pageOf([linearNode()]))])
    const override = makeClient(overrideFake.fetch, { source: 'linear-work' })
    const [overrideItem] = await collect(override.client.poll())
    expect(overrideItem?.source).toBe('linear-work')
  })

  it('logs the raw JSON of the first page at info level on every poll', async () => {
    const firstPage = pageOf([linearNode()])
    const fake = fakeFetch([() => jsonResponse(firstPage), () => jsonResponse(firstPage)])
    const { client, lines } = makeClient(fake.fetch)

    await collect(client.poll())
    await collect(client.poll())

    const rawLines = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'Linear raw response')
    expect(rawLines).toHaveLength(2)
    expect(rawLines[0]).toMatchObject({ level: 'info', response: firstPage })
  })

  it('follows pagination cursors across pages and yields every node', async () => {
    const first = pageOf([linearNode()], { hasNextPage: true, endCursor: 'cursor-page-1' })
    const second = pageOf([linearNode({ id: 'lin_synthetic_0002', identifier: 'TST-2' })])
    const fake = fakeFetch([() => jsonResponse(first), () => jsonResponse(second)])
    const { client, lines } = makeClient(fake.fetch)

    const items = await collect(client.poll())

    expect(items.map((item) => item.ticketKey)).toEqual(['TST-1', 'TST-2'])
    expect(requestBody(fake.calls[0] as FetchCall).variables.after).toBeNull()
    expect(requestBody(fake.calls[1] as FetchCall).variables.after).toBe('cursor-page-1')
    const rawLines = lines.filter((line) => line.includes('Linear raw response'))
    expect(rawLines).toHaveLength(1)
  })

  it('retries a 429 and then succeeds', async () => {
    const fake = fakeFetch([() => errorResponse(429), () => jsonResponse(pageOf([linearNode()]))])
    const { client, delays, lines } = makeClient(fake.fetch)

    const items = await collect(client.poll())

    expect(items).toHaveLength(1)
    expect(fake.calls).toHaveLength(2)
    expect(delays).toEqual([1000])
    expect(lines.some((line) => line.includes('retrying'))).toBe(true)
  })

  it('honours a numeric Retry-After header in seconds', async () => {
    const fake = fakeFetch([
      () => errorResponse(429, { 'retry-after': '2' }),
      () => jsonResponse(pageOf([linearNode()])),
    ])
    const { client, delays } = makeClient(fake.fetch)

    await collect(client.poll())

    expect(delays).toEqual([2000])
  })

  it('retries 5xx up to five tries and then throws the status', async () => {
    const fake = fakeFetch(Array.from({ length: 5 }, () => () => errorResponse(500)))
    const { client, delays } = makeClient(fake.fetch)

    await expect(collect(client.poll())).rejects.toThrow(/500/)
    expect(fake.calls).toHaveLength(5)
    expect(delays).toEqual([1000, 2000, 4000, 8000])
  })

  it('does not retry other 4xx responses', async () => {
    const fake = fakeFetch([() => errorResponse(400)])
    const { client, delays } = makeClient(fake.fetch)

    await expect(collect(client.poll())).rejects.toThrow(/400/)
    expect(fake.calls).toHaveLength(1)
    expect(delays).toEqual([])
  })

  it('skips one malformed node and returns the others', async () => {
    const badNode = linearNode({ id: 'lin_synthetic_bad', identifier: 'TST-9', title: undefined })
    const fake = fakeFetch([
      () =>
        jsonResponse(pageOf([linearNode(), badNode, linearNode({ id: 'lin_synthetic_0003', identifier: 'TST-3' })])),
    ])
    const { client, lines } = makeClient(fake.fetch)

    const items = await collect(client.poll())

    expect(items.map((item) => item.ticketKey)).toEqual(['TST-1', 'TST-3'])
    const warning = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.level === 'warn')
    expect(warning).toMatchObject({ nodeId: 'lin_synthetic_bad' })
  })

  it('never logs the API key, even on retries and malformed nodes', async () => {
    const badNode = linearNode({ title: undefined })
    const fake = fakeFetch([() => errorResponse(429), () => jsonResponse(pageOf([linearNode(), badNode]))])
    const { client, lines } = makeClient(fake.fetch)

    await collect(client.poll())

    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain(API_KEY)
  })

  it('throws a LinearMapError for GraphQL errors', async () => {
    const fake = fakeFetch([() => jsonResponse({ errors: [{ message: 'Synthetic GraphQL failure' }], data: null })])
    const { client } = makeClient(fake.fetch)

    await expect(collect(client.poll())).rejects.toThrow(LinearMapError)
    const emptyPage = {
      errors: [],
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    }
    await expect(collect(makeClient(fakeFetch([() => jsonResponse(emptyPage)]).fetch).client.poll())).resolves.toEqual(
      [],
    )
  })

  it('throws a LinearMapError when the page envelope is malformed', async () => {
    const fake = fakeFetch([() => jsonResponse({ data: { issues: { nodes: {} } } })])
    const { client } = makeClient(fake.fetch)

    await expect(collect(client.poll())).rejects.toThrow(LinearMapError)
  })
})
