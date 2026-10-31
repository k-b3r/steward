import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LinearMapError, mapIssueToWorkItem, parseIssuesPage } from './linear-map'

type FixtureNode = {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  branchName?: string
  labels: { nodes: { name: string }[] }
  state: { name: string }
}

type FixturePage = {
  data: {
    issues: {
      nodes: FixtureNode[]
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    }
  }
}

type Fixture = {
  page: FixturePage
  lastPage: FixturePage
  graphqlErrors: { errors: { message: string }[]; data: null }
  missingIssues: { data: Record<string, unknown> }
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'tests', 'fixtures', 'linear-issues.json'), 'utf8'),
) as Fixture

const SOURCE = 'linear'

const [todoNode, inProgressNode, backlogNode, blankBranchNode] = fixture.page.data.issues.nodes as [
  FixtureNode,
  FixtureNode,
  FixtureNode,
  FixtureNode,
]

const validNode: Record<string, unknown> = {
  id: 'lin_synthetic_0100',
  identifier: 'TST-100',
  title: 'Synthetic valid ticket',
  description: 'Synthetic description.',
  url: 'https://example.com/tst/issues/TST-100',
  branchName: 'tst-100-synthetic',
  labels: { nodes: [{ name: 'bug' }] },
  state: { name: 'Todo' },
}

const omit = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...record }
  delete copy[key]
  return copy
}

describe('mapIssueToWorkItem', () => {
  it('maps a Todo issue with labels and a branch to a WorkItem', () => {
    expect(mapIssueToWorkItem(todoNode, SOURCE)).toEqual({
      source: SOURCE,
      sourceId: 'lin_synthetic_0001',
      ticketKey: 'TST-1',
      title: 'Synthetic todo ticket',
      body: 'Clicking the synthetic login button does nothing.',
      branch: 'tst-1-synthetic-login-button',
      labels: ['zebra', 'alpha'],
      url: 'https://example.com/tst/issues/TST-1',
      status: 'Todo',
    })
  })

  it('keeps label order from the response instead of sorting', () => {
    const item = mapIssueToWorkItem(todoNode, SOURCE)

    expect(item.labels).toEqual(['zebra', 'alpha'])
  })

  it('sets the branch key only when branchName is a non-empty string', () => {
    const withBranch = mapIssueToWorkItem(todoNode, SOURCE)

    expect('branch' in withBranch).toBe(true)
    expect(withBranch.branch).toBe('tst-1-synthetic-login-button')
  })

  it('maps an In Progress issue with no labels and no branchName key', () => {
    const item = mapIssueToWorkItem(inProgressNode, SOURCE)

    expect(item.status).toBe('In Progress')
    expect(item.labels).toEqual([])
    expect('branch' in item).toBe(false)
    expect(item.body).toBe('Add a synthetic retry to the fake upload job.')
  })

  it('turns a null description into an empty body', () => {
    const item = mapIssueToWorkItem(backlogNode, SOURCE)

    expect(item.body).toBe('')
    expect(item.status).toBe('Backlog')
    expect(item.ticketKey).toBe('TST-3')
  })

  it('leaves the branch key absent for an empty-string branchName', () => {
    const item = mapIssueToWorkItem(blankBranchNode, SOURCE)

    expect('branch' in item).toBe(false)
    expect(item.labels).toEqual(['spike'])
  })

  it('takes the source from the caller', () => {
    expect(mapIssueToWorkItem(validNode, 'linear-dry-run').source).toBe('linear-dry-run')
  })

  const malformedNodes: { field: string; node: unknown }[] = [
    { field: 'id', node: omit(validNode, 'id') },
    { field: 'identifier', node: omit(validNode, 'identifier') },
    { field: 'title', node: omit(validNode, 'title') },
    { field: 'url', node: omit(validNode, 'url') },
    { field: 'state', node: omit(validNode, 'state') },
  ]

  it.each(malformedNodes)('throws LinearMapError naming the missing $field', ({ field, node }) => {
    expect(() => mapIssueToWorkItem(node, SOURCE)).toThrow(LinearMapError)
    expect(() => mapIssueToWorkItem(node, SOURCE)).toThrow(new RegExp(field))
  })

  const invalidNodes: { field: string; node: unknown; pattern: RegExp }[] = [
    { field: 'id', node: { ...validNode, id: 42 }, pattern: /id/ },
    { field: 'url', node: { ...validNode, url: '' }, pattern: /url/ },
    { field: 'state.name', node: { ...validNode, state: {} }, pattern: /state\.name/ },
    { field: 'labels', node: { ...validNode, labels: [] }, pattern: /labels/ },
    {
      field: 'labels.nodes[0].name',
      node: { ...validNode, labels: { nodes: [{ name: '' }] } },
      pattern: /labels\.nodes\[0\]\.name/,
    },
  ]

  it.each(invalidNodes)('throws LinearMapError for an invalid $field', ({ node, pattern }) => {
    expect(() => mapIssueToWorkItem(node, SOURCE)).toThrow(LinearMapError)
    expect(() => mapIssueToWorkItem(node, SOURCE)).toThrow(pattern)
  })

  const nonObjects: unknown[] = [null, undefined, 'TST-1', 42, [], [validNode]]

  it.each(nonObjects.map((value) => [value]))('throws LinearMapError for non-object input %#', (value) => {
    expect(() => mapIssueToWorkItem(value, SOURCE)).toThrow(LinearMapError)
  })
})

describe('parseIssuesPage', () => {
  it('maps every node of a page and keeps the cursor while more pages exist', () => {
    const page = parseIssuesPage(fixture.page, SOURCE)

    expect(page.items.map((item) => item.ticketKey)).toEqual(['TST-1', 'TST-2', 'TST-3', 'TST-4'])
    expect(page.nextCursor).toBe('cursor-page-1')
  })

  it('returns no cursor on the last page', () => {
    const page = parseIssuesPage(fixture.lastPage, SOURCE)

    expect(page.nextCursor).toBeNull()
  })

  it('returns empty items for an empty nodes array', () => {
    expect(parseIssuesPage(fixture.lastPage, SOURCE).items).toEqual([])
  })

  it('ignores the endCursor when hasNextPage is false', () => {
    const page = parseIssuesPage(
      {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: 'stale-cursor' },
          },
        },
      },
      SOURCE,
    )

    expect(page.nextCursor).toBeNull()
  })

  it('returns a null cursor when hasNextPage is true but endCursor is null', () => {
    const page = parseIssuesPage(
      {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      },
      SOURCE,
    )

    expect(page.nextCursor).toBeNull()
  })

  it('accepts an empty errors array', () => {
    const page = parseIssuesPage({ errors: [], ...fixture.lastPage }, SOURCE)

    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('throws LinearMapError on a GraphQL errors array', () => {
    expect(() => parseIssuesPage(fixture.graphqlErrors, SOURCE)).toThrow(LinearMapError)
    expect(() => parseIssuesPage(fixture.graphqlErrors, SOURCE)).toThrow(/Synthetic GraphQL failure/)
  })

  it('throws LinearMapError when data.issues is missing', () => {
    expect(() => parseIssuesPage(fixture.missingIssues, SOURCE)).toThrow(LinearMapError)
    expect(() => parseIssuesPage(fixture.missingIssues, SOURCE)).toThrow(/data\.issues/)
  })

  it('throws LinearMapError when pageInfo is missing', () => {
    expect(() => parseIssuesPage({ data: { issues: { nodes: [] } } }, SOURCE)).toThrow(/pageInfo/)
  })

  it('throws LinearMapError when nodes is not an array', () => {
    expect(() =>
      parseIssuesPage({ data: { issues: { nodes: {}, pageInfo: { hasNextPage: false, endCursor: null } } } }, SOURCE),
    ).toThrow(/nodes/)
  })

  it('throws LinearMapError for non-object input', () => {
    for (const value of [null, undefined, 'json', 7, []]) {
      expect(() => parseIssuesPage(value, SOURCE)).toThrow(LinearMapError)
    }
  })

  it('throws LinearMapError when a node inside the page is malformed', () => {
    expect(() =>
      parseIssuesPage(
        {
          data: {
            issues: {
              nodes: [validNode, omit(validNode, 'title')],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
        SOURCE,
      ),
    ).toThrow(/title/)
  })
})
