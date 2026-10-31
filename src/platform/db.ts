// The only file allowed to import `pg` (enforced by dependency-cruiser).
// Everything else takes the drizzle `Db` handle from here.
import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from '../db/schema'

/**
 * The drizzle handle over the `pg` pool, bound to the schema in `src/db/schema.ts`. `createDb` builds
 * it, and callers pass it unchanged into `src/db/store.ts` or `src/db/intake-queries.ts` instead of
 * running their own queries. The pool behind it is closed by the composition root with `closePool`.
 * No test fakes this handle: the integration suites open a real Postgres.
 */
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
