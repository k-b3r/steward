// The only file allowed to import `pg` (enforced by dependency-cruiser).
// Everything else takes the drizzle `Db` handle from here.
import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from '../db/schema'

export type Db = NodePgDatabase<typeof schema>

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url })
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end()
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema })
}
