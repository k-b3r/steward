// The only file allowed to import `pg` (enforced by dependency-cruiser).
// Everything else takes the drizzle `Db` handle from here.
import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from '../db/schema'

export type Db = NodePgDatabase<typeof schema>

/** What a pool error is reported to; the caller decides how to log it. */
export type PoolErrorHandler = (error: { message: string }) => void

/**
 * A pool whose lost connections are reported instead of thrown. An idle client that loses its
 * server emits `error` on the pool, and Node turns an unhandled `error` event into a crashed
 * process: that is how a Postgres restart used to kill the worker and the API.
 */
export function createPool(url: string, onError: PoolErrorHandler = () => undefined): pg.Pool {
  const pool = new pg.Pool({ connectionString: url })
  pool.on('error', (error: unknown) => {
    onError({ message: error instanceof Error ? error.message : String(error) })
  })
  return pool
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end()
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema })
}
