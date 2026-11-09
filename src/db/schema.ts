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
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import {
  ACTION_STATUSES,
  FAILURE_KINDS,
  JOB_STATES,
  RUN_OUTCOMES,
  type ActionStatus,
  type FailureKind,
  type JobState,
  type RunOutcome,
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
    externalId: text('external_id').notNull(),
    identifier: text('identifier').notNull(),
    item: jsonb('item').$type<WorkItem>().notNull(),
    state: text('state').$type<JobState>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextRunAt: timestamptz('next_run_at'),
    failureKind: text('failure_kind').$type<FailureKind>(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    /** The branch the claim pushed, set once at claim time; never recomputed from the identifier. */
    branch: text('branch'),
  },
  (table) => [
    uniqueIndex('jobs_source_external_id_key').on(table.source, table.externalId),
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

/**
 * One execution of a job. `jobs` stays one row per ticket; a retry or a resume adds a run here.
 * A run opens when the job takes a slot and closes when it lets go (src/runs.ts).
 */
export const runs = pgTable(
  'runs',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    runNumber: integer('run_number').notNull(),
    /** Null for a run resumed from a waiting state, which has not taken a slot. */
    slot: integer('slot'),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    outcome: text('outcome').$type<RunOutcome>(),
    failureKind: text('failure_kind').$type<FailureKind>(),
    /** Pi's session id for this run, kept so a resume after a worker restart can continue it. */
    sessionId: text('session_id'),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.runNumber] }),
    check('runs_outcome_check', sql`${table.outcome} in (${sql.raw(quotedList(RUN_OUTCOMES))})`),
    check('runs_failure_kind_check', sql`${table.failureKind} in (${sql.raw(quotedList(FAILURE_KINDS))})`),
  ],
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
