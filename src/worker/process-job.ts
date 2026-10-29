// One delivery attempt of a job. Postgres is the source of truth: the queue only
// supplies the id, so this re-reads the row before it does anything.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { holdsSlot } from '../allocate'
import { acquireSlot, getJob, releaseSlot, transitionJob } from '../db/store'
import type { Db } from '../platform/db'
import type {
  attachWorktree,
  branchExists,
  createWorktree,
  fetchBase,
  mergeIntoWorktree,
  removeWorktree,
} from '../platform/git'
import { decideAfterFailure, type BackoffOptions } from '../retry-policy'
import type { AgentRunner, FailureKind, Job } from '../types'

export type ProcessJobDeps = {
  db: Db
  runner: AgentRunner & { transcriptDir(jobId: string): string }
  clock: () => Date
  rand: () => number
  config: {
    slotCount: number
    repoPath: string
    runsDir: string
    backoff: BackoffOptions
  }
  queue: { enqueue(jobId: string, delayMs?: number): Promise<void> }
  git: {
    createWorktree: typeof createWorktree
    attachWorktree: typeof attachWorktree
    branchExists: typeof branchExists
    fetchBase: typeof fetchBase
    mergeIntoWorktree: typeof mergeIntoWorktree
    removeWorktree: typeof removeWorktree
  }
  /** Base branch a new `agent/*` branch starts from. Defaults to main. */
  baseBranch?: string
  log?: (msg: string) => void
}

/** A missing repo or bad local setup is never retried; everything else is infra. */
class SetupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SetupError'
  }
}

/** A fetch that cannot succeed on retry: no remote, or no such base branch. */
function isSetupFetchMessage(message: string): boolean {
  return /does not appear to be a git repository|No such remote|couldn't find remote ref|Repository not found/.test(
    message,
  )
}

/**
 * Fetches the base branch. Only a fetch has the setup failures below, so the
 * classification lives here: anything else is rethrown unchanged and retried.
 */
async function fetchBaseClassified(deps: ProcessJobDeps, baseBranch: string): Promise<void> {
  try {
    await deps.git.fetchBase(deps.config.repoPath, 'origin', baseBranch)
  } catch (error) {
    const message = errorMessage(error)
    if (!isSetupFetchMessage(message)) {
      throw error
    }
    throw new SetupError(message)
  }
}

/** Work only an agent can do. It is not retried by backoff: the same input would fail the same way. */
class AgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentError'
  }
}

function branchName(identifier: string): string {
  return `agent/${identifier.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function logCleanupError(deps: ProcessJobDeps, jobId: string, action: string, error: unknown): void {
  deps.log?.(`job ${jobId}: ${action} failed: ${errorMessage(error)}`)
}

/**
 * Handles a failure after the slot was acquired. The original error is logged
 * and recorded, never thrown back at the queue: the retry decision belongs to
 * Postgres. If recording the failure fails, that error is logged too.
 */
async function recordFailure(deps: ProcessJobDeps, jobId: string, lastKnown: Job, error: unknown): Promise<void> {
  const kind: FailureKind = error instanceof SetupError ? 'setup' : error instanceof AgentError ? 'agent' : 'infra'
  const now = deps.clock()
  const reason = errorMessage(error)
  let job = lastKnown

  try {
    const latest = await getJob(deps.db, jobId)
    if (latest !== null) {
      job = latest
    }
  } catch (readError) {
    logCleanupError(deps, jobId, 're-reading the job after a failure', readError)
  }

  // A cancel (or any other move) that happened mid-run wins: never turn it back into a retry.
  if (!holdsSlot(job.state)) {
    deps.log?.(`job ${jobId}: left ${job.state} during the run, failure not recorded: ${reason}`)
    return
  }

  try {
    const decision = decideAfterFailure({
      kind,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      now,
      rand: kind === 'infra' ? deps.rand() : 0,
      backoff: deps.config.backoff,
    })

    if (decision.action === 'retry') {
      await transitionJob(deps.db, jobId, 'queued', {
        now,
        failureKind: kind,
        reason,
        nextRunAt: decision.nextRunAt,
      })
      await deps.queue.enqueue(jobId, Math.max(0, decision.nextRunAt.getTime() - now.getTime()))
      deps.log?.(`job ${jobId}: ${kind} failure, retrying at ${decision.nextRunAt.toISOString()}: ${reason}`)
      return
    }

    await transitionJob(deps.db, jobId, 'failed', { now, failureKind: kind, reason })
    deps.log?.(`job ${jobId}: ${kind} failure, no retry: ${reason}`)
  } catch (recordError) {
    logCleanupError(deps, jobId, 'recording the failure', recordError)
  }
}

/**
 * Runs one job claimed from the queue. A queued job takes a slot, gets a
 * worktree, starts the runner and (in phase 1) finishes as `done`. Failures are
 * classified and routed through the retry policy. The slot and worktree are
 * cleaned up on every path.
 */
export async function processJob(deps: ProcessJobDeps, jobId: string): Promise<void> {
  const job = await getJob(deps.db, jobId)
  if (job === null || job.state !== 'queued') {
    deps.log?.(`job ${jobId}: not queued, ignoring`)
    return
  }

  const slot = await acquireSlot(deps.db, jobId, deps.config.slotCount, deps.clock())
  if (slot === null) {
    deps.log?.(`job ${jobId}: no free slot, re-enqueued in 5000ms`)
    await deps.queue.enqueue(jobId, 5000)
    return
  }

  const worktreePath = join(deps.config.runsDir, jobId, 'worktree')
  let current = job

  try {
    current = await transitionJob(deps.db, jobId, 'claiming', { now: deps.clock() })
    if (!existsSync(deps.config.repoPath)) {
      throw new SetupError(`Repository path does not exist: ${deps.config.repoPath}`)
    }

    // A new branch starts from what is on origin now, never from whatever HEAD happens to be.
    const baseBranch = deps.baseBranch ?? 'main'
    await fetchBaseClassified(deps, baseBranch)
    const branch = branchName(current.identifier)
    if (await deps.git.branchExists(deps.config.repoPath, branch)) {
      // An earlier attempt or an open pull request already owns this branch: continue on it,
      // then bring it up to date. A conflict is left in place for the agent, not thrown away.
      await deps.git.attachWorktree({ repoPath: deps.config.repoPath, worktreePath, branch })
      const outcome = await deps.git.mergeIntoWorktree(worktreePath, `origin/${baseBranch}`)
      if (outcome === 'conflict') {
        // TODO(phase-2): hand the conflicted tree to the runner to resolve. The echo stub cannot, and
        // finishing as `done` would report success and then throw the tree away.
        throw new AgentError(`merge conflict with origin/${baseBranch}; the echo runner cannot resolve it`)
      }
    } else {
      await deps.git.createWorktree({
        repoPath: deps.config.repoPath,
        worktreePath,
        branch,
        baseRef: `origin/${baseBranch}`,
      })
    }
    current = await transitionJob(deps.db, jobId, 'running', { now: deps.clock() })
    await deps.runner.start(current)
    // TODO(phase-4): go to pr_open after validation and the draft pull request.
    await transitionJob(deps.db, jobId, 'done', { now: deps.clock() })
    deps.log?.(`job ${jobId}: done`)
  } catch (error) {
    await recordFailure(deps, jobId, current, error)
  } finally {
    try {
      await deps.git.removeWorktree(deps.config.repoPath, worktreePath)
    } catch (cleanupError) {
      logCleanupError(deps, jobId, 'removing the worktree', cleanupError)
    }
    try {
      // transitionJob frees the slot on claiming/running -> queued/failed; this
      // also covers a failure before `claiming` and a failed transition.
      await releaseSlot(deps.db, jobId)
    } catch (releaseError) {
      logCleanupError(deps, jobId, 'releasing the slot', releaseError)
    }
  }
}
