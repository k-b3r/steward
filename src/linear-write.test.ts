import { describe, expect, it } from 'vitest'

import { createLinearWriter, type LinearWriterOptions } from './linear-write'
import { createLogger } from './platform/logger'

const API_KEY = 'fake-linear-key-for-tests'
const TEAM_KEY = 'TST'
const ISSUE_ID = 'issue-1'
const CLOCK = new Date('2026-11-08T00:00:00.000Z')
const PR_URL = 'https://github.com/k-b3r/steward/pull/99'

type FetchCall = {
  url: string
  headers: Record<string, string>
  body: { query: string; variables: Record<string, unknown> }
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

const stateLookup = (id: string) => () => jsonResponse({ data: { workflowStates: { nodes: [{ id }] } } })
const issueState = (id: string) => () => jsonResponse({ data: { issue: { state: { id } } } })
const issueUpdated = (success: boolean) => () => jsonResponse({ data: { issueUpdate: { success } } })
const issueAttachments = (urls: string[]) => () =>
  jsonResponse({ data: { issue: { attachments: { nodes: urls.map((url) => ({ url })) } } } })
const attachmentCreated = (success: boolean) => () => jsonResponse({ data: { attachmentCreate: { success } } })

/** Serves responses in order and records each request body. Running out of responses fails the test. */
function fakeFetch(responses: (() => Response)[]) {
  const calls: FetchCall[] = []
  let index = 0

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)) as FetchCall['body'],
    })
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

function writerWith(overrides: Partial<LinearWriterOptions> & Pick<LinearWriterOptions, 'fetch'>) {
  const { logger } = captureLogger()
  return createLinearWriter({
    apiKey: API_KEY,
    teamKey: TEAM_KEY,
    allowedStatuses: ['In Progress'],
    logger,
    sleep: async () => undefined,
    rand: () => 0.5,
    ...overrides,
  })
}

describe('moveToState', () => {
  it('refuses a status outside the allow list before any network call', async () => {
    const fake = fakeFetch([])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.moveToState(ISSUE_ID, 'Done')).rejects.toThrow(/Done.*ALLOWED_STATUSES/)
    expect(fake.calls).toHaveLength(0)
  })

  it('moves the issue to an allowed state', async () => {
    const fake = fakeFetch([stateLookup('state-ip'), issueState('state-todo'), issueUpdated(true)])
    const { logger, lines } = captureLogger()
    const writer = writerWith({ fetch: fake.fetch, logger })

    await expect(writer.moveToState(ISSUE_ID, 'In Progress')).resolves.toBe('moved')

    expect(fake.calls).toHaveLength(3)
    expect(fake.calls[2]?.body.variables).toEqual({ id: ISSUE_ID, input: { stateId: 'state-ip' } })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(ISSUE_ID)
    expect(lines[0]).toContain('issueUpdate')
  })

  it('returns already without a mutation when the issue is in that state', async () => {
    const fake = fakeFetch([stateLookup('state-ip'), issueState('state-ip')])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.moveToState(ISSUE_ID, 'In Progress')).resolves.toBe('already')
    expect(fake.calls.map((call) => call.body.query)).not.toContainEqual(expect.stringContaining('issueUpdate'))
  })

  it('looks up the state id once per writer and reuses it', async () => {
    const fake = fakeFetch([
      stateLookup('state-ip'),
      issueState('state-todo'),
      issueUpdated(true),
      issueState('state-todo'),
      issueUpdated(true),
    ])
    const writer = writerWith({ fetch: fake.fetch })

    await writer.moveToState('issue-a', 'In Progress')
    await writer.moveToState('issue-b', 'In Progress')

    const lookups = fake.calls.filter((call) => call.body.query.includes('workflowStates'))
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.body.variables).toEqual({ teamKey: TEAM_KEY, name: 'In Progress' })
  })

  it('throws a clear error when the team has no state with that name', async () => {
    const fake = fakeFetch([() => jsonResponse({ data: { workflowStates: { nodes: [] } } })])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.moveToState(ISSUE_ID, 'In Progress')).rejects.toThrow(
      `Linear team ${TEAM_KEY} has no workflow state named "In Progress"`,
    )
  })

  it('throws when issueUpdate reports success false, naming the operation', async () => {
    const fake = fakeFetch([stateLookup('state-ip'), issueState('state-todo'), issueUpdated(false)])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.moveToState(ISSUE_ID, 'In Progress')).rejects.toThrow(/issueUpdate/)
  })
})

describe('attachPullRequest', () => {
  it('attaches the pull request to the issue', async () => {
    const fake = fakeFetch([issueAttachments([]), attachmentCreated(true)])
    const { logger, lines } = captureLogger()
    const writer = writerWith({ fetch: fake.fetch, logger })

    await expect(writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')).resolves.toBe('attached')

    expect(fake.calls[1]?.body.variables).toEqual({
      input: { issueId: ISSUE_ID, url: PR_URL, title: 'Fix things' },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(ISSUE_ID)
    expect(lines[0]).toContain('attachmentCreate')
  })

  it('returns already without a create call when the url is attached', async () => {
    const fake = fakeFetch([issueAttachments(['https://example.com/other', PR_URL])])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')).resolves.toBe('already')
    expect(fake.calls).toHaveLength(1)
  })

  it('throws when attachmentCreate reports success false', async () => {
    const fake = fakeFetch([issueAttachments([]), attachmentCreated(false)])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')).rejects.toThrow(/attachmentCreate/)
  })
})

describe('transport', () => {
  it('sends the bare API key in Authorization, with no Bearer prefix', async () => {
    const fake = fakeFetch([issueAttachments([]), attachmentCreated(true)])
    const writer = writerWith({ fetch: fake.fetch })

    await writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')

    expect(fake.calls[0]?.url).toBe('https://api.linear.app/graphql')
    expect(fake.calls[0]?.headers.Authorization).toBe(API_KEY)
  })

  it('retries 429 and 5xx with backoff, honouring Retry-After', async () => {
    const fake = fakeFetch([
      () => errorResponse(429, { 'retry-after': '3' }),
      () => errorResponse(503),
      issueAttachments([]),
      attachmentCreated(true),
    ])
    const sleeps: number[] = []
    const writer = writerWith({
      fetch: fake.fetch,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    await expect(writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')).resolves.toBe('attached')

    expect(fake.calls).toHaveLength(4)
    expect(sleeps).toEqual([3000, 2000])
  })

  it('applies jitter from rand to the exponential delay', async () => {
    const fake = fakeFetch([() => errorResponse(503), issueAttachments([]), attachmentCreated(true)])
    const sleeps: number[] = []
    const writer = writerWith({
      fetch: fake.fetch,
      rand: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })

    await writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')

    // rand 0 takes the low end of the 20% band: 1000 ms base becomes 800 ms.
    expect(sleeps).toEqual([800])
  })

  it('gives up after five tries with a status error that holds no key', async () => {
    const fake = fakeFetch([
      () => errorResponse(500),
      () => errorResponse(500),
      () => errorResponse(500),
      () => errorResponse(500),
      () => errorResponse(500),
    ])
    const writer = writerWith({ fetch: fake.fetch })

    const failure = writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')
    await expect(failure).rejects.toThrow('Linear issueAttachments failed with status 500')
    expect(fake.calls).toHaveLength(5)
  })

  it('does not retry a 400 response', async () => {
    const fake = fakeFetch([() => errorResponse(400)])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')).rejects.toThrow('status 400')
    expect(fake.calls).toHaveLength(1)
  })

  it('throws on a GraphQL errors array, naming the operation', async () => {
    const fake = fakeFetch([() => jsonResponse({ errors: [{ message: 'Entity not found' }] })])
    const writer = writerWith({ fetch: fake.fetch })

    await expect(writer.attachPullRequest(ISSUE_ID, PR_URL, 'Fix things')).rejects.toThrow(
      'Linear issueAttachments failed: Entity not found',
    )
  })

  it('never puts the API key in an error message or a log line', async () => {
    const { logger, lines } = captureLogger()
    const fake = fakeFetch([stateLookup('state-ip'), issueState('state-todo'), issueUpdated(true)])
    const writer = writerWith({ fetch: fake.fetch, logger })
    await writer.moveToState(ISSUE_ID, 'In Progress')

    const failing = fakeFetch([() => jsonResponse({ errors: [{ message: 'nope' }] })])
    const failingWriter = writerWith({ fetch: failing.fetch, logger })
    const error = await failingWriter.moveToState(ISSUE_ID, 'In Progress').catch((caught: unknown) => caught)

    expect(String(error)).not.toContain(API_KEY)
    expect(lines.join('\n')).not.toContain(API_KEY)
  })
})
