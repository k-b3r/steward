// Linear WorkFeed implementation. All I/O, time and randomness come in through
// the options object so the client is testable without a network or timers.

import { LinearMapError, mapIssueToWorkItem } from './linear-map'
import type { Logger } from './platform/logger'
import type { WorkItem, WorkFeed } from './types'

// Verified 2026-10-28 against the real API with a personal key and one team (docs/decisions.md): the
// filter (`team.key.eq`, `assignee.isMe.eq`, `state.name.in`), the selected fields and the
// `first`/`after` arguments are accepted, and the response matches src/linear-map.ts. Not
// verified: the `Todo` and `Backlog` states (only `In Progress` tickets existed), a page
// with `hasNextPage: true`, and that `isMe` excludes other people's tickets (one user only).
const ISSUES_QUERY = `query StewardIntake($teamKey: String!, $after: String, $first: Int!) {
  issues(
    filter: {
      team: { key: { eq: $teamKey } }
      assignee: { isMe: { eq: true } }
      state: { name: { in: ["Todo", "Backlog", "In Progress"] } }
    }
    first: $first
    after: $after
  ) {
    nodes {
      id
      identifier
      title
      description
      url
      branchName
      labels {
        nodes {
          name
        }
      }
      state {
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const PAGE_SIZE = 50
const MAX_TRIES = 5
const BASE_RETRY_DELAY_MS = 1000
const RETRY_FACTOR = 2

export type LinearClientOptions = {
  apiKey: string
  teamKey: string
  fetch: typeof fetch
  logger: Logger
  sleep: (ms: number) => Promise<void>
  rand: () => number
  /** Defaults to "linear". */
  source?: string
}

export type LinearClient = WorkFeed & {
  poll(): AsyncIterable<WorkItem>
}

type JsonObject = Record<string, unknown>

type IssuesPage = {
  nodes: unknown[]
  nextCursor: string | null
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(source: string, field: string, expected: string): never {
  throw new LinearMapError(`${source}: expected ${field} to be ${expected}`)
}

function readObject(value: unknown, field: string, source: string): JsonObject {
  if (!isJsonObject(value)) fail(source, field, 'an object')
  return value
}

function readArray(value: unknown, field: string, source: string): unknown[] {
  if (!Array.isArray(value)) fail(source, field, 'an array')
  return value
}

function readGraphQlErrors(root: JsonObject, source: string): void {
  const errors = root.errors
  if (errors === undefined || errors === null) return

  const list = readArray(errors, 'errors', source)
  if (list.length === 0) return

  const first = readObject(list[0], 'errors[0]', source)
  const message = typeof first.message === 'string' ? first.message : 'unknown error'
  throw new LinearMapError(`${source}: Linear returned GraphQL errors: ${message}`)
}

/** Validates the page envelope; node mapping stays per-node so one bad node does not drop the page. */
function parsePageEnvelope(json: unknown, source: string): IssuesPage {
  const root = readObject(json, 'response', source)
  readGraphQlErrors(root, source)

  const data = readObject(root.data, 'data', source)
  const issues = readObject(data.issues, 'data.issues', source)
  const nodes = readArray(issues.nodes, 'data.issues.nodes', source)
  const pageInfo = readObject(issues.pageInfo, 'data.issues.pageInfo', source)

  if (typeof pageInfo.hasNextPage !== 'boolean') {
    fail(source, 'data.issues.pageInfo.hasNextPage', 'a boolean')
  }

  let endCursor: string | null = null
  if (pageInfo.endCursor !== null && pageInfo.endCursor !== undefined) {
    if (typeof pageInfo.endCursor !== 'string') {
      fail(source, 'data.issues.pageInfo.endCursor', 'a string or null')
    }
    endCursor = pageInfo.endCursor
  }

  return { nodes, nextCursor: pageInfo.hasNextPage ? endCursor : null }
}

function readNodeId(node: unknown): string | undefined {
  if (!isJsonObject(node)) return undefined
  return typeof node.id === 'string' ? node.id : undefined
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim()
    const seconds = Number(trimmed)
    if (trimmed !== '' && Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000)
    }
  }
  return BASE_RETRY_DELAY_MS * RETRY_FACTOR ** (attempt - 1)
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function createPageFetcher(options: LinearClientOptions, source: string) {
  const { apiKey, teamKey, fetch: fetchImpl, logger, sleep } = options

  return async function fetchPage(cursor: string | null): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: ISSUES_QUERY,
          variables: { teamKey, after: cursor, first: PAGE_SIZE },
        }),
      })

      if (response.ok) {
        return (await response.json()) as unknown
      }

      if (!isRetryableStatus(response.status) || attempt >= MAX_TRIES) {
        throw new Error(`Linear request failed with status ${String(response.status)}`)
      }

      const delayMs = retryDelayMs(attempt, response.headers.get('retry-after'))
      logger.warn('Linear request failed; retrying', {
        source,
        status: response.status,
        attempt,
        delayMs,
      })
      await sleep(delayMs)
    }
  }
}

/**
 * Builds the Linear feed. The API key is only ever sent in the Authorization
 * header; it is never put in a log field or message.
 */
export function createLinearClient(options: LinearClientOptions): LinearClient {
  const source = options.source ?? 'linear'
  const fetchPage = createPageFetcher(options, source)

  async function* pollPages(): AsyncGenerator<WorkItem, void, void> {
    let cursor: string | null = null
    let firstPage = true

    do {
      const json = await fetchPage(cursor)
      if (firstPage) {
        options.logger.info('Linear raw response', { source, response: json })
        firstPage = false
      }

      const page = parsePageEnvelope(json, source)
      for (const node of page.nodes) {
        try {
          yield mapIssueToWorkItem(node, source)
        } catch (error) {
          if (!(error instanceof LinearMapError)) {
            throw error
          }
          options.logger.warn('Skipping malformed Linear issue', {
            source,
            nodeId: readNodeId(node),
            error: error.message,
          })
        }
      }
      cursor = page.nextCursor
    } while (cursor !== null)
  }

  return {
    poll(): AsyncIterable<WorkItem> {
      return pollPages()
    },
  }
}
