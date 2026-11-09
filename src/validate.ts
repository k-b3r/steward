// The validation executor: stages the worktree, reads the diff into the policy's shape and runs the
// config's checks in the Pi image. Nothing calls it yet (docs/decisions.md, decision 38).

import type { Exec } from './platform/github'
import { assertPath } from './runner/pi-command'
import {
  type ChangedFile,
  checkDiff,
  type CommandResult,
  decideValidation,
  type DiffViolation,
  NEVER_RETRIED,
  type ValidationConfig,
  type ValidationDecision,
} from './validation-policy'
import { buildCheckRunArgs, checkContainerName } from './validate-command'
import { joinChangedFiles, parseDiffNameStatus, parseNumstat } from './validate-git'

export type RunExec = (cmd: string, args: string[]) => Promise<{ code: number; output: string }>

type CheckLimits = { cpus: number; memoryMb: number; pidsLimit: number }
type Clock = { clock: () => Date; sleep: (ms: number) => Promise<void> }
type Outcome = { code: number; output: string }

export type ValidationDeps = Clock & {
  exec: Exec
  /** Podman, with stdout and stderr merged so the tail keeps the order a person would read. */
  podman: RunExec
  /** Applied to a check's output before it is kept: a check may print a token or a home path. */
  redact: (text: string) => string
}

export type RunChecksInput = {
  config: ValidationConfig
  instance: string
  jobId: string
  runNumber: number
  image: string
  worktreePath: string
  limits: CheckLimits
}

export type ValidateWorktreeInput = RunChecksInput & {
  /** The ref the worktree was cut from; the diff is read against it. */
  baseRef: string
  /** The run being judged. The first run is 1. */
  attempt: number
}

const DEFAULT_TIMEOUT_SEC = 600
/** The last 64 KB of a check's output: the part the feedback may show. */
const TAIL_CHARS = 64 * 1024
const POLL_MS = 1000
/** How long the attached `podman run` gets to report the exit code after its container was killed. */
const KILL_GRACE_MS = 10_000
/** Reported when the container was killed and its `podman run` never came back. */
const NO_EXIT_CODE = -1

function assertBaseRef(ref: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new RangeError(`baseRef must be a plain git ref, got ${JSON.stringify(ref)}`)
  }
}

async function git(exec: Exec, args: string[]): Promise<string> {
  const result = await exec('git', args)
  if (result.code !== 0) {
    const detail = result.stderr.trim()
    throw new Error(`git ${args.join(' ')} failed (exit ${result.code})${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout
}

/**
 * Stages the worktree, then reads the diff against `baseRef`. `git add -A` writes the worktree's own
 * index and nothing else: the orchestrator commits and pushes. Staging is what brings an untracked
 * file the agent created into the diff the policy judges. `--userns=keep-id` leaves the worktree
 * owned by the host user, so no `safe.directory` entry is needed.
 */
export async function collectChangedFiles(
  deps: { exec: Exec },
  input: { worktreePath: string; baseRef: string },
): Promise<ChangedFile[]> {
  assertBaseRef(input.baseRef)
  assertPath('worktreePath', input.worktreePath)
  const diff = ['-C', input.worktreePath, 'diff', '--cached', '-M']
  await git(deps.exec, ['-C', input.worktreePath, 'add', '-A'])
  const nameStatus = await git(deps.exec, [...diff, '--name-status', '-z', input.baseRef])
  const numstat = await git(deps.exec, [...diff, '--numstat', '-z', input.baseRef])
  return joinChangedFiles(parseDiffNameStatus(nameStatus), parseNumstat(numstat))
}

function keepTail(text: string): string {
  return text.length <= TAIL_CHARS ? text : text.slice(-TAIL_CHARS)
}

async function waitFor(sample: () => Outcome | undefined, waitMs: number, deps: Clock): Promise<Outcome | undefined> {
  const deadline = deps.clock().getTime() + waitMs
  let outcome = sample()
  while (outcome === undefined) {
    const remaining = deadline - deps.clock().getTime()
    if (remaining <= 0) return undefined
    await deps.sleep(Math.min(POLL_MS, remaining))
    outcome = sample()
  }
  return outcome
}

type OneCheck = { containerName: string; args: string[]; timeoutSec: number }

/** Runs one check, killing the container by name at its timeout; the attached run reports 137. */
async function runOneCheck(
  deps: Pick<ValidationDeps, 'podman' | 'clock' | 'sleep' | 'redact'>,
  check: OneCheck,
): Promise<Omit<CommandResult, 'name'>> {
  let settled: Outcome | undefined
  const read = (): Outcome | undefined => settled
  // The handlers go on now, so a late rejection is not an unhandled one.
  void deps.podman('podman', check.args).then(
    (outcome) => {
      settled = outcome
    },
    (error: unknown) => {
      settled = { code: 1, output: error instanceof Error ? error.message : String(error) }
    },
  )

  const finished = await waitFor(read, check.timeoutSec * 1000, deps)
  if (finished !== undefined) {
    return { exitCode: finished.code, timedOut: false, outputTail: keepTail(deps.redact(finished.output)) }
  }

  await deps.podman('podman', ['kill', check.containerName])
  // The kill ends the container, not necessarily the attached `podman run`: bound that wait too.
  const killed = (await waitFor(read, KILL_GRACE_MS, deps)) ?? { code: NO_EXIT_CODE, output: '' }
  return { exitCode: killed.code, timedOut: true, outputTail: keepTail(deps.redact(killed.output)) }
}

/**
 * Runs the config's checks in order, each in its own container, stopping at the first failure: a
 * later check would only add noise to the one that broke, and a skipped one is not reported. Output
 * is redacted and then cut to the last 64 KB, so a secret split by the cut never survives.
 */
export async function runChecks(
  deps: Pick<ValidationDeps, 'podman' | 'clock' | 'sleep' | 'redact'>,
  input: RunChecksInput,
): Promise<CommandResult[]> {
  const results: CommandResult[] = []
  for (const [index, command] of input.config.commands.entries()) {
    const containerName = checkContainerName({ ...input, index })
    const args = buildCheckRunArgs({ ...input, command: command.run, index })
    const outcome = await runOneCheck(deps, {
      containerName,
      args,
      timeoutSec: command.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    })
    results.push({ name: command.name, ...outcome })
    if (outcome.timedOut || outcome.exitCode !== 0) break
  }
  return results
}

/**
 * Validates one agent run: read the diff, apply the diff rules, run the checks, decide. A
 * `forbidden-path` or `contract-test-changed` violation skips the checks: those rules fail at once
 * whatever the attempt (decision 34), and the checks are commands the agent itself wrote.
 */
export async function validateWorktree(
  deps: ValidationDeps,
  input: ValidateWorktreeInput,
): Promise<{ decision: ValidationDecision; results: CommandResult[]; violations: DiffViolation[] }> {
  const files = await collectChangedFiles({ exec: deps.exec }, input)
  const violations = checkDiff(files, input.config.diff)
  const skipChecks = violations.some((violation) => NEVER_RETRIED.has(violation.rule))
  const results = skipChecks ? [] : await runChecks(deps, input)

  return {
    decision: decideValidation({ results, violations, attempt: input.attempt, maxRetries: input.config.maxRetries }),
    results,
    violations,
  }
}
