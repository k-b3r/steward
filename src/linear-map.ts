// The response shape mapped here (`{ data: { issues: { nodes, pageInfo } } }`, each node with
// `id`, `identifier`, `title`, `description`, `url`, `branchName`, `labels.nodes`, `state.name`)
// was checked on 2026-10-28 against a real response: same keys and types. `description` and
// `branchName` were strings on every ticket seen, so the null and absent cases still rest on the
// synthetic fixture in tests/fixtures/linear-issues.json.

import type { WorkItem } from './types'

/** Raised when a Linear payload does not match the assumed GraphQL shape. */
export class LinearMapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LinearMapError'
  }
}

type JsonObject = Record<string, unknown>

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

function readNonEmptyString(value: unknown, field: string, source: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(source, field, 'a non-empty string')
  return value
}

function readArray(value: unknown, field: string, source: string): unknown[] {
  if (!Array.isArray(value)) fail(source, field, 'an array')
  return value
}

/** Nullable GraphQL field: `null` and an absent key both read as absent. */
function readNullableString(value: unknown, field: string, source: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') fail(source, field, 'a string or null')
  return value
}

function readLabelNames(value: unknown, source: string): string[] {
  const labels = readObject(value, 'labels', source)
  const labelNodes = readArray(labels.nodes, 'labels.nodes', source)
  return labelNodes.map((labelNode, index) => {
    const field = `labels.nodes[${index}]`
    const label = readObject(labelNode, field, source)
    return readNonEmptyString(label.name, `${field}.name`, source)
  })
}

/**
 * Maps one Linear issue node (unknown JSON) to a WorkItem.
 * `branch` is only set when `branchName` is a non-empty string.
 */
export function mapIssueToWorkItem(node: unknown, source: string): WorkItem {
  const issue = readObject(node, 'issue', source)
  const state = readObject(issue.state, 'state', source)

  const item: WorkItem = {
    source,
    externalId: readNonEmptyString(issue.id, 'id', source),
    identifier: readNonEmptyString(issue.identifier, 'identifier', source),
    title: readNonEmptyString(issue.title, 'title', source),
    body: readNullableString(issue.description, 'description', source) ?? '',
    labels: readLabelNames(issue.labels, source),
    url: readNonEmptyString(issue.url, 'url', source),
    status: readNonEmptyString(state.name, 'state.name', source),
  }

  const branch = readNullableString(issue.branchName, 'branchName', source)
  if (branch !== null && branch.length > 0) item.branch = branch

  return item
}

function readGraphQlErrors(root: JsonObject, source: string): void {
  const errors = root.errors
  if (errors === undefined || errors === null) return

  const list = readArray(errors, 'errors', source)
  if (list.length === 0) return

  const first = readObject(list[0], 'errors[0]', source)
  const message = readNullableString(first.message, 'errors[0].message', source) ?? 'unknown error'
  throw new LinearMapError(`${source}: Linear returned GraphQL errors: ${message}`)
}

/**
 * Maps one page of a Linear issues GraphQL response.
 * `nextCursor` is `endCursor` only while `hasNextPage` is true.
 */
export function parseIssuesPage(json: unknown, source: string): { items: WorkItem[]; nextCursor: string | null } {
  const root = readObject(json, 'response', source)
  readGraphQlErrors(root, source)

  const data = readObject(root.data, 'data', source)
  const issues = readObject(data.issues, 'data.issues', source)
  const nodes = readArray(issues.nodes, 'data.issues.nodes', source)
  const pageInfo = readObject(issues.pageInfo, 'data.issues.pageInfo', source)

  if (typeof pageInfo.hasNextPage !== 'boolean') {
    fail(source, 'data.issues.pageInfo.hasNextPage', 'a boolean')
  }
  const endCursor = readNullableString(pageInfo.endCursor, 'data.issues.pageInfo.endCursor', source)

  return {
    items: nodes.map((node) => mapIssueToWorkItem(node, source)),
    nextCursor: pageInfo.hasNextPage ? endCursor : null,
  }
}
