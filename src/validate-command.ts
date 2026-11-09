// Pure argv builder for one validation check inside the Pi image. The shape follows `buildPiRunArgs`,
// with the same image and caps, but no `-e` at all: a check needs no model key and must not see any
// credential (docs/decisions.md).

import { assertPath, assertPositiveInteger, assertPattern, IMAGE_OR_MODEL, INSTANCE, JOB_ID } from './runner/pi-command'

export type CheckRunInput = {
  /** The instance name, already validated by config: lower-case, like `personal`. */
  instance: string
  /** Tracker-derived job id. It goes into the container name, so it stays a slug. */
  jobId: string
  /** 1 for the first run of a job; with `index` it keeps container names unique. */
  runNumber: number
  /** The check's position in the config, from 0. */
  index: number
  /** The image tag, pinned by the caller (e.g. `steward-pi:1.5.0`). */
  image: string
  /** Absolute host path of the job's worktree. Mounted read-write at `/workspace`. */
  worktreePath: string
  /** The config's `run`, passed as one argument after `-c` so its shell syntax stays intact. */
  command: string
  limits: { cpus: number; memoryMb: number; pidsLimit: number }
}

/** The container's name: one per instance, job, run and check, so a timeout can kill exactly it. */
export function checkContainerName(input: Pick<CheckRunInput, 'instance' | 'jobId' | 'runNumber' | 'index'>): string {
  assertPattern('instance', input.instance, INSTANCE, 'lower-case letters, digits or hyphens, starting with a letter')
  assertPattern('jobId', input.jobId, JOB_ID, 'letters, digits or hyphens')
  assertPositiveInteger('runNumber', input.runNumber)
  if (!Number.isInteger(input.index) || input.index < 0) {
    throw new RangeError(`index must be an integer >= 0, got ${String(input.index)}`)
  }
  return `steward-${input.instance}-check-${input.jobId}-${input.runNumber}-${input.index}`
}

function assertInput(input: CheckRunInput): void {
  checkContainerName(input)
  assertPath('worktreePath', input.worktreePath)
  assertPattern(
    'image',
    input.image,
    IMAGE_OR_MODEL,
    'an image reference that starts with a letter or digit, so it cannot read as a podman option',
  )
  if (input.command.trim() === '') throw new RangeError('command must not be blank')
  assertPositiveInteger('limits.cpus', input.limits.cpus)
  assertPositiveInteger('limits.memoryMb', input.limits.memoryMb)
  assertPositiveInteger('limits.pidsLimit', input.limits.pidsLimit)
}

/**
 * The `podman run` arguments for one check: the worktree at `/workspace`, `sh -c` as the entrypoint,
 * the command last. Network stays on slirp4netns for the reason in decision 36: a check must reach a
 * package registry, and host networking would expose steward's own services.
 */
export function buildCheckRunArgs(input: CheckRunInput): string[] {
  assertInput(input)

  return [
    'run',
    '--rm',
    '--name',
    checkContainerName(input),
    // keep-id maps the host user inside the container, so files it writes are not root-owned.
    '--userns=keep-id',
    `--cpus=${input.limits.cpus}`,
    `--memory=${input.limits.memoryMb}m`,
    `--pids-limit=${input.limits.pidsLimit}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--network=slirp4netns',
    '-v',
    `${input.worktreePath}:/workspace:rw`,
    '-w',
    '/workspace',
    // The image's own entrypoint is Pi; a check is a shell command, and `-c` takes it as one argv.
    '--entrypoint',
    'sh',
    input.image,
    '-c',
    input.command,
  ]
}
