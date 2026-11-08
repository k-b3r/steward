// Pure argv builder for a Pi coding-agent run inside a rootless Podman container. No I/O, no env
// reads, no clock: the caller passes the paths, the limits and the names of the variables to
// forward, and gets back the arguments that follow `podman` (never the binary itself).
//
// UNVERIFIED: the Pi flags below are taken from the Pi 1.5.0 docs (`docs/cli.md`) and
// `pi --help`, not from a real run inside this image.

export type PiRunInput = {
  /** The instance name, already validated by config: lower-case, like `personal`. */
  instance: string
  /** Tracker-derived job id. It goes into the container name, so it stays a slug. */
  jobId: string
  /** 1 for the first run of a job; it keeps container names unique per attempt. */
  runNumber: number
  /** The image tag, pinned by the caller (e.g. `steward-pi:1.5.0`). */
  image: string
  /** Absolute host path of the job's git worktree. Mounted read-write at `/workspace`. */
  worktreePath: string
  /** Absolute host path of this run's session folder. Mounted read-write at `/session`. */
  sessionDir: string
  /** The first prompt. It goes in after `--`, so a prompt starting with `-` is safe. */
  prompt: string
  /** Pi session id to resume; absent for a fresh run. */
  resumeSessionId?: string
  /** Environment variable NAMES to forward. Only the names, never the values. */
  passEnv: string[]
  limits: {
    cpus: number
    memoryMb: number
    pidsLimit: number
  }
  /** Pi model pattern, e.g. `anthropic/claude-sonnet-5-5`; omitted means Pi's own default. */
  model?: string
}

// Same shape as the config's instance name, plus the length cap on the container name.
const INSTANCE = /^[a-z][a-z0-9-]{0,30}$/
const JOB_ID = /^[A-Za-z0-9-]+$/
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

// The agent container never gets GitHub, SSH or tracker credentials: the model key is the only
// credential allowed in. With `GITHUB_TOKEN`, `GH_TOKEN` or an SSH agent socket the agent could
// push, open pull requests and write to the tracker from inside the container, and with
// `GIT_*` it could rewrite its own author identity. Those writes belong to the orchestrator
// alone (docs/security.md), so a forward of one of these names is a bug, not a detail.
const FORBIDDEN_ENV = ['GITHUB', 'GH_', 'LINEAR', 'SSH', 'GIT_']

function assertPattern(field: string, value: string, pattern: RegExp, expected: string): void {
  if (!pattern.test(value)) {
    throw new RangeError(`${field} must be ${expected}, got ${JSON.stringify(value)}`)
  }
}

function assertPath(field: string, value: string): void {
  if (!value.startsWith('/')) {
    throw new RangeError(`${field} must be an absolute path, got ${JSON.stringify(value)}`)
  }
  // A colon is Podman's volume separator and a newline would split the argument on re-parse.
  if (/[:\n\r]/.test(value)) {
    throw new RangeError(`${field} must not contain a colon or a newline, got ${JSON.stringify(value)}`)
  }
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer, got ${String(value)}`)
  }
}

function assertEnvName(name: string): void {
  assertPattern('passEnv name', name, ENV_NAME, 'an upper-case variable name like ANTHROPIC_API_KEY')
  const forbidden = FORBIDDEN_ENV.find((part) => name.includes(part))
  if (forbidden !== undefined) {
    throw new Error(
      `passEnv must not forward ${JSON.stringify(name)}: the agent container gets no GitHub, ` +
        `SSH or tracker credentials (matched ${JSON.stringify(forbidden)})`,
    )
  }
}

function assertInput(input: PiRunInput): void {
  assertPattern('instance', input.instance, INSTANCE, 'lower-case letters, digits or hyphens, starting with a letter')
  assertPattern('jobId', input.jobId, JOB_ID, 'letters, digits or hyphens')
  assertPositiveInteger('runNumber', input.runNumber)
  assertPath('worktreePath', input.worktreePath)
  assertPath('sessionDir', input.sessionDir)
  for (const name of input.passEnv) {
    assertEnvName(name)
  }
  assertPositiveInteger('limits.cpus', input.limits.cpus)
  assertPositiveInteger('limits.memoryMb', input.limits.memoryMb)
  assertPositiveInteger('limits.pidsLimit', input.limits.pidsLimit)
}

/**
 * The `podman run` arguments for one Pi job. The container keeps outbound network (the model
 * API needs it) through slirp4netns, so there is no `--network=none` and no host networking.
 */
export function buildPiRunArgs(input: PiRunInput): string[] {
  assertInput(input)

  const { instance, jobId, runNumber, image, worktreePath, sessionDir, prompt } = input
  const args = [
    'run',
    '--rm',
    '--name',
    `steward-${instance}-job-${jobId}-${runNumber}`,
    // keep-id maps the host user inside the container, so files it writes are not root-owned.
    '--userns=keep-id',
    `--cpus=${input.limits.cpus}`,
    `--memory=${input.limits.memoryMb}m`,
    `--pids-limit=${input.limits.pidsLimit}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    // The model API needs outbound network. slirp4netns, not host networking: a host-networked
    // container could reach steward's Postgres, Redis and API on 127.0.0.1. It is also not the
    // default (pasta), which gets no traffic out on this box (verified 2026-11-08).
    '--network=slirp4netns',
    '-v',
    `${worktreePath}:/workspace:rw`,
    '-v',
    `${sessionDir}:/session:rw`,
    '-w',
    '/workspace',
  ]

  // Names only: Podman reads the value from the orchestrator's environment, so no secret is
  // written into the argument list or a file.
  for (const name of input.passEnv) {
    args.push('-e', name)
  }

  args.push(image, '-p', '--mode', 'json', '--session-dir', '/session')
  if (input.model !== undefined) {
    args.push('--model', input.model)
  }
  if (input.resumeSessionId !== undefined) {
    args.push('--session', input.resumeSessionId)
  }
  args.push('--', prompt)

  return args
}
