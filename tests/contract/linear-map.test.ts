import { mapIssueToWorkItem, parseIssuesPage } from '../../src/linear-map'

const SOURCE = 'linear'

// One Linear issue node. `id`, `identifier` and `branchName` are the field names the task and the doc comments give.
// `title`, `description`, `url`, `state.name` and `labels.nodes[].name` are Linear's public GraphQL names, because
// no document in the spec lists the node shape (see NOTES-A.md, "Spec gaps").
const issueNode = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'b7c1f0a2-5d3e-4f60-8a91-2c4d6e8f0a11',
  identifier: 'TST-1',
  title: 'Add a /health endpoint (v2): "ping" & status',
  description: 'Return 200 from /health so the box can be probed.',
  url: 'https://linear.app/example/issue/TST-1/add-a-health-endpoint',
  branchName: 'tst-1-add-a-health-endpoint',
  state: { name: 'Todo' },
  labels: { nodes: [{ name: 'backend' }, { name: 'api' }] },
  ...overrides,
})

// One page of the issues query: the nodes plus the cursor fields `parseIssuesPage` names in its doc comment.
const issuesPage = (nodes: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }): unknown => ({
  data: { issues: { nodes, pageInfo } },
})

describe('mapIssueToWorkItem', () => {
  it('maps the Linear id to sourceId', () => {
    expect(mapIssueToWorkItem(issueNode(), SOURCE).sourceId).toBe('b7c1f0a2-5d3e-4f60-8a91-2c4d6e8f0a11')
  })

  it('maps the Linear identifier to ticketKey', () => {
    expect(mapIssueToWorkItem(issueNode(), SOURCE).ticketKey).toBe('TST-1')
  })

  it('writes the source argument into the source of the work item', () => {
    expect(mapIssueToWorkItem(issueNode(), 'linear-second').source).toBe('linear-second')
  })

  it('keeps the title verbatim', () => {
    expect(mapIssueToWorkItem(issueNode(), SOURCE).title).toBe('Add a /health endpoint (v2): "ping" & status')
  })

  it('maps the description to body', () => {
    expect(mapIssueToWorkItem(issueNode(), SOURCE).body).toBe('Return 200 from /health so the box can be probed.')
  })

  it('maps the name of the workflow state to status', () => {
    expect(mapIssueToWorkItem(issueNode({ state: { name: 'In Progress' } }), SOURCE).status).toBe('In Progress')
  })

  it('lists the label names in the order the tracker returned them', () => {
    expect(mapIssueToWorkItem(issueNode(), SOURCE).labels).toEqual(['backend', 'api'])
  })

  it('maps the issue url', () => {
    expect(mapIssueToWorkItem(issueNode(), SOURCE).url).toBe(
      'https://linear.app/example/issue/TST-1/add-a-health-endpoint',
    )
  })

  it('sets branch from a non-empty branchName', () => {
    expect(mapIssueToWorkItem(issueNode(), SOURCE).branch).toBe('tst-1-add-a-health-endpoint')
  })
})

describe('parseIssuesPage', () => {
  const secondNode = issueNode({ id: 'c8d2a1b3-6e4f-4a71-9ba2-3d5e7f9a1b22', identifier: 'TST-2' })

  it('maps every node of the page to a work item', () => {
    const page = parseIssuesPage(issuesPage([issueNode(), secondNode], { hasNextPage: false, endCursor: null }), SOURCE)

    expect(page.items.map((item) => item.ticketKey).sort()).toEqual(['TST-1', 'TST-2'])
  })

  it('writes the source argument into every work item', () => {
    const page = parseIssuesPage(
      issuesPage([issueNode(), secondNode], { hasNextPage: false, endCursor: null }),
      'linear-second',
    )

    expect(page.items.map((item) => item.source)).toEqual(['linear-second', 'linear-second'])
  })

  it('returns endCursor as nextCursor while hasNextPage is true', () => {
    const page = parseIssuesPage(issuesPage([issueNode()], { hasNextPage: true, endCursor: 'cursor-after-1' }), SOURCE)

    expect(page.nextCursor).toBe('cursor-after-1')
  })

  it('returns a null nextCursor once hasNextPage is false, even when the page has an endCursor', () => {
    const page = parseIssuesPage(issuesPage([issueNode()], { hasNextPage: false, endCursor: 'cursor-after-1' }), SOURCE)

    expect(page.nextCursor).toBeNull()
  })
})
