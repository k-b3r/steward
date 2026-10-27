import { describe, expect, it } from 'vitest'

import { decideIntake, type IntakeInput } from './intake-policy'
import type { WorkItem } from './types'

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    source: 'linear',
    externalId: 'ext-1',
    identifier: 'TST-1',
    title: 'Synthetic ticket',
    body: 'Synthetic body',
    labels: [],
    url: 'https://example.com/tst/issues/TST-1',
    status: 'Todo',
    ...overrides,
  }
}

function baseInput(overrides: Partial<IntakeInput> = {}): IntakeInput {
  return {
    items: [],
    knownExternalIds: new Set<string>(),
    sourceHasJobs: true,
    openProposals: 0,
    maxOpenProposals: 5,
    maxEnqueuePerPoll: 2,
    ...overrides,
  }
}

describe('decideIntake', () => {
  it('skips items that already have a job, before looking at their status', () => {
    const known = item({ externalId: 'ext-known', status: 'In Progress' })

    const result = decideIntake(
      baseInput({ items: [known], knownExternalIds: new Set([known.externalId]), sourceHasJobs: true }),
    )

    expect(result.decisions).toEqual([])
    expect(result.skipped).toEqual([{ item: known, reason: 'already has a job' }])
  })

  it('proposes Todo items', () => {
    const todo = item({ externalId: 'ext-todo', status: 'Todo' })

    const result = decideIntake(baseInput({ items: [todo] }))

    expect(result.decisions).toEqual([{ item: todo, action: 'propose', reason: 'Todo' }])
    expect(result.skipped).toEqual([])
  })

  it('proposes Backlog items', () => {
    const backlog = item({ externalId: 'ext-backlog', status: 'Backlog' })

    const result = decideIntake(baseInput({ items: [backlog] }))

    expect(result.decisions).toEqual([{ item: backlog, action: 'propose', reason: 'Backlog' }])
    expect(result.skipped).toEqual([])
  })

  it('queues In Progress items after the source has jobs', () => {
    const inProgress = item({ externalId: 'ext-progress', status: 'In Progress' })

    const result = decideIntake(baseInput({ items: [inProgress], sourceHasJobs: true }))

    expect(result.decisions).toEqual([{ item: inProgress, action: 'queue', reason: 'In Progress' }])
    expect(result.skipped).toEqual([])
  })

  it('proposes every In Progress item on the first poll for a source', () => {
    const first = item({ externalId: 'ext-a', identifier: 'TST-1', status: 'In Progress' })
    const second = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'In Progress' })

    const result = decideIntake(baseInput({ items: [first, second], sourceHasJobs: false }))

    expect(result.decisions).toEqual([
      { item: first, action: 'propose', reason: 'baseline' },
      { item: second, action: 'propose', reason: 'baseline' },
    ])
    expect(result.skipped).toEqual([])
  })

  it('proposes all new In Progress items when the poll would exceed the enqueue cap', () => {
    const first = item({ externalId: 'ext-a', identifier: 'TST-1', status: 'In Progress' })
    const second = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'In Progress' })
    const third = item({ externalId: 'ext-c', identifier: 'TST-3', status: 'In Progress' })

    const result = decideIntake(baseInput({ items: [first, second, third], sourceHasJobs: true, maxEnqueuePerPoll: 2 }))

    expect(result.decisions.map((decision) => decision.action)).toEqual(['propose', 'propose', 'propose'])
    expect(result.decisions.map((decision) => decision.reason)).toEqual([
      'burst over cap',
      'burst over cap',
      'burst over cap',
    ])
  })

  it('queues In Progress items exactly at the enqueue cap', () => {
    const first = item({ externalId: 'ext-a', identifier: 'TST-1', status: 'In Progress' })
    const second = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'In Progress' })

    const result = decideIntake(baseInput({ items: [first, second], sourceHasJobs: true, maxEnqueuePerPoll: 2 }))

    expect(result.decisions).toEqual([
      { item: first, action: 'queue', reason: 'In Progress' },
      { item: second, action: 'queue', reason: 'In Progress' },
    ])
  })

  it('proposes new In Progress items when the enqueue cap is zero', () => {
    const inProgress = item({ externalId: 'ext-a', status: 'In Progress' })

    const result = decideIntake(baseInput({ items: [inProgress], sourceHasJobs: true, maxEnqueuePerPoll: 0 }))

    expect(result.decisions).toEqual([{ item: inProgress, action: 'propose', reason: 'burst over cap' }])
  })

  it('does not count items that already have a job toward the enqueue cap', () => {
    const known = item({ externalId: 'ext-known', status: 'In Progress' })
    const first = item({ externalId: 'ext-a', identifier: 'TST-1', status: 'In Progress' })
    const second = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'In Progress' })

    const result = decideIntake(
      baseInput({
        items: [known, first, second],
        knownExternalIds: new Set([known.externalId]),
        sourceHasJobs: true,
        maxEnqueuePerPoll: 2,
      }),
    )

    expect(result.decisions).toEqual([
      { item: first, action: 'queue', reason: 'In Progress' },
      { item: second, action: 'queue', reason: 'In Progress' },
    ])
    expect(result.skipped).toEqual([{ item: known, reason: 'already has a job' }])
  })

  it('skips proposals once open proposals reach the cap, mid-list', () => {
    const first = item({ externalId: 'ext-a', identifier: 'TST-1', status: 'Todo' })
    const second = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'Todo' })
    const third = item({ externalId: 'ext-c', identifier: 'TST-3', status: 'Todo' })

    const result = decideIntake(baseInput({ items: [first, second, third], openProposals: 1, maxOpenProposals: 2 }))

    expect(result.decisions).toEqual([{ item: first, action: 'propose', reason: 'Todo' }])
    expect(result.skipped).toEqual([
      { item: second, reason: 'proposal limit' },
      { item: third, reason: 'proposal limit' },
    ])
  })

  it('skips every proposal when the open proposal cap is zero', () => {
    const todo = item({ externalId: 'ext-a', status: 'Todo' })
    const backlog = item({ externalId: 'ext-b', status: 'Backlog' })

    const result = decideIntake(baseInput({ items: [todo, backlog], maxOpenProposals: 0 }))

    expect(result.decisions).toEqual([])
    expect(result.skipped).toEqual([
      { item: todo, reason: 'proposal limit' },
      { item: backlog, reason: 'proposal limit' },
    ])
  })

  it('counts baseline proposals against the open proposal cap', () => {
    const inProgress = item({ externalId: 'ext-a', status: 'In Progress' })
    const todo = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'Todo' })

    const result = decideIntake(
      baseInput({
        items: [inProgress, todo],
        sourceHasJobs: false,
        openProposals: 0,
        maxOpenProposals: 1,
      }),
    )

    expect(result.decisions).toEqual([{ item: inProgress, action: 'propose', reason: 'baseline' }])
    expect(result.skipped).toEqual([{ item: todo, reason: 'proposal limit' }])
  })

  it('counts burst proposals against the open proposal cap', () => {
    const first = item({ externalId: 'ext-a', identifier: 'TST-1', status: 'In Progress' })
    const second = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'In Progress' })

    const result = decideIntake(
      baseInput({
        items: [first, second],
        sourceHasJobs: true,
        maxEnqueuePerPoll: 1,
        openProposals: 0,
        maxOpenProposals: 1,
      }),
    )

    expect(result.decisions).toEqual([{ item: first, action: 'propose', reason: 'burst over cap' }])
    expect(result.skipped).toEqual([{ item: second, reason: 'proposal limit' }])
  })

  it('still queues In Progress items when the proposal cap is already reached', () => {
    const todo = item({ externalId: 'ext-a', status: 'Todo' })
    const inProgress = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'In Progress' })

    const result = decideIntake(
      baseInput({ items: [todo, inProgress], openProposals: 2, maxOpenProposals: 2, sourceHasJobs: true }),
    )

    expect(result.decisions).toEqual([{ item: inProgress, action: 'queue', reason: 'In Progress' }])
    expect(result.skipped).toEqual([{ item: todo, reason: 'proposal limit' }])
  })

  it('skips statuses that are not part of intake', () => {
    const done = item({ externalId: 'ext-done', status: 'Done' })
    const unknown = item({ externalId: 'ext-unknown', identifier: 'TST-2', status: 'Triage' })

    const result = decideIntake(baseInput({ items: [done, unknown] }))

    expect(result.decisions).toEqual([])
    expect(result.skipped).toEqual([
      { item: done, reason: 'unknown status' },
      { item: unknown, reason: 'unknown status' },
    ])
  })

  it('preserves input order in both output lists', () => {
    const todo = item({ externalId: 'ext-a', status: 'Todo' })
    const done = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'Done' })
    const backlog = item({ externalId: 'ext-c', identifier: 'TST-3', status: 'Backlog' })
    const inProgress = item({ externalId: 'ext-d', identifier: 'TST-4', status: 'In Progress' })

    const result = decideIntake(
      baseInput({ items: [todo, done, backlog, inProgress], sourceHasJobs: true, maxEnqueuePerPoll: 1 }),
    )

    expect(result.decisions.map((decision) => decision.item.externalId)).toEqual(['ext-a', 'ext-c', 'ext-d'])
    expect(result.skipped.map((skip) => skip.item.externalId)).toEqual(['ext-b'])
  })

  it('returns empty lists for no items', () => {
    expect(decideIntake(baseInput())).toEqual({ decisions: [], skipped: [] })
  })
})
