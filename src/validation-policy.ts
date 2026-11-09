// Pure validation policy: which checks an agent's worktree must pass before its work may be
// pushed, and whether a failure goes back to the agent. No process, no I/O, no clock: the caller
// runs the commands and reads the diff, then passes the results in.

import { z } from 'zod'

type CommandSpec = { name: string; run: string; timeoutSec?: number }

export type DiffPolicy = {
  /** Changed lines (added + deleted) allowed, outside lockfiles and generated files. */
  maxChangedLines: number
  /** Globs that must not change. */
  forbiddenPaths: string[]
  /** Globs that override `forbiddenPaths`. */
  allowedPaths: string[]
}

export type ValidationConfig = {
  /** Run in this order. Names are unique. */
  commands: CommandSpec[]
  diff: DiffPolicy
  /** Retries after the first run, 0..5. */
  maxRetries: number
}

export type ChangedFile = {
  /** The path after the change. */
  path: string
  /** The path before the change, set only for a rename. */
  oldPath?: string
  status: 'A' | 'M' | 'D' | 'R'
  added: number
  deleted: number
}

type DiffRule = 'too-large' | 'forbidden-path' | 'contract-test-changed' | 'lockfile-without-manifest'

export type DiffViolation = { rule: DiffRule; path?: string; detail: string }

export type CommandResult = {
  name: string
  exitCode: number
  timedOut: boolean
  /** The end of the command's combined output. */
  outputTail: string
}

export type ValidationInput = {
  results: CommandResult[]
  violations: DiffViolation[]
  /** The run being judged. The first run is 1. */
  attempt: number
  maxRetries: number
}

export type ValidationDecision =
  { action: 'pass' } | { action: 'retry'; feedback: string } | { action: 'fail'; kind: 'agent'; reason: string }

const DEFAULT_MAX_CHANGED_LINES = 800
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_FORBIDDEN_PATHS = [
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/id_rsa*',
  '.github/workflows/**',
]
const DEFAULT_ALLOWED_PATHS = ['.env.example', '**/.env.example']

const FEEDBACK_CAP = 8000
const FEEDBACK_TRUNCATED = '\n[feedback truncated]'
const TAIL_LINES = 40

const LOCKFILES: ReadonlySet<string> = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'])
const MANIFEST = 'package.json'
const CONTRACT_TEST_SUFFIX = '.contract.test.ts'
const GENERATED_SUFFIX = '.generated.ts'

/** Rules that fail at once: feeding them back would invite the agent to hide the change. */
const NEVER_RETRIED: ReadonlySet<DiffRule> = new Set(['forbidden-path', 'contract-test-changed'])

const nonBlank = (label: string) =>
  z.string().refine((value) => value.trim().length > 0, { message: `${label} must not be blank` })

const commandSchema = z.object({
  name: nonBlank('name'),
  run: nonBlank('run'),
  timeoutSec: z.number().positive().optional(),
})

const configSchema = z.object({
  commands: z
    .array(commandSchema)
    .min(1, 'at least one command is required')
    .superRefine((commands, ctx) => {
      const seen = new Set<string>()
      commands.forEach((command, index) => {
        if (seen.has(command.name)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'name'],
            message: `duplicate command name "${command.name}"`,
          })
        }
        seen.add(command.name)
      })
    }),
  diff: z
    .object({
      maxChangedLines: z.number().int().min(1).default(DEFAULT_MAX_CHANGED_LINES),
      forbiddenPaths: z.array(z.string()).default(() => [...DEFAULT_FORBIDDEN_PATHS]),
      allowedPaths: z.array(z.string()).default(() => [...DEFAULT_ALLOWED_PATHS]),
    })
    .prefault({}),
  maxRetries: z.number().int().min(0).max(5).default(DEFAULT_MAX_RETRIES),
})

/**
 * Parses and validates a validation config. Defaults: `maxChangedLines` 800, `maxRetries` 2,
 * `forbiddenPaths` as in the docs, `allowedPaths` `.env.example` at the root and at any depth.
 * Throws an Error that lists every problem, each with its path in the config.
 */
export function parseValidationConfig(input: unknown): ValidationConfig {
  const result = configSchema.safeParse(input)
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new Error(`invalid validation config:\n${lines.join('\n')}`)
  }
  return result.data
}

/**
 * True when `path` matches `pattern`. `*` matches within one segment, `?` one character other than
 * `/`, `**` any run of characters, and `**` plus a slash zero or more directories. Paths are relative and use `/`.
 * Character classes such as `[ab]` are not supported: `[` and `]` match literally.
 */
export function globMatch(pattern: string, path: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`).test(path)
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Lockfiles and generated files do not count toward the line limit. */
function countsTowardSize(path: string): boolean {
  return (
    !LOCKFILES.has(baseName(path)) &&
    !(path.startsWith('generated/') || path.includes('/generated/')) &&
    !path.endsWith(GENERATED_SUFFIX)
  )
}

function isForbidden(path: string, policy: DiffPolicy): boolean {
  return (
    policy.forbiddenPaths.some((glob) => globMatch(glob, path)) &&
    !policy.allowedPaths.some((glob) => globMatch(glob, path))
  )
}

const byPath = (a: ChangedFile, b: ChangedFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** A contract test may be added. Modifying, deleting or renaming one (on either path) is a violation. */
function contractTestViolation(file: ChangedFile): DiffViolation | undefined {
  if (file.status === 'A') return undefined
  const verb = file.status === 'M' ? 'modified' : file.status === 'D' ? 'deleted' : 'renamed'
  if (file.path.endsWith(CONTRACT_TEST_SUFFIX)) {
    return {
      rule: 'contract-test-changed',
      path: file.path,
      detail: `${file.path} was ${verb}; contract tests may only be added`,
    }
  }
  if (file.oldPath?.endsWith(CONTRACT_TEST_SUFFIX)) {
    return {
      rule: 'contract-test-changed',
      path: file.oldPath,
      detail: `${file.path} was renamed from ${file.oldPath}; contract tests may only be added`,
    }
  }
  return undefined
}

/**
 * Checks a diff against the policy. Rules, in this order: `too-large`, `forbidden-path`,
 * `contract-test-changed`, `lockfile-without-manifest`. Within a rule, violations sort by the file's
 * new path. A contract test may be added but not modified, deleted or renamed, on either path.
 */
export function checkDiff(files: readonly ChangedFile[], policy: DiffPolicy): DiffViolation[] {
  const sorted = [...files].sort(byPath)
  const violations: DiffViolation[] = []

  const total = sorted
    .filter((file) => countsTowardSize(file.path))
    .reduce((sum, file) => sum + file.added + file.deleted, 0)
  if (total > policy.maxChangedLines) {
    violations.push({
      rule: 'too-large',
      detail: `${total} changed lines, the limit is ${policy.maxChangedLines}`,
    })
  }

  // A rename is judged on its new path and its old path. The violation names the path that matched.
  for (const file of sorted) {
    if (isForbidden(file.path, policy)) {
      violations.push({ rule: 'forbidden-path', path: file.path, detail: `${file.path} is a forbidden path` })
    } else if (file.oldPath !== undefined && isForbidden(file.oldPath, policy)) {
      violations.push({
        rule: 'forbidden-path',
        path: file.oldPath,
        detail: `${file.path} was renamed from ${file.oldPath}; ${file.oldPath} is a forbidden path`,
      })
    }
  }

  for (const file of sorted) {
    const violation = contractTestViolation(file)
    if (violation) violations.push(violation)
  }

  const manifestChanged = sorted.some((file) => baseName(file.path) === MANIFEST)
  if (!manifestChanged) {
    for (const file of sorted) {
      if (LOCKFILES.has(baseName(file.path))) {
        violations.push({
          rule: 'lockfile-without-manifest',
          path: file.path,
          detail: `${file.path} changed but no ${MANIFEST} changed in this diff`,
        })
      }
    }
  }

  return violations
}

const isFailing = (result: CommandResult): boolean => result.exitCode !== 0 || result.timedOut

function describeViolation(violation: DiffViolation): string {
  return violation.path === undefined
    ? `${violation.rule}: ${violation.detail}`
    : `${violation.rule} (${violation.path}): ${violation.detail}`
}

/** The last lines of an output, oldest first. */
function tailLines(outputTail: string): string[] {
  const trimmed = outputTail.replace(/\s+$/, '')
  if (trimmed === '') return []
  return trimmed.split('\n').slice(-TAIL_LINES)
}

type FeedbackBlock = { header: string; original: number; lines: string[] }

function buildFeedback(failing: CommandResult[], violations: DiffViolation[]): string {
  const blocks: FeedbackBlock[] = failing.map((result) => {
    const lines = tailLines(result.outputTail)
    const outcome = result.timedOut ? 'timed out' : `exited with code ${result.exitCode}`
    return { header: `Command \`${result.name}\` ${outcome}:`, original: lines.length, lines }
  })

  const render = (): string => {
    const parts = ['Validation failed. Fix these problems, then keep the rest of the work.']
    for (const block of blocks) {
      parts.push('', block.header)
      if (block.lines.length > 0) parts.push(...block.lines)
      else parts.push(block.original === 0 ? '(no output)' : '(output cut to fit)')
    }
    if (violations.length > 0) {
      parts.push('', 'Diff rules:', ...violations.map((violation) => `- ${describeViolation(violation)}`))
    }
    return parts.join('\n')
  }

  // Drop the oldest output first: the earliest command's earliest line, until the text fits.
  let text = render()
  while (text.length > FEEDBACK_CAP) {
    const oldest = blocks.find((block) => block.lines.length > 0)
    if (!oldest) break
    oldest.lines.shift()
    text = render()
  }

  return text.length <= FEEDBACK_CAP
    ? text
    : `${text.slice(0, FEEDBACK_CAP - FEEDBACK_TRUNCATED.length)}${FEEDBACK_TRUNCATED}`
}

/**
 * Decides what happens after a validation run.
 *
 * - A `forbidden-path` or `contract-test-changed` violation fails at once, whatever the attempt.
 * - Pass only when every command exits 0 without timing out and there are no violations.
 * - Otherwise retry while `attempt <= maxRetries`. `attempt` counts from 1, so `maxRetries: 2`
 *   allows three runs in total.
 * - Otherwise fail with kind `agent`.
 *
 * The retry `feedback` is plain text: each failing command with its exit code and the last 40 lines
 * of its output, then each violation. It is capped at 8000 characters, cutting the oldest output first.
 */
export function decideValidation(input: ValidationInput): ValidationDecision {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new RangeError(`attempt must be an integer >= 1, got ${input.attempt}`)
  }
  if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0) {
    throw new RangeError(`maxRetries must be an integer >= 0, got ${input.maxRetries}`)
  }

  const neverRetried = input.violations.filter((violation) => NEVER_RETRIED.has(violation.rule))
  if (neverRetried.length > 0) {
    return {
      action: 'fail',
      kind: 'agent',
      reason: `never retried: ${neverRetried.map(describeViolation).join('; ')}`,
    }
  }

  const failing = input.results.filter(isFailing)
  if (failing.length === 0 && input.violations.length === 0) {
    return { action: 'pass' }
  }

  if (input.attempt <= input.maxRetries) {
    return { action: 'retry', feedback: buildFeedback(failing, input.violations) }
  }

  const problems = [
    ...failing.map((result) =>
      result.timedOut ? `${result.name} timed out` : `${result.name} exit ${result.exitCode}`,
    ),
    ...input.violations.map((violation) => violation.rule),
  ]
  return {
    action: 'fail',
    kind: 'agent',
    reason: `still failing after ${input.attempt} runs: ${problems.join(', ')}`,
  }
}
