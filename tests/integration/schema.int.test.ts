import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { migrateDb } from '../../src/db/migrate'
import { jobs } from '../../src/db/schema'
import { closePool, createDb, createPool } from '../../src/platform/db'
import type { WorkItem } from '../../src/types'

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
  it('creates the four tables', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    )

    expect(result.rows.map((r) => r.table_name)).toEqual(['job_events', 'jobs', 'pending_actions', 'slots'])
  })

  it('allows one job per source and external id', async () => {
    await db.insert(jobs).values(row())

    await expect(db.insert(jobs).values(row())).rejects.toThrow()
  })

  it('rejects a state outside the state machine', async () => {
    await expect(db.insert(jobs).values(row({ externalId: 'ext-2', state: 'bogus' as never }))).rejects.toThrow()
  })

  it('rejects an unknown failure kind', async () => {
    await expect(db.insert(jobs).values(row({ externalId: 'ext-3', failureKind: 'bogus' as never }))).rejects.toThrow()
  })
})
