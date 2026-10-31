// Drizzle schema for the job store. Column names are snake_case; the code uses
// the camelCase fields. State and failure-kind values come from the shared
// domain types so the CHECK constraints cannot drift from the state machine.
import { sql } from 'drizzle-orm'
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import {
  ACTION_STATUSES,
  FAILURE_KINDS,
  JOB_STATES,
  type ActionStatus,
  type FailureKind,
  type JobState,
  type WorkItem,
} from '../types'

function quotedList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    ticketKey: text('ticket_key').notNull(),
    item: jsonb('item').$type<WorkItem>().notNull(),
    state: text('state').$type<JobState>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextRunAt: timestamptz('next_run_at'),
    failureKind: text('failure_kind').$type<FailureKind>(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('jobs_source_source_id_key').on(table.source, table.sourceId),
    index('jobs_state_idx').on(table.state),
    check('jobs_state_check', sql`${table.state} in (${sql.raw(quotedList(JOB_STATES))})`),
    check('jobs_failure_kind_check', sql`${table.failureKind} in (${sql.raw(quotedList(FAILURE_KINDS))})`),
  ],
)

/** Append-only log of state changes. Never updated or deleted by the store. */
export const jobEvents = pgTable(
  'job_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    fromState: text('from_state').$type<JobState>(),
    toState: text('to_state').$type<JobState>().notNull(),
    failureKind: text('failure_kind').$type<FailureKind>(),
    reason: text('reason'),
    data: jsonb('data'),
    at: timestamptz('at').notNull(),
  },
  (table) => [index('job_events_job_id_id_idx').on(table.jobId, table.id)],
)

/** A row exists only while its job holds the slot. */
export const slots = pgTable('slots', {
  slot: integer('slot').primaryKey(),
  jobId: uuid('job_id')
    .notNull()
    .unique()
    .references(() => jobs.id),
  acquiredAt: timestamptz('acquired_at').notNull(),
})

/** Every outside write that needs a human decision before it is sent. */
export const pendingActions = pgTable(
  'pending_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    status: text('status').$type<ActionStatus>().notNull().default('pending'),
    reason: text('reason'),
    createdAt: timestamptz('created_at').notNull(),
    decidedAt: timestamptz('decided_at'),
  },
  (table) => [check('pending_actions_status_check', sql`${table.status} in (${sql.raw(quotedList(ACTION_STATUSES))})`)],
)
