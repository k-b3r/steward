import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { migrateDb } from '../../src/db/migrate'
import { createAction, getJob, insertJob, listActions, transitionJob } from '../../src/db/store'
import { confirmJob, type CommandDeps, type CommandStore } from '../../src/jobs-commands'
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
  await db.execute(sqlDropDrizzleSchema)
  await db.execute(sqlDropPublicSchema)
  await db.execute(sqlCreatePublicSchema)
  await migrateDb(db)
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    source: 'linear',
    externalId: 'issue-42',
    identifier: 'TST-42',
    title: 'A job',
    body: 'Do the thing',
    labels: ['agent'],
    url: 'https://example.test/TST-42',
    status: 'Todo',
    ...overrides,
  }
}

/** The same adapter src/composition/api.ts builds, over the test database. */
function commandDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const store: CommandStore = {
    getJob: (id) => getJob(db, id),
    getAction: () => Promise.resolve(null),
    transitionJob: (id, to, opts) => transitionJob(db, id, to, opts),
    decideAction: () => Promise.reject(new Error('not used here')),
    createAction: (input) => createAction(db, input),
  }
  return {
    store,
    clock: () => T0,
    enqueue: () => Promise.resolve(),
    cancelRun: () => Promise.resolve(),
    ...overrides,
  }
}

beforeEach(resetDatabase)

afterAll(async () => {
  await closePool(pool)
})

describe('confirmJob', () => {
  it('leaves the job queued and records one pending action when the Linear move fails', async () => {
    const { job } = await insertJob(db, { item: makeItem(), state: 'proposed', maxAttempts: 3, now: T0 })
    const deps = commandDeps({
      linear: {
        targetState: 'In Progress',
        moveToState: () => Promise.reject(new Error('Linear issueUpdate failed with status 500')),
      },
    })

    const confirmed = await confirmJob(deps, job.id)

    expect(confirmed.id).toBe(job.id)
    expect((await getJob(db, job.id))?.state).toBe('queued')

    const actions = await listActions(db, { status: 'pending' })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      jobId: job.id,
      kind: 'linear_move',
      payload: { issueId: 'issue-42', state: 'In Progress' },
      status: 'pending',
      reason: 'Linear issueUpdate failed with status 500',
    })
  })

  it('records nothing when the ticket is already in the target state', async () => {
    const { job } = await insertJob(db, { item: makeItem(), state: 'proposed', maxAttempts: 3, now: T0 })
    const deps = commandDeps({
      linear: { targetState: 'In Progress', moveToState: () => Promise.resolve('already') },
    })

    await confirmJob(deps, job.id)

    expect((await getJob(db, job.id))?.state).toBe('queued')
    expect(await listActions(db)).toEqual([])
  })
})
