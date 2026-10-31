// Public API contract. The future browser dashboard imports this file and nothing
// else from `src/`, so it must stay free of server code: zod plus type-only imports.
import { z } from 'zod'

import type { ActionSummary, JobSummary } from '../jobs-queries'
import type { ActionStatus } from '../types'
import type { Envelope, TranscriptKind } from '../runner/transcript'
import type { FailureKind, JobState } from '../types'
import type { createApp } from './app'

const JOB_STATE_VALUES = [
  'proposed',
  'declined',
  'queued',
  'claiming',
  'running',
  'pr_open',
  'in_review',
  'changes_requested',
  'merged',
  'done',
  'failed',
  'cancelled',
] as const satisfies readonly JobState[]

const FAILURE_KIND_VALUES = ['infra', 'agent', 'setup'] as const satisfies readonly FailureKind[]

const ACTION_STATUS_VALUES = [
  'pending',
  'approved',
  'rejected',
  'done',
  'failed',
] as const satisfies readonly ActionStatus[]

const TRANSCRIPT_KIND_VALUES = [
  'system',
  'assistant',
  'tool',
  'result',
  'error',
  'orchestrator',
] as const satisfies readonly TranscriptKind[]

// A new member in types.ts or schema.ts fails to compile until it is listed above.
const _jobStatesCovered: Exclude<JobState, (typeof JOB_STATE_VALUES)[number]> extends never ? true : never = true
const _failureKindsCovered: Exclude<FailureKind, (typeof FAILURE_KIND_VALUES)[number]> extends never ? true : never =
  true
const _actionStatusesCovered: Exclude<ActionStatus, (typeof ACTION_STATUS_VALUES)[number]> extends never
  ? true
  : never = true
const _transcriptKindsCovered: Exclude<TranscriptKind, (typeof TRANSCRIPT_KIND_VALUES)[number]> extends never
  ? true
  : never = true

/** @public */
export const jobStateSchema = z.enum(JOB_STATE_VALUES)
/** @public */
export const failureKindSchema = z.enum(FAILURE_KIND_VALUES)
/** @public */
export const actionStatusSchema = z.enum(ACTION_STATUS_VALUES)
/** @public */
export const transcriptKindSchema = z.enum(TRANSCRIPT_KIND_VALUES)

/** The five buttons a job can offer; matches `JobAction` in `src/jobs-commands.ts`. */
const jobActionSchema = z.enum(['confirm', 'decline', 'reconsider', 'retry', 'cancel'])

/**
 * The wire shape of a job, asserted against the read layer's JobSummary at compile time, so the
 * schema and the projection cannot drift.
 */
export const jobResponseSchema = z.object({
  id: z.uuid(),
  source: z.string(),
  identifier: z.string(),
  state: jobStateSchema,
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  slot: z.number().int().nonnegative().nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  failureKind: failureKindSchema.nullable(),
  allowedActions: z.array(jobActionSchema),
})

/** @public */
export const actionResponseSchema = z.object({
  id: z.uuid(),
  jobId: z.uuid(),
  kind: z.string(),
  payload: z.unknown(),
  status: actionStatusSchema,
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
})

/** @public */
export const transcriptEnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.iso.datetime(),
  kind: transcriptKindSchema,
  data: z.unknown(),
})

/** @public */
export const errorResponseSchema = z.object({
  error: z.string(),
})

export const declineBodySchema = z.object({
  reason: z.string().trim().min(1),
})

export const rejectBodySchema = z.object({
  reason: z.string().trim().min(1).optional(),
})

export type JobResponse = z.infer<typeof jobResponseSchema>

// A mismatch here is a type error: change both together.
const _jobResponseMatchesReadLayer: z.ZodType<JobSummary> = jobResponseSchema
const _actionResponseMatchesReadLayer: z.ZodType<ActionSummary> = actionResponseSchema
void _jobResponseMatchesReadLayer
void _actionResponseMatchesReadLayer
export type ActionResponse = z.infer<typeof actionResponseSchema>

// `Envelope` is structurally the same as `TranscriptEnvelope`.
const _envelopeMatches: Envelope extends z.infer<typeof transcriptEnvelopeSchema> ? true : never = true

/** @public */
export type AppType = ReturnType<typeof createApp>
