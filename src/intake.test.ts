import { describe, expect, it } from 'vitest'

import { nextPollDelayMs, runIntakePoll, type IntakeDeps, type IntakeStore } from './intake'
import type { Db } from './platform/db'
import { createLogger } from './platform/logger'
import type { Job, WorkFeed, WorkItem } from './types'

const NOW = new Date('2026-10-27T12:00:00.000Z')
const CLOCK = NOW

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

function feedOf(items: WorkItem[]): WorkFeed {
  return {
    async *poll(): AsyncIterable<WorkItem> {
      for (const item of items) {
        yield item
      }
    },
  }
}

type InsertInput = { item: WorkItem; state: 'proposed' | 'queued'; maxAttempts: number; now: Date }

type FakeStore = {
  store: IntakeStore
  inserts: InsertInput[]
  knownCalls: { source: string }[]
  sourceJobCalls: { source: string }[]
}

function fakeStore(
  options: {
    known?: string[]
    jobsForSource?: number
    openProposals?: number
    duplicates?: string[]
  } = {},
): FakeStore {
  const inserts: InsertInput[] = []
  const knownCalls: { source: string }[] = []
  const sourceJobCalls: { source: string }[] = []
  const duplicates = new Set(options.duplicates ?? [])
  let sequence = 0

  const store: IntakeStore = {
    async insertJob(_db, input) {
      inserts.push(input)
      sequence += 1
      const created = !duplicates.has(input.item.externalId)
      const job: Job = {
        id: created ? `job-${String(sequence)}` : `existing-${input.item.externalId}`,
        source: input.item.source,
        externalId: input.item.externalId,
        identifier: input.item.identifier,
        state: input.state,
        attempt: 0,
        maxAttempts: input.maxAttempts,
        slot: null,
        nextRunAt: null,
        failureKind: null,
      }
      return { job, created }
    },
    async knownExternalIds(_db, source) {
      knownCalls.push({ source })
      return new Set(options.known ?? [])
    },
    async countJobsForSource(_db, source) {
      sourceJobCalls.push({ source })
      return options.jobsForSource ?? 1
    },
    async countOpenProposals() {
      return options.openProposals ?? 0
    },
  }

  return { store, inserts, knownCalls, sourceJobCalls }
}

function fakeQueue() {
  const enqueued: string[] = []
  return {
    enqueued,
    queue: {
      async enqueue(jobId: string): Promise<void> {
        enqueued.push(jobId)
      },
    },
  }
}

function captureLogger() {
  const lines: string[] = []
  const logger = createLogger({ write: (line) => lines.push(line), clock: () => CLOCK })
  return { logger, lines }
}

function depsFor(input: {
  items: WorkItem[]
  store: IntakeStore
  dryRun?: boolean
  maxEnqueuePerPoll?: number
  maxOpenProposals?: number
  maxAttempts?: number
}): { deps: IntakeDeps; queue: ReturnType<typeof fakeQueue>; lines: string[] } {
  const queue = fakeQueue()
  const capture = captureLogger()
  const deps: IntakeDeps = {
    feed: feedOf(input.items),
    db: {} as unknown as Db,
    logger: capture.logger,
    queue: queue.queue,
    config: {
      dryRun: input.dryRun ?? false,
      maxEnqueuePerPoll: input.maxEnqueuePerPoll ?? 2,
      maxOpenProposals: input.maxOpenProposals ?? 20,
      maxAttempts: input.maxAttempts ?? 3,
    },
    now: NOW,
    store: input.store,
  }
  return { deps, queue, lines: capture.lines }
}

function parsedLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('runIntakePoll', () => {
  it('inserts queued and proposed jobs and enqueues only newly created queued jobs', async () => {
    const inProgress = item({ externalId: 'ext-a', identifier: 'TST-1', status: 'In Progress' })
    const todo = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'Todo' })
    const backlog = item({ externalId: 'ext-c', identifier: 'TST-3', status: 'Backlog' })
    const done = item({ externalId: 'ext-d', identifier: 'TST-4', status: 'Done' })
    const fake = fakeStore({ jobsForSource: 1 })
    const { deps, queue } = depsFor({
      items: [inProgress, todo, backlog, done],
      store: fake.store,
      maxAttempts: 5,
    })

    const result = await runIntakePoll(deps)

    expect(result).toEqual({ queued: 1, proposed: 2, skipped: 1 })
    expect(fake.inserts.map((insert) => insert.state)).toEqual(['queued', 'proposed', 'proposed'])
    expect(fake.inserts.every((insert) => insert.maxAttempts === 5)).toBe(true)
    expect(fake.inserts.every((insert) => insert.now === NOW)).toBe(true)
    expect(queue.enqueued).toEqual(['job-1'])
  })

  it('queries the store for the feed source and passes the policy inputs through', async () => {
    const todo = item({ externalId: 'ext-a', status: 'Todo' })
    const inProgress = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'In Progress' })
    const fake = fakeStore({ known: ['ext-known'], jobsForSource: 1, openProposals: 2 })
    const { deps } = depsFor({
      items: [todo, inProgress],
      store: fake.store,
      maxEnqueuePerPoll: 1,
      maxOpenProposals: 2,
    })

    const result = await runIntakePoll(deps)

    expect(fake.knownCalls).toEqual([{ source: 'linear' }])
    expect(fake.sourceJobCalls).toEqual([{ source: 'linear' }])
    expect(result).toEqual({ queued: 1, proposed: 0, skipped: 1 })
    expect(fake.inserts.map((insert) => insert.state)).toEqual(['queued'])
  })

  it('proposes In Progress items on the first poll for a source', async () => {
    const inProgress = item({ externalId: 'ext-a', status: 'In Progress' })
    const fake = fakeStore({ jobsForSource: 0 })
    const { deps, queue } = depsFor({ items: [inProgress], store: fake.store })

    const result = await runIntakePoll(deps)

    expect(result).toEqual({ queued: 0, proposed: 1, skipped: 0 })
    expect(fake.inserts[0]?.state).toBe('proposed')
    expect(queue.enqueued).toEqual([])
  })

  it('creates nothing in dry-run mode and logs decisions and counts', async () => {
    const inProgress = item({ externalId: 'ext-a', status: 'In Progress' })
    const todo = item({ externalId: 'ext-b', identifier: 'TST-2', status: 'Todo' })
    const done = item({ externalId: 'ext-c', identifier: 'TST-3', status: 'Done' })
    const fake = fakeStore({ jobsForSource: 1 })
    const { deps, queue, lines } = depsFor({ items: [inProgress, todo, done], store: fake.store, dryRun: true })

    const result = await runIntakePoll(deps)

    expect(result).toEqual({ queued: 1, proposed: 1, skipped: 1 })
    expect(fake.inserts).toEqual([])
    expect(queue.enqueued).toEqual([])
    const parsed = parsedLines(lines)
    const decisions = parsed.filter((line) => line.msg === 'Intake decision')
    expect(decisions.map((line) => line.action)).toEqual(['queue', 'propose'])
    expect(parsed.filter((line) => line.msg === 'Intake skipped')).toHaveLength(1)
    expect(parsed.find((line) => line.msg === 'Intake poll finished')).toMatchObject({
      dryRun: true,
      queued: 1,
      proposed: 1,
      skipped: 1,
    })
  })

  it('does not enqueue a duplicate that another poll inserted first', async () => {
    const inProgress = item({ externalId: 'ext-a', status: 'In Progress' })
    const fake = fakeStore({ jobsForSource: 2, duplicates: ['ext-a'] })
    const { deps, queue } = depsFor({ items: [inProgress], store: fake.store })

    const result = await runIntakePoll(deps)

    expect(result).toEqual({ queued: 0, proposed: 0, skipped: 1 })
    expect(fake.inserts).toHaveLength(1)
    expect(queue.enqueued).toEqual([])
  })

  it('returns zeros and makes no store calls for an empty feed', async () => {
    const fake = fakeStore()
    const { deps, lines } = depsFor({ items: [], store: fake.store })

    const result = await runIntakePoll(deps)

    expect(result).toEqual({ queued: 0, proposed: 0, skipped: 0 })
    expect(fake.knownCalls).toEqual([])
    expect(fake.sourceJobCalls).toEqual([])
    expect(parsedLines(lines).find((line) => line.msg === 'Intake poll finished')).toMatchObject({
      queued: 0,
      proposed: 0,
      skipped: 0,
    })
  })
})

describe('nextPollDelayMs', () => {
  const INTERVAL = 30_000
  const TEN_MINUTES = 10 * 60_000

  it('returns the interval with no jitter at rand 0.5', () => {
    expect(nextPollDelayMs(INTERVAL, 0.5, 0)).toBe(INTERVAL)
  })

  it('applies up to ten percent jitter either way', () => {
    expect(nextPollDelayMs(INTERVAL, 0, 0)).toBe(27_000)
    expect(nextPollDelayMs(INTERVAL, 0.999999, 0)).toBe(33_000)
    expect(nextPollDelayMs(INTERVAL, 0.25, 0)).toBe(28_500)
    expect(nextPollDelayMs(INTERVAL, 0.75, 0)).toBe(31_500)
  })

  it('backs off exponentially after consecutive failures', () => {
    expect(nextPollDelayMs(INTERVAL, 0.5, 1)).toBe(60_000)
    expect(nextPollDelayMs(INTERVAL, 0.5, 2)).toBe(120_000)
    expect(nextPollDelayMs(INTERVAL, 0.5, 3)).toBe(240_000)
    expect(nextPollDelayMs(INTERVAL, 0.5, 4)).toBe(480_000)
  })

  it('caps the delay at ten minutes', () => {
    expect(nextPollDelayMs(INTERVAL, 0.5, 5)).toBe(TEN_MINUTES)
    expect(nextPollDelayMs(INTERVAL, 0.5, 50)).toBe(TEN_MINUTES)
    expect(nextPollDelayMs(INTERVAL, 0.999999, 50)).toBe(TEN_MINUTES)
  })

  it('rounds to whole milliseconds', () => {
    const delay = nextPollDelayMs(1000, 0.123456, 0)
    expect(Number.isInteger(delay)).toBe(true)
  })

  it('rejects invalid inputs', () => {
    expect(() => nextPollDelayMs(0, 0.5, 0)).toThrow(RangeError)
    expect(() => nextPollDelayMs(-1, 0.5, 0)).toThrow(RangeError)
    expect(() => nextPollDelayMs(INTERVAL, -0.1, 0)).toThrow(RangeError)
    expect(() => nextPollDelayMs(INTERVAL, 1, 0)).toThrow(RangeError)
    expect(() => nextPollDelayMs(INTERVAL, 0.5, -1)).toThrow(RangeError)
    expect(() => nextPollDelayMs(INTERVAL, 0.5, 1.5)).toThrow(RangeError)
  })
})
