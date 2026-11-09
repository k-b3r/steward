import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { migrateDb } from '../../src/db/migrate'
import { jobs, runs } from '../../src/db/schema'
import { closePool, createDb, createPool } from '../../src/platform/db'
import { JOB_STATES, type WorkItem } from '../../src/types'

const databaseUrl = process.env.TEST_DATABASE_URL
if (databaseUrl === undefined) {
  throw new Error('TEST_DATABASE_URL is required for integration tests')
}

// The reset below drops whole schemas, so refuse any database that is not clearly a test one.
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
if (!databaseName.includes('test')) {
  throw new Error(`Refusing to run: TEST_DATABASE_URL database "${databaseName}" must contain "test"`)
}

const pool = createPool(databaseUrl)
const db = createDb(pool)

const item: WorkItem = {
  source: 'linear',
  externalId: 'ext-1',
  identifier: 'TST-1',
  title: 'A job',
  body: '',
  labels: [],
  url: 'https://example.test/TST-1',
  status: 'Todo',
}

function row(overrides: Partial<typeof jobs.$inferInsert> = {}): typeof jobs.$inferInsert {
  const now = new Date('2025-01-01T00:00:00.000Z')
  return {
    source: item.source,
    externalId: item.externalId,
    identifier: item.identifier,
    item,
    state: 'queued',
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

beforeEach(async () => {
  // The migrator keeps its journal in the `drizzle` schema, so both schemas go.
  await db.execute(sql`drop schema if exists drizzle cascade`)
  await db.execute(sql`drop schema if exists public cascade`)
  await db.execute(sql`create schema public`)
  await migrateDb(db)
})

afterAll(async () => {
  await closePool(pool)
})

describe('schema', () => {
  it('creates the five tables', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    )

    expect(result.rows.map((r) => r.table_name)).toEqual(['job_events', 'jobs', 'pending_actions', 'runs', 'slots'])
  })

  it('allows one job per source and external id', async () => {
    await db.insert(jobs).values(row())

    await expect(db.insert(jobs).values(row())).rejects.toThrow()
  })

  it('accepts every state of the state machine, ci_failed included', async () => {
    for (const [index, state] of JOB_STATES.entries()) {
      await db.insert(jobs).values(row({ externalId: `ext-state-${index}`, state }))
    }

    const stored = await db.select({ state: jobs.state }).from(jobs)
    expect(stored.map((r) => r.state).sort()).toEqual([...JOB_STATES].sort())
  })

  it('rejects a state outside the state machine', async () => {
    await expect(db.insert(jobs).values(row({ externalId: 'ext-2', state: 'bogus' as never }))).rejects.toThrow()
  })

  it('rejects an unknown failure kind', async () => {
    await expect(db.insert(jobs).values(row({ externalId: 'ext-3', failureKind: 'bogus' as never }))).rejects.toThrow()
  })

  it('allows one run number per job, and rejects an unknown run outcome', async () => {
    const [job] = await db.insert(jobs).values(row()).returning()
    const startedAt = new Date('2025-01-01T00:00:00.000Z')
    await db.insert(runs).values({ jobId: job!.id, runNumber: 1, startedAt })

    await expect(db.insert(runs).values({ jobId: job!.id, runNumber: 1, startedAt })).rejects.toThrow()
    await expect(
      db.insert(runs).values({ jobId: job!.id, runNumber: 2, startedAt, outcome: 'bogus' as never }),
    ).rejects.toThrow()
  })

  it('carries the branch on a job and the session id on a run, both nullable', async () => {
    const [job] = await db.insert(jobs).values(row()).returning()
    await db.insert(runs).values({ jobId: job!.id, runNumber: 1, startedAt: new Date('2025-01-01T00:00:00.000Z') })

    const [fresh] = await db.select({ branch: jobs.branch }).from(jobs)
    expect(fresh?.branch).toBeNull()
    const [noSession] = await db.select({ sessionId: runs.sessionId }).from(runs)
    expect(noSession?.sessionId).toBeNull()

    await db.update(jobs).set({ branch: 'TST-1' })
    await db.update(runs).set({ sessionId: 'session-one' })
    const [stored] = await db.select({ branch: jobs.branch }).from(jobs)
    const [withSession] = await db.select({ sessionId: runs.sessionId }).from(runs)
    expect(stored?.branch).toBe('TST-1')
    expect(withSession?.sessionId).toBe('session-one')
  })
})
