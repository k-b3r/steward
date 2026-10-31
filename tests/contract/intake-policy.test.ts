import { decideIntake, type IntakeInput, type IntakeResult } from '../../src/intake-policy'
import type { WorkItem } from '../../src/types'

const workItem = (sourceId: string, status: string): WorkItem => ({
  source: 'linear',
  sourceId,
  ticketKey: `TST-${sourceId}`,
  title: `Synthetic ticket ${sourceId}`,
  body: 'A synthetic body.',
  labels: ['synthetic'],
  url: `https://linear.example/issue/TST-${sourceId}`,
  status,
})

// A poll in steady state: the source already has jobs (so it is not the baseline), no proposal is open, nothing in
// the feed is known yet, and both caps are far above what these tests produce.
const steadyPoll = (items: WorkItem[]): IntakeInput => ({
  items,
  knownSourceIds: new Set<string>(),
  sourceHasJobs: true,
  openProposals: 0,
  maxOpenProposals: 20,
  maxEnqueuePerPoll: 5,
})

// `reason` is a log tag "free to change", so only the item and the action of each decision are looked at.
const actionsBySourceId = (result: IntakeResult): Array<[string, string]> =>
  result.decisions.map((decision) => [decision.item.sourceId, decision.action])

describe('decideIntake', () => {
  const statusCases = [
    { status: 'In Progress', action: 'queue' },
    { status: 'Todo', action: 'propose' },
    { status: 'Backlog', action: 'propose' },
  ]

  it.each(statusCases)('decides to $action a $status item', ({ status, action }) => {
    const result = decideIntake(steadyPoll([workItem('1', status)]))

    expect(actionsBySourceId(result)).toEqual([['1', action]])
  })

  it('returns the decided item unchanged', () => {
    const item = workItem('1', 'Todo')
    const before = structuredClone(item)

    const result = decideIntake(steadyPoll([item]))

    expect(result.decisions.map((decision) => decision.item)).toEqual([before])
  })

  it('decides each item of a mixed poll by its own status, in feed order', () => {
    const items = [workItem('1', 'Todo'), workItem('2', 'In Progress'), workItem('3', 'Backlog')]

    const result = decideIntake(steadyPoll(items))

    expect(actionsBySourceId(result)).toEqual([
      ['1', 'propose'],
      ['2', 'queue'],
      ['3', 'propose'],
    ])
  })
})
