// Host-side GitHub operations for the claim: identity check, empty claim commit,
// branch push, draft PR and the PR lookups the worker needs. Every command goes
// through the injected Exec. The account's token travels only in the child env,
// never in arguments, and is redacted from anything thrown.
import { execFile } from 'node:child_process'
import { z } from 'zod'

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>

type ExecOpts = NonNullable<Parameters<Exec>[2]>

/**
 * Builds the child-process adapter. execFile replaces the environment instead of
 * extending it, and the child needs PATH and HOME (git finds gh, gh finds its
 * account config), so the caller's env is merged over an ambient environment that
 * comes in as an argument: this module never reads `process.env` itself, and the
 * composition root that owns the read stays an entry point.
 */
export function createExecFileExec(ambient: Readonly<Record<string, string | undefined>>): Exec {
  return (cmd, args, opts) =>
    new Promise((resolve) => {
      const env = opts?.env === undefined ? undefined : { ...ambient, ...opts.env }
      execFile(cmd, args, { cwd: opts?.cwd, env, encoding: 'utf8' }, (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr }),
      )
    })
}

const REDACTED = '[REDACTED]'
const TOKEN_SHAPE = /gh[opsu]_[A-Za-z0-9]{20,}/g
const CREDENTIAL_HELPER = 'credential.helper=!gh auth git-credential'

/** Removes known secrets and any token-shaped text from a message we might throw. */
function redact(text: string, secrets: readonly string[] = []): string {
  const known = secrets.filter((secret) => secret !== '')
  return known.reduce((out, secret) => out.split(secret).join(REDACTED), text).replace(TOKEN_SHAPE, REDACTED)
}

function failure(action: string, result: { code: number; stderr: string }, secrets: readonly string[] = []): Error {
  const detail = redact(result.stderr.trim(), secrets)
  return new Error(`${action} failed (exit ${result.code})${detail === '' ? '' : `: ${detail}`}`)
}

/** Refuses a value that git or gh could read as an option. */
function assertSafe(value: string, what: string, pattern: RegExp): void {
  if (!pattern.test(value)) throw new Error(`Unsafe ${what}: ${value}`)
}

/**
 * A branch name reaches `git push` as `refs/heads/<branch>` and as a plain argument, so it must
 * be valid as a git ref and must not look like an option. Letters, digits, `.`, `_`, `-` and `/`
 * only: that rules out the characters that break a refspec (space, `~`, `^`, `:`, `?`, `*`, `[`,
 * `\`). No leading `-` or `/`, no trailing `/`, `.` or `.lock`, no `..`, no empty component and
 * no component that starts with `.` or ends with `.lock`, since git refuses to build a ref from
 * any of those.
 */
const BRANCH = /^(?!\.)(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+(?<!\/)(?<!\.)$/
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const ACCOUNT = /^[A-Za-z0-9-]+$/

/**
 * Asks gh for one account's token. `--user` selects that account even when a
 * different one is active, so an instance acts as its own account. The token is
 * returned to the caller and never logged; `null` means gh has no token.
 */
async function ghAuthToken(exec: Exec, account: string, opts: ExecOpts = {}): Promise<string | null> {
  assertSafe(account, 'GitHub account name', ACCOUNT)
  const result = await exec('gh', ['auth', 'token', '--user', account], opts)
  const token = result.stdout.trim()
  return result.code === 0 && token !== '' ? token : null
}

async function requireToken(exec: Exec, account: string, opts: ExecOpts = {}): Promise<string> {
  const token = await ghAuthToken(exec, account, opts)
  if (token === null) {
    throw new Error(`gh account "${account}" is not logged in: gh auth token --user ${account} failed`)
  }
  return token
}

async function localConfig(exec: Exec, repoPath: string, key: string): Promise<string | null> {
  const result = await exec('git', ['-C', repoPath, 'config', '--local', key])
  const value = result.stdout.trim()
  return result.code === 0 && value !== '' ? value : null
}

function mismatch(field: string, actual: string | null, expected: string): string {
  return actual === null
    ? `clone ${field} is not set, expected "${expected}"`
    : `clone ${field} is "${actual}", expected "${expected}"`
}

/**
 * Proves the clone may act as the instance's account: the local author and
 * `steward.account` match, and gh holds a token for that account. The worker
 * turns a mismatch into a `setup` failure, which is never retried. The reason
 * names the field and never a secret.
 */
export async function checkIdentity(
  deps: { exec: Exec },
  input: { repoPath: string; ghAccount: string; gitName: string; gitEmail: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const expected: [string, string][] = [
    ['user.name', input.gitName],
    ['user.email', input.gitEmail],
  ]
  for (const [field, value] of expected) {
    const actual = await localConfig(deps.exec, input.repoPath, field)
    if (actual !== value) return { ok: false, reason: mismatch(field, actual, value) }
  }

  if ((await ghAuthToken(deps.exec, input.ghAccount, { cwd: input.repoPath })) === null) {
    const reason = `gh account "${input.ghAccount}" is not logged in: gh auth token --user ${input.ghAccount} failed`
    return { ok: false, reason }
  }

  const account = await localConfig(deps.exec, input.repoPath, 'steward.account')
  return account === input.ghAccount
    ? { ok: true }
    : { ok: false, reason: mismatch('steward.account', account, input.ghAccount) }
}

type PushInput = {
  repoPath: string
  worktreePath: string
  repo: string
  branch: string
  ghAccount: string
}

/**
 * Pushes one branch from the worktree to `https://github.com/<repo>.git`. The URL is
 * passed directly instead of a stored remote, so the token never lands in the clone's
 * config. The helper list is reset first so a machine-wide helper cannot answer before
 * gh, which reads GH_TOKEN from the child env only. No `--force`, `-f` or `+refspec`:
 * a push that is not fast-forward fails.
 */
export async function pushBranch(deps: { exec: Exec }, input: PushInput): Promise<void> {
  assertSafe(input.repo, 'repository name', REPO)
  assertSafe(input.branch, 'branch name', BRANCH)
  const token = await requireToken(deps.exec, input.ghAccount, { cwd: input.repoPath })
  const url = `https://github.com/${input.repo}.git`
  const refspec = `refs/heads/${input.branch}:refs/heads/${input.branch}`
  const result = await deps.exec(
    'git',
    ['-C', input.worktreePath, '-c', 'credential.helper=', '-c', CREDENTIAL_HELPER, 'push', url, refspec],
    // GIT_TERMINAL_PROMPT=0 makes a credential failure an error, not a hang on a prompt.
    { cwd: input.repoPath, env: { GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' } },
  )
  if (result.code !== 0) throw failure('git push', result, [token])
}

/** Makes the empty commit that is the claim, then pushes it. */
export async function pushEmptyClaim(deps: { exec: Exec }, input: PushInput & { message: string }): Promise<void> {
  assertSafe(input.branch, 'branch name', BRANCH)
  const commit = await deps.exec('git', ['-C', input.worktreePath, 'commit', '--allow-empty', '-m', input.message], {
    cwd: input.worktreePath,
  })
  if (commit.code !== 0) throw failure('git commit', commit)
  await pushBranch(deps, input)
}

/** Runs one gh subcommand as the account and returns its output and token. */
async function runGh(
  deps: { exec: Exec },
  ghAccount: string,
  args: string[],
  action: string,
): Promise<{ stdout: string; stderr: string; token: string }> {
  const token = await requireToken(deps.exec, ghAccount)
  const result = await deps.exec('gh', args, { env: { GH_TOKEN: token } })
  if (result.code !== 0) throw failure(action, result, [token])
  return { stdout: result.stdout, stderr: result.stderr, token }
}

/**
 * Opens the draft PR that makes the claim visible. The number comes from the URL
 * gh prints, so the caller needs no second lookup.
 */
export async function openDraftPr(
  deps: { exec: Exec },
  input: { repo: string; head: string; base: string; title: string; body: string; ghAccount: string },
): Promise<{ number: number; url: string }> {
  assertSafe(input.repo, 'repository name', REPO)
  assertSafe(input.head, 'branch name', BRANCH)
  assertSafe(input.base, 'branch name', BRANCH)
  const args = [
    'pr',
    'create',
    '--draft',
    '--repo',
    input.repo,
    '--head',
    input.head,
    '--base',
    input.base,
    '--title',
    input.title,
    '--body',
    input.body,
  ]
  const { stdout, stderr, token } = await runGh(deps, input.ghAccount, args, 'gh pr create')
  // gh prints the URL on stdout; older versions used stderr.
  const match = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/.exec(`${stdout}\n${stderr}`)
  if (match === null) {
    const printed = redact(stdout.trim(), [token])
    throw new Error(
      `gh pr create did not print a pull request URL for ${input.head}${printed === '' ? '' : `: ${printed}`}`,
    )
  }
  return { number: Number(match[1]), url: match[0] }
}

/** Replaces the body of an existing PR, for the validation report. */
export async function updatePrBody(
  deps: { exec: Exec },
  input: { repo: string; number: number; body: string; ghAccount: string },
): Promise<void> {
  assertSafe(input.repo, 'repository name', REPO)
  if (!Number.isInteger(input.number) || input.number <= 0) {
    throw new Error(`Invalid pull request number: ${input.number}`)
  }
  await runGh(
    deps,
    input.ghAccount,
    ['pr', 'edit', String(input.number), '--repo', input.repo, '--body', input.body],
    `gh pr edit ${input.number}`,
  )
}

/**
 * True when `text` names `identifier`, case-insensitively, without matching a
 * longer ticket that starts the same way (`INV-1` must not match `INV-12`).
 */
function mentions(text: string, identifier: string): boolean {
  if (identifier === '') return false
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(text)
}

const prList = z.array(
  z.object({
    number: z.number().int().positive(),
    headRefName: z.string(),
    title: z.string(),
    isDraft: z.boolean(),
    author: z.object({ login: z.string() }),
  }),
)

export type PullRequestSummary = {
  number: number
  headRefName: string
  title: string
  isDraft: boolean
  author: string
}

/**
 * Lists open PRs that mention the ticket in the branch or the title. The caller
 * applies the "not made by this instance" rule, so the author login is returned.
 */
export async function listOpenPrsForTicket(
  deps: { exec: Exec },
  input: { repo: string; identifier: string; ghAccount: string },
): Promise<PullRequestSummary[]> {
  assertSafe(input.repo, 'repository name', REPO)
  const args = [
    'pr',
    'list',
    '--repo',
    input.repo,
    '--state',
    'open',
    '--json',
    'number,headRefName,title,isDraft,author',
    '--limit',
    '100',
  ]
  const { stdout } = await runGh(deps, input.ghAccount, args, `gh pr list --repo ${input.repo}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`gh pr list --repo ${input.repo} did not return JSON`)
  }
  const prs = prList.safeParse(parsed)
  if (!prs.success) throw new Error(`gh pr list --repo ${input.repo} returned an unexpected shape`)

  return prs.data
    .filter((pr) => mentions(pr.headRefName, input.identifier) || mentions(pr.title, input.identifier))
    .map(({ author, ...pr }) => ({ ...pr, author: author.login }))
}
