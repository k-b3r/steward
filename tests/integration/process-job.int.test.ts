import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrateDb } from '../../src/db/migrate'
import { jobEvents } from '../../src/db/schema'
import { acquireSlot, getJob, heldSlots, insertJob, transitionJob } from '../../src/db/store'
import { closePool, createDb, createPool } from '../../src/platform/db'
import {
  attachWorktree,
  branchExists,
  createWorktree,
  fetchBase,
  mergeIntoWorktree,
  removeWorktree,
} from '../../src/platform/git'
import { createTranscriptWriter } from '../../src/runner/transcript'
import type { AgentRunner, Job, WorkItem } from '../../src/types'
import { processJob, type ProcessJobDeps } from '../../src/worker/process-job'

const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl === undefined) {
  throw new Error('TEST_DATABASE_URL is required for integration tests')
}

// The reset below drops whole schemas, so refuse any database that is not clearly a test one.
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
if (!databaseName.includes('test')) {
  throw new Error(`Refusing to run: TEST_DATABASE_URL database "${databaseName}" must contain "test"`)
}

const T0 = new Date('2025-01-01T00:00:00.000Z')
const BACKOFF = { baseMs: 1000, maxMs: 60_000 }

const pool = createPool(databaseUrl)
const db = createDb(pool)

const sqlDropDrizzleSchema = sql`drop schema if exists drizzle cascade`
const sqlDropPublicSchema = sql`drop schema if exists public cascade`
const sqlCreatePublicSchema = sql`create schema public`

async function resetDatabase(): Promise<void> {
  await db.execute(sqlDropDrizzleSchema)
  await db.execute(sqlDropPublicSchema)
  await db.execute(sqlCreatePublicSchema)
  await migrateDb(db)
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' })
}

function createRepo(root: string): string {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  git(repoPath, ['init', '-b', 'main'])
  git(repoPath, ['config', 'user.name', 'Steward Test'])
  git(repoPath, ['config', 'user.email', 'steward-test@example.test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  git(repoPath, ['add', 'README.md'])
  git(repoPath, ['commit', '-m', 'initial commit'])
  // Every run fetches the base branch, so the test repo has a real origin.
  const bare = join(root, 'origin.git')
  git(root, ['init', '-q', '--bare', '-b', 'main', bare])
  git(repoPath, ['remote', 'add', 'origin', bare])
  git(repoPath, ['push', '-q', 'origin', 'main'])
  return repoPath
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    source: 'linear',
    externalId: 'ext-1',
    identifier: 'TST-1',
    title: 'A job',
    body: 'Do the thing',
    labels: ['agent'],
    url: 'https://example.test/TST-1',
    status: 'Todo',
    ...overrides,
  }
}

async function createJob(overrides: { externalId?: string; maxAttempts?: number } = {}): Promise<Job> {
  const externalId = overrides.externalId ?? 'ext-1'
  const { job } = await insertJob(db, {
    item: makeItem({ externalId, identifier: `TST-${externalId}` }),
    state: 'queued',
    maxAttempts: overrides.maxAttempts ?? 3,
    now: T0,
  })
  return job
}

async function eventsFor(jobId: string) {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(jobEvents.id)
}

type FakeRunner = AgentRunner & { transcriptDir(jobId: string): string; starts: Job[] }

function makeRunner(options: { failStart?: Error } = {}): FakeRunner {
  const starts: Job[] = []
  const runner: AgentRunner & { transcriptDir(jobId: string): string } = {
    transcriptDir: (jobId) => join(runsDir, jobId),
    async start(job) {
      starts.push(job)
      if (options.failStart !== undefined) {
        throw options.failStart
      }
      const writer = createTranscriptWriter({ dir: join(runsDir, job.id), clock: () => T0 })
      writer.writeOrchestrator('started', { jobId: job.id })
      return { sessionId: `fake-${job.id}` }
    },
    async resume(): Promise<void> {},
    async cancel(): Promise<void> {},
  }
  return Object.assign(runner, { starts })
}

type Enqueued = { jobId: string; delayMs?: number }

function makeQueue(): { calls: Enqueued[]; queue: ProcessJobDeps['queue'] } {
  const calls: Enqueued[] = []
  return {
    calls,
    queue: {
      async enqueue(jobId: string, delayMs?: number): Promise<void> {
        calls.push({ jobId, delayMs })
      },
    },
  }
}

function makeDeps(overrides: Partial<ProcessJobDeps> = {}): ProcessJobDeps {
  return {
    db,
    runner: makeRunner(),
    clock: () => T0,
    rand: () => 0.5,
    config: { slotCount: 2, repoPath, runsDir, backoff: BACKOFF },
    queue: makeQueue().queue,
    git: { attachWorktree, branchExists, createWorktree, fetchBase, mergeIntoWorktree, removeWorktree },
    ...overrides,
  }
}

let root: string
let repoPath: string
let runsDir: string

beforeEach(async () => {
  await resetDatabase()
  root = mkdtempSync(join(tmpdir(), 'steward-process-job-'))
  repoPath = createRepo(root)
  runsDir = join(root, 'runs')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

afterAll(async () => {
  await closePool(pool)
})

describe('processJob', () => {
  it('walks queued -> claiming -> running -> done and cleans up', async () => {
    const job = await createJob()
    const runner = makeRunner()
    const enqueued = makeQueue()

    await processJob(makeDeps({ runner, queue: enqueued.queue }), job.id)

    expect(await getJob(db, job.id)).toMatchObject({ state: 'done', attempt: 1, slot: null })
    expect((await eventsFor(job.id)).map((event) => [event.fromState, event.toState])).toEqual([
      [null, 'queued'],
      ['queued', 'claiming'],
      ['claiming', 'running'],
      ['running', 'done'],
    ])
    expect(runner.starts).toHaveLength(1)
    expect(runner.starts[0]).toMatchObject({ id: job.id, state: 'running', attempt: 1 })
    expect(enqueued.calls).toEqual([])
    expect(existsSync(join(runsDir, job.id, 'transcript.jsonl'))).toBe(true)
    expect(existsSync(join(runsDir, job.id, 'worktree'))).toBe(false)
    expect(await heldSlots(db)).toEqual([])
    expect(git(repoPath, ['rev-parse', '--verify', 'refs/heads/agent/tst-ext-1']).trim()).toBe(
      git(repoPath, ['rev-parse', 'agent/tst-ext-1']).trim(),
    )
  })

  it('ignores a job that is not queued', async () => {
    const { job } = await insertJob(db, {
      item: makeItem(),
      state: 'proposed',
      maxAttempts: 3,
      now: T0,
    })
    const runner = makeRunner()
    const enqueued = makeQueue()

    await processJob(makeDeps({ runner, queue: enqueued.queue }), job.id)

    expect(await getJob(db, job.id)).toEqual(job)
    expect(await eventsFor(job.id)).toHaveLength(1)
    expect(runner.starts).toEqual([])
    expect(enqueued.calls).toEqual([])
    expect(await heldSlots(db)).toEqual([])
  })

  it('ignores an unknown job id', async () => {
    const runner = makeRunner()

    await processJob(makeDeps({ runner }), '00000000-0000-0000-0000-000000000000')

    expect(runner.starts).toEqual([])
  })

  it('re-enqueues with a delay when no slot is free and leaves the job queued', async () => {
    const blocker = await createJob({ externalId: 'blocker' })
    const job = await createJob({ externalId: 'waiting' })
    expect(await acquireSlot(db, blocker.id, 1, T0)).toBe(0)
    const runner = makeRunner()
    const enqueued = makeQueue()

    await processJob(
      makeDeps({
        runner,
        queue: enqueued.queue,
        config: { slotCount: 1, repoPath, runsDir, backoff: BACKOFF },
      }),
      job.id,
    )

    expect(await getJob(db, job.id)).toMatchObject({ state: 'queued', attempt: 0, slot: null })
    expect(enqueued.calls).toEqual([{ jobId: job.id, delayMs: 5000 }])
    expect(runner.starts).toEqual([])
    expect(await heldSlots(db)).toEqual([{ slot: 0, jobId: blocker.id, jobState: 'queued' }])
    expect(existsSync(join(runsDir, job.id, 'worktree'))).toBe(false)
  })

  it('retries an infra failure with the backoff delay and frees the slot', async () => {
    const job = await createJob()
    const runner = makeRunner({ failStart: new Error('runner exploded') })
    const enqueued = makeQueue()

    await processJob(makeDeps({ runner, queue: enqueued.queue }), job.id)

    expect(await getJob(db, job.id)).toMatchObject({
      state: 'queued',
      attempt: 1,
      slot: null,
      failureKind: 'infra',
      nextRunAt: new Date(T0.getTime() + 1000),
    })
    expect(enqueued.calls).toEqual([{ jobId: job.id, delayMs: 1000 }])
    expect((await eventsFor(job.id)).at(-1)).toMatchObject({
      fromState: 'running',
      toState: 'queued',
      failureKind: 'infra',
      reason: 'runner exploded',
    })
    expect(existsSync(join(runsDir, job.id, 'worktree'))).toBe(false)
    expect(await heldSlots(db)).toEqual([])
  })

  it('does not undo a cancel that happens while the job is running', async () => {
    const job = await createJob()
    const enqueued = makeQueue()
    const runner = makeRunner()
    const cancellingRunner: typeof runner = {
      ...runner,
      async start(started) {
        await transitionJob(db, started.id, 'cancelled', { now: T0, reason: 'cancelled by user' })
        return runner.start(started)
      },
    }

    await processJob(makeDeps({ runner: cancellingRunner, queue: enqueued.queue }), job.id)

    expect(await getJob(db, job.id)).toMatchObject({ state: 'cancelled', slot: null })
    expect(enqueued.calls).toEqual([])
    expect((await eventsFor(job.id)).map((event) => event.toState)).toEqual([
      'queued',
      'claiming',
      'running',
      'cancelled',
    ])
    expect(await heldSlots(db)).toEqual([])
  })

  describe('base and branch', () => {
    // The job for externalId 'ext-1' gets the identifier TST-ext-1 and so the branch agent/tst-ext-1.
    const BRANCH = 'agent/tst-ext-1'

    function pushToOrigin(file: string, body: string): string {
      const other = join(root, `other-${file}`)
      git(root, ['clone', '-q', join(root, 'origin.git'), other])
      git(other, ['config', 'user.name', 'Other'])
      git(other, ['config', 'user.email', 'other@example.test'])
      writeFileSync(join(other, file), body)
      git(other, ['add', file])
      git(other, ['commit', '-qm', `add ${file}`])
      git(other, ['push', '-q', 'origin', 'main'])
      return git(other, ['rev-parse', 'HEAD']).trim()
    }

    it('starts a new branch from what is on origin now, not from a stale local HEAD', async () => {
      const originTip = pushToOrigin('remote.txt', 'newer\n')
      const job = await createJob()

      await processJob(makeDeps(), job.id)

      expect(git(repoPath, ['rev-parse', BRANCH]).trim()).toBe(originTip)
      expect(git(repoPath, ['rev-parse', 'HEAD']).trim()).not.toBe(originTip)
    })

    it('continues an existing branch and merges the base into it, keeping earlier commits', async () => {
      git(repoPath, ['checkout', '-q', '-b', BRANCH])
      writeFileSync(join(repoPath, 'work.txt'), 'earlier attempt\n')
      git(repoPath, ['add', 'work.txt'])
      git(repoPath, ['commit', '-qm', 'earlier work'])
      const earlier = git(repoPath, ['rev-parse', 'HEAD']).trim()
      git(repoPath, ['checkout', '-q', 'main'])
      const originTip = pushToOrigin('remote.txt', 'newer\n')
      const logs: string[] = []
      const job = await createJob()

      await processJob(makeDeps({ log: (message) => logs.push(message) }), job.id)

      expect(await getJob(db, job.id)).toMatchObject({ state: 'done' })
      expect(() => git(repoPath, ['merge-base', '--is-ancestor', earlier, BRANCH])).not.toThrow()
      expect(() => git(repoPath, ['merge-base', '--is-ancestor', originTip, BRANCH])).not.toThrow()
      expect(logs.some((message) => message.includes('merge conflict'))).toBe(false)
    })

    it('fails a merge conflict as an agent failure, because the echo runner cannot resolve it', async () => {
      git(repoPath, ['checkout', '-q', '-b', BRANCH])
      writeFileSync(join(repoPath, 'README.md'), 'branch version\n')
      git(repoPath, ['add', 'README.md'])
      git(repoPath, ['commit', '-qm', 'branch change'])
      const before = git(repoPath, ['rev-parse', BRANCH]).trim()
      git(repoPath, ['checkout', '-q', 'main'])
      pushToOrigin('README.md', 'main version\n')
      const logs: string[] = []
      const enqueued = makeQueue()
      const job = await createJob()

      await processJob(makeDeps({ queue: enqueued.queue, log: (message) => logs.push(message) }), job.id)

      expect(await getJob(db, job.id)).toMatchObject({ state: 'failed', failureKind: 'agent', slot: null })
      expect((await eventsFor(job.id)).at(-1)).toMatchObject({ toState: 'failed', failureKind: 'agent' })
      expect((await eventsFor(job.id)).at(-1)?.reason).toMatch(/merge conflict with origin\/main/)
      expect(enqueued.calls).toEqual([])
      expect(git(repoPath, ['rev-parse', BRANCH]).trim()).toBe(before)
      expect(existsSync(join(runsDir, job.id, 'worktree'))).toBe(false)
      expect(await heldSlots(db)).toEqual([])
    })

    it('treats an unreachable origin as an infra failure and retries, with the slot freed', async () => {
      git(repoPath, ['remote', 'set-url', 'origin', join(root, 'does-not-exist.git')])
      const enqueued = makeQueue()
      const job = await createJob()

      await processJob(makeDeps({ queue: enqueued.queue }), job.id)

      expect(await getJob(db, job.id)).toMatchObject({ state: 'queued', failureKind: 'infra', slot: null })
      expect(enqueued.calls).toHaveLength(1)
      expect(await heldSlots(db)).toEqual([])
    })
  })

  it('fails a job after maxAttempts with the error message only', async () => {
    const job = await createJob({ maxAttempts: 1 })
    const runner = makeRunner({ failStart: new Error('runner exploded') })
    const enqueued = makeQueue()

    await processJob(makeDeps({ runner, queue: enqueued.queue }), job.id)

    expect(await getJob(db, job.id)).toMatchObject({
      state: 'failed',
      attempt: 1,
      slot: null,
      failureKind: 'infra',
    })
    expect(enqueued.calls).toEqual([])
    expect((await eventsFor(job.id)).at(-1)).toMatchObject({
      fromState: 'running',
      toState: 'failed',
      failureKind: 'infra',
      reason: 'runner exploded',
    })
    expect((await eventsFor(job.id)).at(-1)?.reason).toBe('runner exploded')
    expect(await heldSlots(db)).toEqual([])
  })

  it('fails a missing repository path immediately as setup, with no retry', async () => {
    const job = await createJob()
    const runner = makeRunner()
    const enqueued = makeQueue()
    let createCalls = 0
    const missingRepo = join(root, 'does-not-exist')

    await processJob(
      makeDeps({
        runner,
        queue: enqueued.queue,
        config: { slotCount: 2, repoPath: missingRepo, runsDir, backoff: BACKOFF },
        git: {
          ...makeDeps().git,
          async createWorktree(): Promise<void> {
            createCalls += 1
          },
          async removeWorktree(): Promise<void> {},
        },
      }),
      job.id,
    )

    expect(createCalls).toBe(0)
    expect(enqueued.calls).toEqual([])
    expect(await getJob(db, job.id)).toMatchObject({
      state: 'failed',
      attempt: 1,
      slot: null,
      failureKind: 'setup',
    })
    expect((await eventsFor(job.id)).at(-1)).toMatchObject({
      fromState: 'claiming',
      toState: 'failed',
      failureKind: 'setup',
      reason: `Repository path does not exist: ${missingRepo}`,
    })
    expect(await heldSlots(db)).toEqual([])
  })

  it('treats a git failure as infra and retries', async () => {
    const job = await createJob()
    // Git refuses a branch that another worktree already has checked out.
    git(repoPath, ['worktree', 'add', '-b', 'agent/tst-ext-1', join(root, 'elsewhere')])
    const enqueued = makeQueue()

    await processJob(makeDeps({ queue: enqueued.queue }), job.id)

    expect(await getJob(db, job.id)).toMatchObject({
      state: 'queued',
      attempt: 1,
      failureKind: 'infra',
      nextRunAt: new Date(T0.getTime() + 1000),
    })
    expect(enqueued.calls).toEqual([{ jobId: job.id, delayMs: 1000 }])
    expect(existsSync(join(runsDir, job.id, 'worktree'))).toBe(false)
    expect(await heldSlots(db)).toEqual([])
  })

  it('does not let a worktree cleanup error mask the original failure', async () => {
    const job = await createJob()
    const runner = makeRunner({ failStart: new Error('original failure') })
    const enqueued = makeQueue()

    await expect(
      processJob(
        makeDeps({
          runner,
          queue: enqueued.queue,
          git: {
            ...makeDeps().git,
            async createWorktree(): Promise<void> {},
            async removeWorktree(): Promise<void> {
              throw new Error('cleanup failure')
            },
          },
        }),
        job.id,
      ),
    ).resolves.toBeUndefined()

    expect(await getJob(db, job.id)).toMatchObject({ state: 'queued', failureKind: 'infra' })
    expect((await eventsFor(job.id)).at(-1)).toMatchObject({
      toState: 'queued',
      failureKind: 'infra',
      reason: 'original failure',
    })
    expect(await heldSlots(db)).toEqual([])
  })
})
