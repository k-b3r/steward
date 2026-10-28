// Git helpers. Every command runs through execFile with an argument array, never a
// shell string, so a path or branch name cannot inject a command.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Refuse a branch name that git could read as an option, or that breaks ref rules. */
function assertSafeBranch(branch: string): void {
  if (branch.length === 0) {
    throw new Error('Branch name must not be empty')
  }
  if (branch.startsWith('-')) {
    throw new Error(`Branch name must not start with "-": ${branch}`)
  }
  if (/\s/.test(branch)) {
    throw new Error(`Branch name must not contain whitespace: ${branch}`)
  }
  if (branch.includes('..')) {
    throw new Error(`Branch name must not contain "..": ${branch}`)
  }
}

/** Refs and remotes come from config; refuse anything that could be read as an option. */
function assertSafeRef(value: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.includes('..')) {
    throw new Error(`Unsafe git ref: ${value}`)
  }
}

function runGit(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout)
        return
      }
      const detail = stderr.trim() === '' ? error.message : stderr.trim()
      reject(new Error(`git ${args.join(' ')} failed: ${detail}`))
    })
  })
}

/**
 * Creates a git worktree at `worktreePath` on `branch`. A new branch is based on
 * `baseRef` (default `HEAD`); an existing branch is reused as it is. Throws when git rejects the request, for example because the
 * branch or the worktree path already exists.
 */
export async function createWorktree(opts: {
  repoPath: string
  worktreePath: string
  branch: string
  baseRef?: string
}): Promise<void> {
  assertSafeBranch(opts.branch)
  if (await branchExists(opts.repoPath, opts.branch)) {
    // A retry after a failed attempt: keep the branch and any commits on it.
    await runGit(['-C', opts.repoPath, 'worktree', 'add', opts.worktreePath, opts.branch])
    return
  }
  await runGit(['-C', opts.repoPath, 'worktree', 'add', '-b', opts.branch, opts.worktreePath, opts.baseRef ?? 'HEAD'])
}

/** Whether a local branch exists, so a run can continue it instead of creating one. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGit(['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Removes a worktree and forces it even when it has local changes. Removing an
 * already removed worktree is a no-op.
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) {
    // The directory can be gone while git still has its admin entry. Pruning
    // keeps a later worktree at the same path from being rejected as registered.
    await runGit(['-C', repoPath, 'worktree', 'prune'])
    return
  }
  await runGit(['-C', repoPath, 'worktree', 'remove', '--force', worktreePath])
}

/** Fetches one branch from a remote so a worktree can start from what is really on origin. */
export async function fetchBase(repoPath: string, remote: string, branch: string): Promise<void> {
  assertSafeRef(remote)
  assertSafeRef(branch)
  await runGit(['-C', repoPath, 'fetch', '--prune', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
}

/** Checks out an existing branch (an earlier attempt or an open pull request) into a new worktree. */
export async function attachWorktree(opts: { repoPath: string; worktreePath: string; branch: string }): Promise<void> {
  assertSafeBranch(opts.branch)
  if (!(await branchExists(opts.repoPath, opts.branch))) {
    throw new Error(`Branch ${opts.branch} does not exist in ${opts.repoPath}; it cannot be attached`)
  }
  await runGit(['-C', opts.repoPath, 'worktree', 'add', opts.worktreePath, opts.branch])
}

export type MergeOutcome = 'merged' | 'up-to-date' | 'conflict'

/**
 * Merges `ref` into the worktree's branch. A conflict is left in place, with markers, for the
 * agent to resolve; it is the one case where the work needs judgement. Nothing is pushed here.
 */
export async function mergeIntoWorktree(worktreePath: string, ref: string): Promise<MergeOutcome> {
  assertSafeRef(ref)
  const before = (await runGit(['-C', worktreePath, 'rev-parse', 'HEAD'])).trim()
  try {
    await runGit(['-C', worktreePath, 'merge', '--no-ff', '--no-edit', ref])
    // `git merge` exits 0 when there is nothing to merge, so compare the commit instead of the exit code.
    const after = (await runGit(['-C', worktreePath, 'rev-parse', 'HEAD'])).trim()
    return before === after ? 'up-to-date' : 'merged'
  } catch (error) {
    const unmerged = await runGit(['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U']).catch(() => '')
    if (unmerged.trim() !== '') return 'conflict'
    throw error
  }
}

/** Throws a conflicting merge away, leaving the branch as it was. */
export async function abortMerge(worktreePath: string): Promise<void> {
  await runGit(['-C', worktreePath, 'merge', '--abort'])
}
