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

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
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
