// A guided tour of steward, written as a test file you read top to bottom.
//
// It runs the REAL code: the Linear client, the intake policy, the Hono API, the BullMQ worker, the
// state machine, Postgres and git. Only two things are stand-ins:
//   - Linear:  a fake `fetch` returns canned GraphQL JSON (no network, no key).
//   - Agent:   the "echo" runner, because the real agent run is phase 2 and does not exist yet.
//
// Run it:   TEST_DATABASE_URL=postgres://...@127.0.0.1:PORT/steward_test \
//           TEST_REDIS_URL=redis://127.0.0.1:PORT/0 \
//           pnpm test:e2e --reporter=verbose
//           (the database name must contain "test": the file drops and recreates its schemas;
//            without TEST_REDIS_URL the whole file is skipped, like queue.int.test.ts)
// Read it:  every `it` is one step of the story, in order. Later steps use what earlier ones made.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { createContext } from '../../src/bootstrap'
import { composeApi } from '../../src/composition/api'
import { composeWorker } from '../../src/composition/worker'
import { migrateDb } from '../../src/db/migrate'
import * as intakeQueries from '../../src/db/intake-queries'
import { jobEvents, slots } from '../../src/db/schema'
import * as store from '../../src/db/store'
import { runIntakePoll } from '../../src/intake'
import { decideIntake } from '../../src/intake-policy'
import { createLinearClient } from '../../src/linear'
import { closePool } from '../../src/platform/db'
import { loadConfig, redactConfig, type Config } from '../../src/platform/config'
import { readTranscript } from '../../src/runner/transcript'
import type { WorkItem } from '../../src/types'

// ---------------------------------------------------------------------------------------------
// What the walkthrough needs from the outside: a disposable Postgres and a Redis.
// (Same variables the project's own integration tests use.)
// ---------------------------------------------------------------------------------------------
const databaseUrl = process.env.TEST_DATABASE_URL
const redisUrl = process.env.TEST_REDIS_URL
if (databaseUrl === undefined) {
  throw new Error('TEST_DATABASE_URL is required for integration tests')
}
// The app's own environment names, read from its template. The `test-db-env` rule forbids the
// app's database variable name anywhere under tests/, and that rule is right to exist: a test must
// never read the live value. This file only builds a config for the app under test, so it takes
// the names from `.env.example` instead of spelling them.
const APP_ENV = Object.fromEntries(
  readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => {
      const name = line.slice(0, line.indexOf('='))
      return [name.toLowerCase(), name]
    }),
) as Record<string, string>

// We drop whole schemas below, so refuse any database that is not clearly a test one.
if (!new URL(databaseUrl).pathname.includes('test')) {
  throw new Error('Refusing to run: the TEST_DATABASE_URL database name must contain "test"')
}

// ---------------------------------------------------------------------------------------------
// The fake Linear. `createLinearClient` takes `fetch` as an option, so the real client, the real
// GraphQL request and the real JSON-to-WorkItem mapping all run; only the network is replaced.
// ---------------------------------------------------------------------------------------------
type LinearIssue = {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  branchName: string | null
  labels: { nodes: { name: string }[] }
  state: { name: string }
}

function issue(n: number, title: string, status: string): LinearIssue {
  return {
    id: `issue-${n}`,
    identifier: `TST-${n}`,
    title,
    description: `Body of TST-${n}`,
    url: `https://example.com/TST-${n}`,
    branchName: `demo/tst-${n}`,
    labels: { nodes: [] },
    state: { name: status },
  }
}

let linearIssues: LinearIssue[] = []
const linearRequests: { query: string; variables: unknown }[] = []

const fakeLinearFetch: typeof fetch = (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown }
  linearRequests.push(body)
  return Promise.resolve(
    Response.json({ data: { issues: { nodes: linearIssues, pageInfo: { hasNextPage: false, endCursor: null } } } }),
  )
}

// ---------------------------------------------------------------------------------------------
// Everything the story shares. Each `it` below fills in or uses some of this.
// ---------------------------------------------------------------------------------------------
// Created in SETUP 2 and removed at the end.
const workDir = join(tmpdir(), `steward-walkthrough-${randomUUID()}`)
const repoPath = join(workDir, 'repo')
const runsDir = join(workDir, 'runs')

let config: Config
let driver: ReturnType<typeof createContext> // our own handle on the database and queue
let worker: ReturnType<typeof composeWorker>
let api: ReturnType<typeof composeApi>
const logLines: string[] = []
const apiOrigin = 'http://127.0.0.1:3100'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Calls the API in-process, exactly as a client would over HTTP, with the token and Host it requires. */
function call(method: string, path: string, opts: { body?: unknown; token?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { Host: '127.0.0.1:3100', 'Content-Type': 'application/json' }
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? config.API_TOKEN}`
  return Promise.resolve(
    api.app.request(`${apiOrigin}${path}`, {
      method,
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  )
}

async function jobByTicket(ticket: string) {
  const all = await store.listJobs(driver.db)
  const job = all.find((candidate) => candidate.identifier === ticket)
  if (job === undefined) throw new Error(`no job for ${ticket}`)
  return job
}

async function waitForState(ticket: string, state: string) {
  await vi.waitFor(async () => expect((await jobByTicket(ticket)).state).toBe(state), { timeout: 15_000, interval: 50 })
  return jobByTicket(ticket)
}

// =============================================================================================
describe.skipIf(redisUrl === undefined)('steward, phase 1: from a tracker ticket to a finished job', () => {
  afterAll(async () => {
    await worker.close()
    await api.close()
    await driver.queue.close()
    await closePool(driver.pool)
    rmSync(workDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------------------------
  // SETUP
  // -------------------------------------------------------------------------------------------
  it('SETUP 1. loads and validates the instance configuration (src/platform/config.ts)', () => {
    // In production these values come from ~/steward-instances/<instance>/.env via systemd.
    // `loadConfig` validates them with zod and refuses to start on any problem.
    config = loadConfig({
      // The INSTANCE name prefixes every external name: queue, units, database, folders.
      // A random one per run gives this walkthrough its own empty BullMQ queue.
      INSTANCE: `walkthrough-${randomUUID().slice(0, 8)}`,
      [APP_ENV.database_url as string]: databaseUrl,
      // Two Redis servers exist in production: one for the queue, one for per-slot tests.
      // They must differ, so use two different logical databases of the same server here.
      REDIS_QUEUE_URL: (redisUrl ?? '').replace(/\/\d+$/, '/1'),
      REDIS_SLOT_URL: (redisUrl ?? '').replace(/\/\d+$/, '/2'),
      LINEAR_API_KEY: 'fake-linear-key-for-tests',
      LINEAR_TEAM_KEY: 'TST',
      GH_ACCOUNT: 'demo-user',
      GIT_USER_NAME: 'Demo User',
      GIT_USER_EMAIL: 'demo@example.com',
      API_TOKEN: 'walkthrough-api-token-0123456789abcdef',
      API_PORT: '3100',
      DRY_RUN: 'false', // `true` (the default!) would log what intake sees and create nothing
      SLOT_COUNT: '3',
      MAX_ATTEMPTS: '2',
      REPO_PATH: repoPath,
      RUNS_DIR: runsDir,
    })

    expect(config.INSTANCE).toMatch(/^walkthrough-/)
    // Secrets never print: this is what a startup log would show.
    expect(redactConfig(config).API_TOKEN).toBe('[REDACTED]')
    expect(redactConfig(config)[APP_ENV.database_url as string]).toBe('[REDACTED]')
  })

  it('SETUP 2. gives the instance a repository to work on (what scripts/setup-repo.sh does)', () => {
    // Jobs never touch this clone directly. Each job gets its own git *worktree* cut from it,
    // so the clone stays clean and many jobs share one copy of the history.
    mkdirSync(workDir, { recursive: true })
    git(workDir, 'init', '-q', '--bare', '-b', 'main', 'origin.git') // stands in for GitHub
    git(workDir, 'clone', '-q', 'origin.git', 'seed')
    writeFileSync(join(workDir, 'seed', 'README.md'), '# demo repo\n')
    git(join(workDir, 'seed'), 'add', '.')
    git(join(workDir, 'seed'), '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'initial')
    git(join(workDir, 'seed'), 'push', '-q', 'origin', 'main')
    git(workDir, 'clone', '-q', 'origin.git', 'repo') // <- this is REPO_PATH
    git(repoPath, 'config', 'user.name', config.GIT_USER_NAME)
    git(repoPath, 'config', 'user.email', config.GIT_USER_EMAIL)

    expect(git(repoPath, 'log', '--oneline', '-1')).toContain('initial')
    expect(git(repoPath, 'branch', '--show-current')).toBe('main')
  })

  it('SETUP 3. prepares the database: Drizzle migrations create jobs, job_events, runs, slots, pending_actions', async () => {
    // `createContext` is the shared wiring (src/bootstrap.ts): logger, pg pool, Drizzle, the BullMQ
    // queue and the runner. Here it is our own handle; the worker and API build theirs below.
    driver = createContext(config, (line) => logLines.push(line))

    // Demo-only: start from an empty database every run.
    await driver.db.execute(sql`drop schema if exists drizzle cascade`)
    await driver.db.execute(sql`drop schema if exists public cascade`)
    await driver.db.execute(sql`create schema public`)
    await migrateDb(driver.db) // applies src/db/migrations/*.sql

    const tables = await driver.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual(['job_events', 'jobs', 'pending_actions', 'runs', 'slots'])
    // Postgres is the source of truth. BullMQ will only ever carry job ids.
  })

  it('SETUP 4. starts the worker: migrate, reconcile (nothing to repair yet), consume the queue', async () => {
    // This is the real worker wiring (src/composition/worker.ts). `start()` also runs the startup
    // reconciler, which would repair jobs a crash left behind. `poll()` (the Linear loop) is NOT
    // started: the walkthrough triggers each intake poll by hand so you can watch it.
    worker = composeWorker(config, (line) => logLines.push(line))
    await worker.start()

    const started = logLines.map((line) => JSON.parse(line) as { msg: string; [key: string]: unknown })
    expect(started.find((entry) => entry.msg === 'Reconciled on startup')).toMatchObject({
      requeued: [],
      retried: [],
      failed: [],
      slotsFreed: [],
    })
    expect(started.some((entry) => entry.msg === 'Worker started')).toBe(true)
  })

  it('SETUP 5. starts the API (src/composition/api.ts): Hono app, auth, Host/Origin checks', async () => {
    api = composeApi(config, (line) => logLines.push(line))

    // Every /v1 route needs `Authorization: Bearer <API_TOKEN>`...
    expect((await call('GET', '/v1/jobs', { token: null })).status).toBe(401)
    expect((await call('GET', '/v1/jobs', { token: 'wrong' })).status).toBe(401)
    // ...and a Host of 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding).
    const wrongHost = await api.app.request(`${apiOrigin}/v1/jobs`, {
      headers: { Host: 'evil.example', Authorization: `Bearer ${config.API_TOKEN}` },
    })
    expect(wrongHost.status).toBe(403)
    // With both right, an empty store lists nothing.
    const empty = await call('GET', '/v1/jobs')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])
  })

  // -------------------------------------------------------------------------------------------
  // THE STORY, ROUTE A: a Todo ticket needs a human
  // -------------------------------------------------------------------------------------------
  it('1. intake reads tickets from the tracker (src/linear.ts + src/linear-map.ts)', async () => {
    linearIssues = [issue(1, 'Add a greeting', 'Todo'), issue(2, 'Fix a typo', 'In Progress')]

    const feed = createLinearClient({
      apiKey: config.LINEAR_API_KEY,
      teamKey: config.LINEAR_TEAM_KEY,
      fetch: fakeLinearFetch,
      logger: driver.logger,
      sleep: () => Promise.resolve(),
      rand: Math.random,
    })

    const items: WorkItem[] = []
    for await (const item of feed.poll()) items.push(item)

    // What was sent: one GraphQL query, filtered by team, "assigned to me", and three statuses.
    expect(linearRequests).toHaveLength(1)
    expect(linearRequests[0]?.query).toContain('assignee: { isMe: { eq: true } }')
    expect(linearRequests[0]?.variables).toMatchObject({ teamKey: 'TST' })

    // What came back: Linear's JSON is mapped to the tracker-neutral WorkItem. Nothing after this
    // point knows about Linear, only about WorkItem (src/types.ts).
    expect(items.map((item) => [item.identifier, item.status])).toEqual([
      ['TST-1', 'Todo'],
      ['TST-2', 'In Progress'],
    ])
    expect(items[0]).toMatchObject({
      source: 'linear',
      externalId: 'issue-1',
      title: 'Add a greeting',
      body: 'Body of TST-1',
      branch: 'demo/tst-1',
      url: 'https://example.com/TST-1',
    })
  })

  it('2. the intake policy decides what each ticket becomes (src/intake-policy.ts, pure code)', () => {
    // `decideIntake` has no clock, no database, no network: ticket list in, decisions out.
    const result = decideIntake({
      items: linearIssues.map((i) => ({
        source: 'linear',
        externalId: i.id,
        identifier: i.identifier,
        title: i.title,
        body: i.description,
        labels: [],
        url: i.url,
        status: i.state.name,
      })),
      knownExternalIds: new Set(), // nothing stored yet
      sourceHasJobs: false, // so this is the FIRST poll for the source: the "baseline"
      openProposals: 0,
      maxOpenProposals: config.MAX_OPEN_PROPOSALS,
      maxEnqueuePerPoll: config.MAX_ENQUEUE_PER_POLL,
    })

    expect(result.decisions.map((d) => [d.item.identifier, d.action, d.reason])).toEqual([
      ['TST-1', 'propose', 'Todo'], // Todo/Backlog always ask a human first
      ['TST-2', 'propose', 'baseline'], // already In Progress on the very first poll: do not start a burst
    ])
    expect(result.skipped).toEqual([])
  })

  it('3. a real poll stores those decisions as jobs; nothing is queued yet (src/intake.ts)', async () => {
    const feed = createLinearClient({
      apiKey: config.LINEAR_API_KEY,
      teamKey: config.LINEAR_TEAM_KEY,
      fetch: fakeLinearFetch,
      logger: driver.logger,
      sleep: () => Promise.resolve(),
      rand: Math.random,
    })

    const counts = await runIntakePoll({
      feed,
      db: driver.db,
      logger: driver.logger,
      queue: driver.queue,
      now: new Date(),
      store: {
        insertJob: store.insertJob,
        knownExternalIds: intakeQueries.knownExternalIds,
        countJobsForSource: intakeQueries.countJobsForSource,
        countOpenProposals: intakeQueries.countOpenProposals,
      },
      config: {
        dryRun: config.DRY_RUN,
        maxEnqueuePerPoll: config.MAX_ENQUEUE_PER_POLL,
        maxOpenProposals: config.MAX_OPEN_PROPOSALS,
        maxAttempts: config.MAX_ATTEMPTS,
      },
    })

    expect(counts).toEqual({ queued: 0, proposed: 2, skipped: 0 })
    const jobs = await store.listJobs(driver.db)
    expect(jobs.map((job) => [job.identifier, job.state, job.attempt])).toEqual(
      expect.arrayContaining([
        ['TST-1', 'proposed', 0],
        ['TST-2', 'proposed', 0],
      ]),
    )
    // Polling again changes nothing: (source, externalId) is unique, a job row is never recreated.
    const again = await runIntakePoll({
      feed,
      db: driver.db,
      logger: driver.logger,
      queue: driver.queue,
      now: new Date(),
      store: {
        insertJob: store.insertJob,
        knownExternalIds: intakeQueries.knownExternalIds,
        countJobsForSource: intakeQueries.countJobsForSource,
        countOpenProposals: intakeQueries.countOpenProposals,
      },
      config: { dryRun: false, maxEnqueuePerPoll: 2, maxOpenProposals: 20, maxAttempts: 2 },
    })
    expect(again).toEqual({ queued: 0, proposed: 0, skipped: 2 })
  })

  it('4. the API shows the proposals and which buttons each allows (src/api, src/jobs-queries.ts)', async () => {
    const response = await call('GET', '/v1/jobs')
    expect(response.status).toBe(200)
    const jobs = (await response.json()) as { identifier: string; state: string; allowedActions: string[] }[]

    const todo = jobs.find((job) => job.identifier === 'TST-1')
    expect(todo).toMatchObject({ state: 'proposed', allowedActions: ['confirm', 'decline'] })
    // `allowedActions` comes from src/jobs-commands.ts, so a client never offers a rejected button.
    // Moves the state machine allows only for its own reasons are refused to a person:
    const jobId = (await jobByTicket('TST-1')).id
    expect((await call('POST', `/v1/jobs/${jobId}/retry`)).status).toBe(409) // only failed/cancelled jobs retry
    expect((await call('POST', `/v1/jobs/${jobId}/cancel`)).status).toBe(409) // a proposal is not running
  })

  it('5. the human confirms TST-1: proposed -> queued, and its id goes onto the BullMQ queue', async () => {
    const jobId = (await jobByTicket('TST-1')).id
    const response = await call('POST', `/v1/jobs/${jobId}/confirm`)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ identifier: 'TST-1', state: 'queued', allowedActions: ['cancel'] })
    // From here the worker takes over. It re-reads the job from Postgres before doing anything.
  })

  it('6. the worker runs it: slot -> claiming -> worktree -> running -> echo agent -> done (src/worker/process-job.ts)', async () => {
    const job = await waitForState('TST-1', 'done')

    // The audit trail (job_events is append-only). Every move went through the state machine
    // (src/transitions.ts); an illegal edge would have thrown instead.
    const events = await driver.db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id)).orderBy(jobEvents.id)
    expect(events.map((event) => `${event.fromState ?? '-'} -> ${event.toState}`)).toEqual([
      '- -> proposed', //          intake created it
      'proposed -> queued', //     the human confirmed (reason: "confirmed")
      'queued -> claiming', //     the worker took a slot and bumped `attempt`
      'claiming -> running', //    the worktree is ready and the runner starts
      'running -> done', //        phase 1 ends here; phase 4 will go to pr_open instead
    ])
    expect(events[1]?.reason).toBe('confirmed')
    expect(job.attempt).toBe(1)
    // One run is its own record: which slot it had, when it started, and how it ended.
    const runs = await store.listRuns(driver.db, job.id)
    expect(runs).toMatchObject([{ number: 1, slot: 0, outcome: 'done', failureKind: null }])
    expect(runs[0]?.endedAt).not.toBeNull()
  })

  it('7. what the run left behind: transcript, branch, no worktree, no slot', async () => {
    const job = await jobByTicket('TST-1')

    // The slot is only held while claiming/running, so it is already free again.
    expect(await driver.db.select().from(slots)).toEqual([])

    // Run folder: one transcript for the UI (redacted orchestrator lines, agent events as-is)
    // and one raw file (byte-exact runner output, never served by the API).
    // One folder per run, so a retry cannot be confused with the attempt before it.
    expect(readdirSync(join(runsDir, job.id)).sort()).toEqual(['1'])
    const runDir = join(runsDir, job.id, '1')
    expect(readdirSync(runDir).sort()).toEqual(['raw.jsonl', 'transcript.jsonl'])
    const envelopes = readTranscript(runDir, 0)
    expect(envelopes.map((envelope) => [envelope.seq, envelope.kind])).toEqual([
      [1, 'orchestrator'],
      [2, 'system'],
      [3, 'assistant'],
      [4, 'result'],
    ])
    expect(envelopes[2]?.data).toMatchObject({ message: { content: [{ type: 'text', text: 'echo TST-1' }] } })

    // Git: the branch stays (a retry continues it); the worktree was removed in `finally`.
    expect(git(repoPath, 'branch', '--list', 'agent/*')).toContain('agent/tst-1')
    expect(git(repoPath, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(existsSync(join(runsDir, job.id, 'worktree'))).toBe(false)
  })

  it('8. the transcript streams over SSE, and a client can resume from any seq', async () => {
    const job = await jobByTicket('TST-1')

    async function readEvents(path: string, wanted: number, headers: Record<string, string> = {}) {
      const controller = new AbortController()
      const response = await api.app.request(`${apiOrigin}${path}`, {
        headers: { Host: '127.0.0.1:3100', Authorization: `Bearer ${config.API_TOKEN}`, ...headers },
        signal: controller.signal,
      })
      if (response.body === null) throw new Error('no body')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const ids: number[] = []
      while (ids.length < wanted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const id = /^id: (\d+)$/m.exec(frame)?.[1]
          if (id !== undefined) ids.push(Number(id))
        }
      }
      controller.abort() // the stream never ends on its own: it keeps tailing the file
      await reader.cancel().catch(() => undefined)
      return ids
    }

    expect(await readEvents(`/v1/jobs/${job.id}/log`, 4)).toEqual([1, 2, 3, 4])
    // A `seq` only means something inside one run, so a resume names the run it was reading.
    expect(await readEvents(`/v1/jobs/${job.id}/log?run=1`, 2, { 'Last-Event-ID': '2' })).toEqual([3, 4])
    // EventSource cannot send an Authorization header, so clients use fetch streaming and
    // resume with the standard Last-Event-ID header:
    // Without the run, the server refuses the resume rather than guess which run seq 2 belongs to.
    const refused = await api.app.request(`${apiOrigin}/v1/jobs/${job.id}/log`, {
      headers: { Host: '127.0.0.1:3100', Authorization: `Bearer ${config.API_TOKEN}`, 'Last-Event-ID': '2' },
    })
    expect(refused.status).toBe(400)
  })

  // -------------------------------------------------------------------------------------------
  // THE STORY, ROUTE B: an In Progress ticket skips the human
  // -------------------------------------------------------------------------------------------
  it('9. a NEW In Progress ticket on a later poll is queued straight away, no confirm needed', async () => {
    linearIssues = [...linearIssues, issue(3, 'Update the docs', 'In Progress')]
    const feed = createLinearClient({
      apiKey: config.LINEAR_API_KEY,
      teamKey: config.LINEAR_TEAM_KEY,
      fetch: fakeLinearFetch,
      logger: driver.logger,
      sleep: () => Promise.resolve(),
      rand: Math.random,
    })

    const counts = await runIntakePoll({
      feed,
      db: driver.db,
      logger: driver.logger,
      queue: driver.queue, // <- this time intake itself puts the id on the queue
      now: new Date(),
      store: {
        insertJob: store.insertJob,
        knownExternalIds: intakeQueries.knownExternalIds,
        countJobsForSource: intakeQueries.countJobsForSource,
        countOpenProposals: intakeQueries.countOpenProposals,
      },
      config: { dryRun: false, maxEnqueuePerPoll: 2, maxOpenProposals: 20, maxAttempts: 2 },
    })

    // The source already has jobs, so there is no baseline; one new ticket is under the burst cap.
    expect(counts).toEqual({ queued: 1, proposed: 0, skipped: 2 })
    const job = await waitForState('TST-3', 'done')
    expect(job.attempt).toBe(1)

    // TST-1 and TST-2 are untouched: TST-2 is still a proposal waiting for a human.
    expect((await jobByTicket('TST-2')).state).toBe('proposed')
  })

  it('10. the log shows the same story in structured, secret-free lines', () => {
    const entries = logLines.map((line) => JSON.parse(line) as { msg: string })
    const messages = entries.map((entry) => entry.msg)

    expect(messages).toContain('Intake decision')
    expect(messages).toContain('Intake poll finished')
    // Nothing logged contains a secret (src/platform/logger.ts redacts known secrets).
    const everything = logLines.join('\n')
    expect(everything).not.toContain(config.API_TOKEN)
    expect(everything).not.toContain(config.LINEAR_API_KEY)
    expect(everything).not.toContain(databaseUrl)
  })
})
