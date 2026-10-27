import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorktree, removeWorktree } from './git'

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' })
}

function createRepo(root: string): string {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  git(repoPath, ['init', '-b', 'main'])
  git(repoPath, ['config', 'user.name', 'Steward Test'])
  git(repoPath, ['config', 'user.email', 'steward-test@example.test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  git(repoPath, ['add', 'README.md'])
  git(repoPath, ['commit', '-m', 'initial commit'])
  return repoPath
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

describe('git worktrees', () => {
  let root: string
  let repoPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'steward-git-'))
    repoPath = createRepo(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a worktree on a new branch from HEAD', async () => {
    const worktreePath = join(root, 'worktree')

    await createWorktree({ repoPath, worktreePath, branch: 'agent/tst-1' })

    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
    expect(branchExists(repoPath, 'agent/tst-1')).toBe(true)
    expect(git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('agent/tst-1')
  })

  it('uses the requested base ref', async () => {
    git(repoPath, ['checkout', '-b', 'base'])
    writeFileSync(join(repoPath, 'base.txt'), 'base\n')
    git(repoPath, ['add', 'base.txt'])
    git(repoPath, ['commit', '-m', 'base commit'])
    git(repoPath, ['checkout', '-'])
    const worktreePath = join(root, 'from-base')

    await createWorktree({ repoPath, worktreePath, branch: 'agent/from-base', baseRef: 'base' })

    expect(existsSync(join(worktreePath, 'base.txt'))).toBe(true)
  })

  it('removes the worktree and tolerates a second removal', async () => {
    const worktreePath = join(root, 'worktree')
    await createWorktree({ repoPath, worktreePath, branch: 'agent/tst-1' })

    await removeWorktree(repoPath, worktreePath)

    expect(existsSync(worktreePath)).toBe(false)
    expect(git(repoPath, ['worktree', 'list', '--porcelain'])).not.toContain(worktreePath)
    await expect(removeWorktree(repoPath, worktreePath)).resolves.toBeUndefined()
  })

  it('clears stale metadata when the worktree directory is already gone', async () => {
    const worktreePath = join(root, 'worktree')
    await createWorktree({ repoPath, worktreePath, branch: 'agent/tst-1' })
    rmSync(worktreePath, { recursive: true, force: true })

    await removeWorktree(repoPath, worktreePath)
    await createWorktree({ repoPath, worktreePath, branch: 'agent/tst-2' })

    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
  })

  it('fails clearly when the same worktree is created twice', async () => {
    const worktreePath = join(root, 'worktree')
    await createWorktree({ repoPath, worktreePath, branch: 'agent/tst-1' })

    await expect(createWorktree({ repoPath, worktreePath, branch: 'agent/tst-2' })).rejects.toThrow(
      /worktree add .* failed:/s,
    )
    await expect(createWorktree({ repoPath, worktreePath, branch: 'agent/tst-2' })).rejects.toThrow(
      /already exists|is not empty/i,
    )
  })

  it('reuses the branch left by an earlier attempt and keeps its commits', async () => {
    const first = join(root, 'worktree-1')
    await createWorktree({ repoPath, worktreePath: first, branch: 'agent/tst-1' })
    writeFileSync(join(first, 'work.txt'), 'earlier attempt\n')
    git(first, ['add', 'work.txt'])
    git(first, ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-m', 'earlier work'])
    await removeWorktree(repoPath, first)

    const second = join(root, 'worktree-2')
    await createWorktree({ repoPath, worktreePath: second, branch: 'agent/tst-1' })

    expect(existsSync(join(second, 'work.txt'))).toBe(true)
  })

  it.each(['-evil', 'has space', 'has\ttab', 'has..dots', ''])('rejects the unsafe branch name %j', async (branch) => {
    const worktreePath = join(root, 'worktree')

    await expect(createWorktree({ repoPath, worktreePath, branch })).rejects.toThrow(/branch name/i)
    expect(existsSync(worktreePath)).toBe(false)
  })
})
