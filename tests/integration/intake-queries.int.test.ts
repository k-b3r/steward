import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

import { migrateDb } from '../../src/db/migrate'
import { countJobsForSource, countOpenProposals, knownSourceIds } from '../../src/db/intake-queries'
import { insertJob } from '../../src/db/store'
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

const T0 = new Date('2025-01-01T00:00:00.000Z')

const pool = createPool(databaseUrl)
const db = createDb(pool)

const sqlDropDrizzleSchema = sql`drop schema if exists drizzle cascade`
const sqlDropPublicSchema = sql`drop schema if exists public cascade`
const sqlCreatePublicSchema = sql`create schema public`

async function resetDatabase(): Promise<void> {
  // The migrator keeps its journal in the `drizzle` schema, so dropping only
  // `public` would make the next migration run a no-op.
  await db.execute(sqlDropDrizzleSchema)
  await db.execute(sqlDropPublicSchema)
  await db.execute(sqlCreatePublicSchema)
  await migrateDb(db)
}

function makeItem(source: string, sourceId: string, status: string): WorkItem {
  return {
    source,
    sourceId,
    ticketKey: `TST-${sourceId}`,
    title: `Synthetic ${sourceId}`,
    body: 'Synthetic body',
    labels: [],
    url: `https://example.com/tst/issues/${sourceId}`,
    status,
  }
}

async function seed(source: string, sourceId: string, state: 'proposed' | 'queued'): Promise<void> {
  await insertJob(db, {
    item: makeItem(source, sourceId, state === 'proposed' ? 'Todo' : 'In Progress'),
    state,
    maxAttempts: 3,
    now: T0,
  })
}

beforeEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await closePool(pool)
})

describe('knownSourceIds', () => {
  it('returns an empty set when the source has no jobs', async () => {
    await expect(knownSourceIds(db, 'linear')).resolves.toEqual(new Set())
  })

  it('returns only source ids for the requested source', async () => {
    await seed('linear', '1', 'proposed')
    await seed('linear', '2', 'queued')
    await seed('linear-work', '3', 'queued')

    await expect(knownSourceIds(db, 'linear')).resolves.toEqual(new Set(['1', '2']))
    await expect(knownSourceIds(db, 'linear-work')).resolves.toEqual(new Set(['3']))
  })
})

describe('countJobsForSource', () => {
  it('returns zero for a source with no jobs', async () => {
    await expect(countJobsForSource(db, 'linear')).resolves.toBe(0)
  })

  it('counts every job for the source across states', async () => {
    await seed('linear', '1', 'proposed')
    await seed('linear', '2', 'queued')
    await seed('linear-work', '3', 'queued')

    await expect(countJobsForSource(db, 'linear')).resolves.toBe(2)
    await expect(countJobsForSource(db, 'linear-work')).resolves.toBe(1)
  })
})

describe('countOpenProposals', () => {
  it('returns zero when there are no proposed jobs', async () => {
    await seed('linear', '1', 'queued')

    await expect(countOpenProposals(db)).resolves.toBe(0)
  })

  it('counts proposed jobs across sources and ignores other states', async () => {
    await seed('linear', '1', 'proposed')
    await seed('linear-work', '2', 'proposed')
    await seed('linear', '3', 'queued')

    await expect(countOpenProposals(db)).resolves.toBe(2)
  })
})
