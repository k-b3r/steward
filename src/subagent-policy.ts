// Pure sub-agent lifecycle policy. No clock, randomness, fetch or process: the caller passes `now`.
//
// A lead agent may start one-shot sub-agents. A one-shot runs to completion and exits, so the
// lead starts another one when it needs more work done. Steward, not the lead agent, enforces the
// limits below: the lead is never trusted to close what it started.

export type SubagentLimits = {
  /** Sub-agents running at the same moment. */
  maxConcurrent: number
  /** Sub-agents started over the whole job, finished ones included. */
  maxTotal: number
  /** 0 allows none, 1 lets only the lead agent start sub-agents. */
  maxDepth: number
  /** Longest a single sub-agent may run, from its start. */
  maxRuntimeMs: number
  /** Longest a sub-agent may produce no event while no tool call is running. */
  maxSilentMs: number
  /** Longest a single tool call may stay open. */
  toolTimeoutMs: number
}

export type SubagentRecord = {
  id: string
  /** 1 for a sub-agent started by the lead agent. The lead agent itself is depth 0. */
  depth: number
  startedAt: Date
  lastActivityAt: Date
  /** Tool calls in flight, by call id, with the time each started. */
  openTools: Readonly<Record<string, Date>>
}

/** What the caller learns from a sub-agent's event stream, already translated from the agent's own format. */
export type SubagentEvent =
  { type: 'tool_start'; toolCallId: string } | { type: 'tool_end'; toolCallId: string } | { type: 'activity' }

export type SpawnRequest = {
  /** 0 when the lead agent asks, 1 when a sub-agent asks. */
  requesterDepth: number
  /** Sub-agents running now. A finished one-shot is not in this list. */
  running: readonly SubagentRecord[]
  /** Sub-agents started so far in this job, finished ones included. */
  spawnedTotal: number
  limits: SubagentLimits
}

export type SpawnDecision = { allow: true } | { allow: false; reason: 'depth' | 'total' | 'concurrent' }

type ReapReason = 'max-runtime' | 'tool-timeout' | 'silent' | 'job-ended'

export type ReapDecision = { id: string; reason: ReapReason }

const COUNT_FIELDS = ['maxConcurrent', 'maxTotal', 'maxDepth'] as const
const DURATION_FIELDS = ['maxRuntimeMs', 'maxSilentMs', 'toolTimeoutMs'] as const

/** Limits come from configuration; a typo must stop the job, not silently remove a cap. */
export function assertLimits(limits: SubagentLimits): void {
  for (const field of COUNT_FIELDS) {
    const value = limits[field]
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${field} must be an integer >= 0, got ${String(value)}`)
    }
  }
  for (const field of DURATION_FIELDS) {
    const value = limits[field]
    // A zero duration would stop every agent the moment it starts: that is a typo, not a policy.
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${field} must be a finite number > 0, got ${String(value)}`)
    }
  }
}

/**
 * May this requester start another sub-agent? The reasons are ordered by how permanent they are:
 * `depth` and `total` never clear, `concurrent` clears when a running one ends.
 */
export function decideSpawn(request: SpawnRequest): SpawnDecision {
  assertLimits(request.limits)
  const { limits } = request

  if (request.requesterDepth + 1 > limits.maxDepth) return { allow: false, reason: 'depth' }
  if (request.spawnedTotal >= limits.maxTotal) return { allow: false, reason: 'total' }
  if (request.running.length >= limits.maxConcurrent) return { allow: false, reason: 'concurrent' }
  return { allow: true }
}

/** Folds one event into the record. Returns a new record; the input is never changed. */
export function recordEvent(record: SubagentRecord, event: SubagentEvent, now: Date): SubagentRecord {
  const openTools = { ...record.openTools }
  if (event.type === 'tool_start') {
    openTools[event.toolCallId] = now
  } else if (event.type === 'tool_end') {
    delete openTools[event.toolCallId]
  }
  return { ...record, lastActivityAt: now, openTools }
}

function oldestOpenTool(record: SubagentRecord): Date | null {
  let oldest: Date | null = null
  for (const startedAt of Object.values(record.openTools)) {
    if (oldest === null || startedAt.getTime() < oldest.getTime()) oldest = startedAt
  }
  return oldest
}

function reapReason(record: SubagentRecord, now: Date, limits: SubagentLimits): ReapReason | null {
  const elapsedSince = (from: Date): number => now.getTime() - from.getTime()

  if (elapsedSince(record.startedAt) >= limits.maxRuntimeMs) return 'max-runtime'

  // While a tool call is open, quiet is normal (a test run can take minutes): only the tool's own timeout applies.
  const tool = oldestOpenTool(record)
  if (tool !== null) return elapsedSince(tool) >= limits.toolTimeoutMs ? 'tool-timeout' : null

  return elapsedSince(record.lastActivityAt) >= limits.maxSilentMs ? 'silent' : null
}

/** The running sub-agents that must be stopped now, one reason each, in the order given. */
export function findToReap(running: readonly SubagentRecord[], now: Date, limits: SubagentLimits): ReapDecision[] {
  assertLimits(limits)
  const decisions: ReapDecision[] = []
  for (const record of running) {
    const reason = reapReason(record, now, limits)
    if (reason !== null) decisions.push({ id: record.id, reason })
  }
  return decisions
}

/** The job is over (done, failed or cancelled): nothing it started may outlive it. */
export function reapAll(running: readonly SubagentRecord[]): ReapDecision[] {
  return running.map((record) => ({ id: record.id, reason: 'job-ended' }))
}
