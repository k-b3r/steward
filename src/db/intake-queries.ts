// Read-only intake queries. They take the drizzle handle and a source name;
// nothing here reads the clock or the environment.

import { count, eq } from 'drizzle-orm'

import type { Db } from '../platform/db'
import { jobs } from './schema'

/** Source ids that already have a job row for this source. */
export async function knownSourceIds(db: Db, source: string): Promise<Set<string>> {
  const rows = await db.select({ sourceId: jobs.sourceId }).from(jobs).where(eq(jobs.source, source))
  return new Set(rows.map((row) => row.sourceId))
}

/** Whether this source has ever produced a job; false means the next poll is its baseline. */
export async function countJobsForSource(db: Db, source: string): Promise<number> {
  const [row] = await db.select({ count: count() }).from(jobs).where(eq(jobs.source, source))
  return row?.count ?? 0
}

/** Open proposals across all sources, used for the proposal cap. */
export async function countOpenProposals(db: Db): Promise<number> {
  const [row] = await db.select({ count: count() }).from(jobs).where(eq(jobs.state, 'proposed'))
  return row?.count ?? 0
}
