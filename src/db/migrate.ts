import { join } from 'node:path'

import { migrate } from 'drizzle-orm/node-postgres/migrator'

import type { Db } from '../platform/db'

const MIGRATIONS_FOLDER = join(import.meta.dirname, 'migrations')

/** Applies every pending SQL migration in src/db/migrations. */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}
