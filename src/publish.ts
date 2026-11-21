// The publish step: validate the agent's work, commit what it staged, push the branch and write the
// report into the pull request body. Every effect is injected, so the order and the failure paths are
// testable. Nothing calls it yet: the worker's slice wires it in (docs/wiring-plan.md, slice 4).

import { type Exec, pushBranch, updatePrBody } from './platform/github'
import type { CommandResult, DiffViolation, ValidationDecision } from './validation-policy'
import { renderValidationReport } from './validation-report'

/** One validation attempt, as `validateWorktree` returns it (src/validate.ts). */
export type ValidatedAttempt = {
  decision: ValidationDecision
  results: CommandResult[]
  violations: DiffViolation[]
}

export type ValidationLoopDeps = {
  /** Wraps `validateWorktree` for one attempt. The first attempt is 1. */
  validate: (attempt: number) => Promise<ValidatedAttempt>
  /** Continues the agent's session with the decision's feedback. */
  resume: (feedback: string) => Promise<void>
}

export type ValidationLoopResult = {
  status: 'passed' | 'failed'
  attempts: number
  /** Why the loop stopped, when it failed: the decision's reason or the retry budget running out. */
  reason?: string
  /** The Markdown report for the pull request body. */
  report: string
}

const NO_CHANGES = 'The agent left no changes to commit, so the branch still holds only its empty claim.'

/**
 * Commits what validation staged: `git add -A` left the index fully staged, so the commit needs no
 * paths. The identity comes from the clone's local config (no `-c user.*`); a clean index means the
 * agent changed nothing. Internal: `publish` is the module's entry point.
 */
async function commitStaged(
  deps: { exec: Exec },
  input: { worktreePath: string; message: string },
): Promise<'committed' | 'nothing'> {
  // 0 is a clean index, 1 is staged changes; any other code is an error the commit below reports.
  const diff = await deps.exec('git', ['-C', input.worktreePath, 'diff', '--cached', '--quiet'])
  if (diff.code === 0) return 'nothing'

  const commit = await deps.exec('git', ['-C', input.worktreePath, 'commit', '-m', input.message])
  if (commit.code !== 0) {
    const detail = commit.stderr.trim()
    throw new Error(
      `git commit in ${input.worktreePath} failed (exit ${commit.code})${detail === '' ? '' : `: ${detail}`}`,
    )
  }
  return 'committed'
}

/**
 * Runs validate, resume, validate until a decision passes or fails. Never more than `maxRetries + 1`
 * validations: a retry asked for on the last allowed attempt fails instead of resuming, since no next
 * validation would judge the agent's answer. A `resume` that throws propagates; the caller classifies it.
 */
export async function runValidationLoop(
  deps: ValidationLoopDeps,
  input: { maxRetries: number },
): Promise<ValidationLoopResult> {
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0) {
    throw new RangeError(`maxRetries must be an integer >= 0, got ${input.maxRetries}`)
  }
  const cap = input.maxRetries + 1
  for (let attempt = 1; attempt <= cap; attempt++) {
    const outcome = await deps.validate(attempt)
    const report = (status: 'passed' | 'failed'): string =>
      renderValidationReport({
        results: outcome.results,
        violations: outcome.violations,
        attempts: attempt,
        outcome: status,
      })

    if (outcome.decision.action === 'pass') {
      return { status: 'passed', attempts: attempt, report: report('passed') }
    }
    if (outcome.decision.action === 'fail') {
      return { status: 'failed', attempts: attempt, reason: outcome.decision.reason, report: report('failed') }
    }
    if (attempt === cap) {
      return {
        status: 'failed',
        attempts: attempt,
        reason: `validation asked for a retry after ${attempt} attempt${attempt === 1 ? '' : 's'}`,
        report: report('failed'),
      }
    }
    await deps.resume(outcome.decision.feedback)
  }
  throw new Error('unreachable: the last attempt returns above')
}

export type PublishDeps = ValidationLoopDeps & { exec: Exec }

export type PublishInput = {
  worktreePath: string
  /** `owner/name` on GitHub. */
  repo: string
  branch: string
  /** The draft pull request the claim opened. Its body carries the report. */
  prNumber: number
  ghAccount: string
  /** The commit message the agent's work is recorded in. */
  commitMessage: string
  /** The validation config's retry budget: the loop validates at most this plus one time. */
  maxRetries: number
}

export type PublishResult = {
  status: 'published' | 'failed' | 'no-changes'
  attempts: number
  /** Set when the run failed: the validation decision's reason. */
  reason?: string
}

/**
 * Takes a validated agent run to a pushed branch. Validation failed: nothing is pushed and the draft
 * stays empty, but the body carries the failure report, so a person sees why. Nothing staged:
 * `no-changes`, again with nothing pushed and the body updated. Otherwise commit the staged work,
 * push the branch (never forced, decision 35), then write the report. A failed push throws before the
 * body, so a body saying "passed" never appears without the work behind it.
 */
export async function publish(deps: PublishDeps, input: PublishInput): Promise<PublishResult> {
  const loop = await runValidationLoop(deps, { maxRetries: input.maxRetries })
  const writeBody = (body: string): Promise<void> =>
    updatePrBody({ exec: deps.exec }, { repo: input.repo, number: input.prNumber, body, ghAccount: input.ghAccount })

  if (loop.status === 'failed') {
    await writeBody(loop.report)
    return { status: 'failed', attempts: loop.attempts, reason: loop.reason }
  }

  const committed = await commitStaged(
    { exec: deps.exec },
    {
      worktreePath: input.worktreePath,
      message: input.commitMessage,
    },
  )
  if (committed === 'nothing') {
    await writeBody(`${NO_CHANGES}\n\n${loop.report}`)
    return { status: 'no-changes', attempts: loop.attempts }
  }

  await pushBranch(
    { exec: deps.exec },
    {
      repoPath: input.worktreePath,
      worktreePath: input.worktreePath,
      repo: input.repo,
      branch: input.branch,
      ghAccount: input.ghAccount,
    },
  )
  await writeBody(loop.report)
  return { status: 'published', attempts: loop.attempts }
}
