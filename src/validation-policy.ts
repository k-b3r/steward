// Pure validation policy: which diff rules an agent's worktree must pass before its work may be
// pushed. No process, no I/O, no clock: the caller reads the diff and passes the files in.

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

const LOCKFILES: ReadonlySet<string> = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'])
const MANIFEST = 'package.json'
const CONTRACT_TEST_SUFFIX = '.contract.test.ts'
const GENERATED_SUFFIX = '.generated.ts'

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
 * `forbiddenPaths` as in the docs, `allowedPaths` `['.env.example']`.
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
