// Linear write client. Two operations: move an issue to a workflow state, and attach a pull
// request to an issue. Every write is guarded: a state outside `allowedStatuses` is refused before
// any network call. All I/O, time and randomness come in through the options object so the client
// is testable without a network or timers.

import type { Logger } from './platform/logger'
import { backoffDelayMs } from './retry-policy'

// Verified 2026-11-08 by read-only introspection against the real API (docs/decisions.md, "A Linear
// write client behind an allow list"): the `Mutation` fields `issueUpdate(id: String!, input:
// IssueUpdateInput!)` and `attachmentCreate(input: AttachmentCreateInput!)`; `IssueUpdateInput.stateId`;
// `AttachmentCreateInput.issueId`, `url`, `title`; `IssuePayload.success` and `AttachmentPayload.success`;
// `Query.workflowStates` with a `WorkflowStateFilter` (`team`, `name`) and `StringComparator.eq`;
// `TeamFilter.key`; `WorkflowState.id`; `Issue.state`, `Issue.attachments` and
// `AttachmentConnection.nodes`; `Attachment.url`. Not verified: the `id` argument type of
// `Query.issue` (assumed `String!`), and that `issue(id:)` accepts an identifier such as `CRM-19`.
// No mutation was run.
const WORKFLOW_STATE_QUERY = `query StewardWorkflowState($teamKey: String!, $name: String!) {
  workflowStates(
    filter: { team: { key: { eq: $teamKey } }, name: { eq: $name } }
    first: 5
  ) {
    nodes {
      id
    }
  }
}`

const ISSUE_STATE_QUERY = `query StewardIssueState($id: String!) {
  issue(id: $id) {
    state {
      id
    }
  }
}`

const ISSUE_ATTACHMENTS_QUERY = `query StewardIssueAttachments($id: String!) {
  issue(id: $id) {
    attachments {
      nodes {
        url
      }
    }
  }
}`

const ISSUE_UPDATE_MUTATION = `mutation StewardIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
  }
}`

const ATTACHMENT_CREATE_MUTATION = `mutation StewardAttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
  }
}`

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const SOURCE = 'linear-write'
const MAX_TRIES = 5
const RETRY_BACKOFF = { baseMs: 1000, maxMs: 60_000 }

export type LinearWriterOptions = {
  apiKey: string
  teamKey: string
  /** Statuses a ticket may be moved into (config `ALLOWED_STATUSES`). Any other name is refused. */
  allowedStatuses: readonly string[]
  fetch: typeof fetch
  logger: Logger
  sleep: (ms: number) => Promise<void>
  rand: () => number
}

export type LinearWriter = {
  moveToState(issueId: string, stateName: string): Promise<'moved' | 'already'>
  attachPullRequest(issueId: string, url: string, title: string): Promise<'attached' | 'already'>
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function retryDelayMs(attempt: number, retryAfter: string | null, rand: number): number {
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim()
    const seconds = Number(trimmed)
    if (trimmed !== '' && Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000)
    }
  }
  return backoffDelayMs(attempt, RETRY_BACKOFF, rand)
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** Reads `data.<field>` from a GraphQL response, or throws naming the operation. */
function readData(json: unknown, operation: string, field: string): JsonObject {
  if (!isJsonObject(json)) {
    throw new Error(`Linear ${operation} failed: response is not an object`)
  }

  const errors = json.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const first: unknown = errors[0]
    const message = isJsonObject(first) && typeof first.message === 'string' ? first.message : 'unknown error'
    throw new Error(`Linear ${operation} failed: ${message}`)
  }

  const data = json.data
  if (!isJsonObject(data) || !isJsonObject(data[field])) {
    throw new Error(`Linear ${operation} failed: expected data.${field} in response`)
  }
  return data[field]
}

/**
 * Builds the Linear write client. The API key is only ever sent in the Authorization header;
 * it is never put in a log field or an error message.
 */
export function createLinearWriter(options: LinearWriterOptions): LinearWriter {
  const { apiKey, teamKey, allowedStatuses, fetch: fetchImpl, logger, sleep, rand } = options
  const stateIds = new Map<string, Promise<string>>()

  async function request(operation: string, query: string, variables: JsonObject): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      })

      if (response.ok) {
        return (await response.json()) as unknown
      }

      if (!isRetryableStatus(response.status) || attempt >= MAX_TRIES) {
        throw new Error(`Linear ${operation} failed with status ${String(response.status)}`)
      }

      const delayMs = retryDelayMs(attempt, response.headers.get('retry-after'), rand())
      logger.warn('Linear request failed; retrying', {
        source: SOURCE,
        operation,
        status: response.status,
        attempt,
        delayMs,
      })
      await sleep(delayMs)
    }
  }

  /** One lookup per state name per writer. A failed lookup is dropped so the next call retries it. */
  function resolveStateId(stateName: string): Promise<string> {
    const cached = stateIds.get(stateName)
    if (cached !== undefined) return cached

    const lookup = (async () => {
      const json = await request('workflowStates', WORKFLOW_STATE_QUERY, { teamKey, name: stateName })
      const connection = readData(json, 'workflowStates', 'workflowStates')
      const nodes: unknown = connection.nodes
      const first: unknown = Array.isArray(nodes) ? nodes[0] : undefined
      if (!isJsonObject(first) || typeof first.id !== 'string') {
        throw new Error(`Linear team ${teamKey} has no workflow state named "${stateName}"`)
      }
      return first.id
    })()

    stateIds.set(stateName, lookup)
    lookup.catch(() => stateIds.delete(stateName))
    return lookup
  }

  async function moveToState(issueId: string, stateName: string): Promise<'moved' | 'already'> {
    if (!allowedStatuses.includes(stateName)) {
      throw new Error(
        `Refusing to move ${issueId} to "${stateName}": not in ALLOWED_STATUSES (${allowedStatuses.join(', ')})`,
      )
    }

    const stateId = await resolveStateId(stateName)

    const current = readData(await request('issueState', ISSUE_STATE_QUERY, { id: issueId }), 'issueState', 'issue')
    const state = current.state
    if (isJsonObject(state) && state.id === stateId) {
      return 'already'
    }

    const payload = readData(
      await request('issueUpdate', ISSUE_UPDATE_MUTATION, { id: issueId, input: { stateId } }),
      'issueUpdate',
      'issueUpdate',
    )
    if (payload.success !== true) {
      throw new Error(`Linear issueUpdate failed: success was not true for ${issueId}`)
    }

    logger.info('Linear write', { source: SOURCE, issueId, operation: 'issueUpdate', stateName })
    return 'moved'
  }

  async function attachPullRequest(issueId: string, url: string, title: string): Promise<'attached' | 'already'> {
    const existing = readData(
      await request('issueAttachments', ISSUE_ATTACHMENTS_QUERY, { id: issueId }),
      'issueAttachments',
      'issue',
    )
    const attachments = existing.attachments
    const nodes: unknown = isJsonObject(attachments) ? attachments.nodes : undefined
    if (Array.isArray(nodes) && nodes.some((node) => isJsonObject(node) && node.url === url)) {
      return 'already'
    }

    const payload = readData(
      await request('attachmentCreate', ATTACHMENT_CREATE_MUTATION, {
        input: { issueId, url, title },
      }),
      'attachmentCreate',
      'attachmentCreate',
    )
    if (payload.success !== true) {
      throw new Error(`Linear attachmentCreate failed: success was not true for ${issueId}`)
    }

    logger.info('Linear write', { source: SOURCE, issueId, operation: 'attachmentCreate' })
    return 'attached'
  }

  return { moveToState, attachPullRequest }
}
