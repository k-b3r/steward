import { nextPollDelayMs, runIntakePoll, type IntakeDeps, type IntakeStore } from '../../src/intake'
import type { Db } from '../../src/platform/db'
import type { Logger } from '../../src/platform/logger'
import type { Job, WorkFeed, WorkItem } from '../../src/types'

type InsertInput = Parameters<IntakeStore['insertJob']>[1]

const POLL_TIME = new Date('2025-03-01T09:30:00.000Z')

// Not the default of 3, so a value copied from the config cannot be mistaken for a built-in one.
const MAX_ATTEMPTS = 5

// `Db` is a real drizzle handle that nothing in the suite fakes. The poll only hands it to the store, so a marker
// object stands in for it.
const DB = { marker: 'in-memory db handle' } as unknown as Db

const workItem = (sourceId: string, ticketKey: string, status: string): WorkItem => ({
  source: 'linear',
  sourceId,
  ticketKey,
  title: `Synthetic ticket ${ticketKey}`,
  body: 'A synthetic body.',
  labels: [],
  url: `https://linear.example/issue/${ticketKey}`,
  status,
})

const IN_PROGRESS = workItem('issue-1', 'TST-1', 'In Progress')
const TODO = workItem('issue-2', 'TST-2', 'Todo')

// A job from an earlier poll. With it in the store the source already has a job, so the poll under test is not the
// baseline poll of that source. It is `done`, so it is neither an open proposal nor in the feed.
const EARLIER_JOB: Job = {
  id: 'job-earlier',
  source: 'linear',
  sourceId: 'issue-0',
  ticketKey: 'TST-0',
  state: 'done',
  attempt: 1,
  maxAttempts: 3,
  slot: null,
  nextRunAt: null,
  failureKind: null,
}

// In-memory stand-ins for everything `IntakeDeps` asks for, plus the records the tests read back.
const createHarness = (options: { items: WorkItem[]; dryRun: boolean }) => {
  const jobs: Job[] = [{ ...EARLIER_JOB }]
  const inserts: InsertInput[] = []
  const dbHandles: Db[] = []
  const enqueued: string[] = []
  const infoLines: string[] = []
  const feedState = { polls: 0, drained: false }

  const store: IntakeStore = {
    insertJob: (db, input) => {
      dbHandles.push(db)
      inserts.push(input)
      const existing = jobs.find((job) => job.source === input.item.source && job.sourceId === input.item.sourceId)
      if (existing) return Promise.resolve({ job: existing, created: false })
      const job: Job = {
        id: `job-${jobs.length}`,
        source: input.item.source,
        sourceId: input.item.sourceId,
        ticketKey: input.item.ticketKey,
        state: input.state,
        attempt: 0,
        maxAttempts: input.maxAttempts,
        slot: null,
        nextRunAt: null,
        failureKind: null,
      }
      jobs.push(job)
      return Promise.resolve({ job, created: true })
    },
    knownSourceIds: (db, source) => {
      dbHandles.push(db)
      return Promise.resolve(new Set(jobs.filter((job) => job.source === source).map((job) => job.sourceId)))
    },
    countJobsForSource: (db, source) => {
      dbHandles.push(db)
      return Promise.resolve(jobs.filter((job) => job.source === source).length)
    },
    countOpenProposals: (db) => {
      dbHandles.push(db)
      return Promise.resolve(jobs.filter((job) => job.state === 'proposed').length)
    },
  }

  // `drained` flips only when the consumer asks for the item after the last one, so it proves a full drain.
  const feed: WorkFeed = {
    poll: () => {
      feedState.polls += 1
      return (async function* () {
        yield* options.items
        feedState.drained = true
      })()
    },
  }

  const logger: Logger = {
    info: (msg) => {
      infoLines.push(msg)
    },
    warn: () => undefined,
    error: () => undefined,
  }

  const queue: IntakeDeps['queue'] = {
    enqueue: (jobId) => {
      enqueued.push(jobId)
      return Promise.resolve()
    },
  }

  const deps: IntakeDeps = {
    feed,
    db: DB,
    logger,
    queue,
    config: { dryRun: options.dryRun, maxEnqueuePerPoll: 2, maxOpenProposals: 20, maxAttempts: MAX_ATTEMPTS },
    now: POLL_TIME,
    store,
  }

  return { deps, jobs, inserts, dbHandles, enqueued, infoLines, feedState }
}

// One poll over a feed with one new In Progress ticket and one new Todo ticket.
const pollTwoNewTickets = async (dryRun: boolean) => {
  const harness = createHarness({ items: [IN_PROGRESS, TODO], dryRun })
  const counts = await runIntakePoll(harness.deps)
  return { ...harness, counts }
}

const jobForIssue = (jobs: Job[], sourceId: string): Job | undefined => jobs.find((job) => job.sourceId === sourceId)

describe('runIntakePoll with dry run off', () => {
  it('creates a queued job for an In Progress ticket', async () => {
    const { jobs } = await pollTwoNewTickets(false)

    expect(jobForIssue(jobs, 'issue-1')?.state).toBe('queued')
  })

  it('creates a proposed job for a Todo ticket', async () => {
    const { jobs } = await pollTwoNewTickets(false)

    expect(jobForIssue(jobs, 'issue-2')?.state).toBe('proposed')
  })

  it('enqueues the new queued job once, by its job id', async () => {
    const { jobs, enqueued } = await pollTwoNewTickets(false)

    expect(enqueued).toEqual([jobForIssue(jobs, 'issue-1')?.id])
  })

  it('does not enqueue the new proposal', async () => {
    const { jobs, enqueued } = await pollTwoNewTickets(false)
    const proposal = jobForIssue(jobs, 'issue-2')

    expect(proposal).toBeDefined()
    expect(enqueued).not.toContain(proposal?.id)
  })

  it('counts one queued job, one proposal and no skips', async () => {
    const { counts } = await pollTwoNewTickets(false)

    expect(counts).toEqual({ queued: 1, proposed: 1, skipped: 0 })
  })

  it('hands each new job to the store with the item the feed produced', async () => {
    const { inserts } = await pollTwoNewTickets(false)

    expect(inserts).toHaveLength(2)
    expect(inserts.map((input) => input.item)).toEqual(expect.arrayContaining([IN_PROGRESS, TODO]))
  })

  it('copies maxAttempts from the config into every new job', async () => {
    const { inserts } = await pollTwoNewTickets(false)

    expect(inserts.map((input) => input.maxAttempts)).toEqual([MAX_ATTEMPTS, MAX_ATTEMPTS])
  })

  it('gives every new job the clock reading of the poll', async () => {
    const { inserts } = await pollTwoNewTickets(false)

    expect(inserts.map((input) => input.now)).toEqual([POLL_TIME, POLL_TIME])
  })

  it('passes the db handle unchanged to every store call', async () => {
    const { dbHandles } = await pollTwoNewTickets(false)

    expect(dbHandles.length).toBeGreaterThan(0)
    expect(dbHandles.every((handle) => handle === DB)).toBe(true)
  })

  it('polls the feed once', async () => {
    const { feedState } = await pollTwoNewTickets(false)

    expect(feedState.polls).toBe(1)
  })

  it('drains the feed completely', async () => {
    const { feedState } = await pollTwoNewTickets(false)

    expect(feedState.drained).toBe(true)
  })

  it('logs one info line per decision plus a finished line', async () => {
    const { infoLines } = await pollTwoNewTickets(false)

    expect(infoLines).toHaveLength(3)
  })
})

describe('runIntakePoll in a dry run', () => {
  it('inserts no job', async () => {
    const { inserts } = await pollTwoNewTickets(true)

    expect(inserts).toHaveLength(0)
  })

  it('enqueues nothing', async () => {
    const { enqueued } = await pollTwoNewTickets(true)

    expect(enqueued).toEqual([])
  })

  it('counts what it would have created', async () => {
    const { counts } = await pollTwoNewTickets(true)

    expect(counts).toEqual({ queued: 1, proposed: 1, skipped: 0 })
  })

  it('logs one info line per decision plus a finished line', async () => {
    const { infoLines } = await pollTwoNewTickets(true)

    expect(infoLines).toHaveLength(3)
  })
})

describe('nextPollDelayMs', () => {
  const INTERVAL_MS = 30_000
  const RAND_SAMPLES = [0, 0.25, 0.5, 0.75, 0.999]
  // The documents say "up to ±10% jitter" without saying how `rand` maps onto it, so only the band is checked,
  // with a millisecond of slack in case the delay is rounded.
  const ROUNDING_SLACK_MS = 1

  const expectWithinTenPercentOf = (delayMs: number, centreMs: number): void => {
    expect(delayMs).toBeGreaterThanOrEqual(centreMs * 0.9 - ROUNDING_SLACK_MS)
    expect(delayMs).toBeLessThanOrEqual(centreMs * 1.1 + ROUNDING_SLACK_MS)
  }

  it.each(RAND_SAMPLES)('stays within 10 percent of the interval with no failures (rand %s)', (rand) => {
    expectWithinTenPercentOf(nextPollDelayMs(INTERVAL_MS, rand, 0), INTERVAL_MS)
  })

  const doublingCases = [
    { failures: 1, factor: 2 },
    { failures: 2, factor: 4 },
    { failures: 3, factor: 8 },
  ]

  it.each(doublingCases)('doubles once per failure: $failures failures give $factor times the interval', (testCase) => {
    for (const rand of RAND_SAMPLES) {
      expectWithinTenPercentOf(nextPollDelayMs(INTERVAL_MS, rand, testCase.failures), INTERVAL_MS * testCase.factor)
    }
  })
})
