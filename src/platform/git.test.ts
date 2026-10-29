import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { abortMerge, attachWorktree, createWorktree, fetchBase, mergeIntoWorktree, removeWorktree } from './git'

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

  it('removes a directory that git does not know as a worktree, so the path can be used again', async () => {
    const worktreePath = join(root, 'half-made')
    mkdirSync(worktreePath)
    writeFileSync(join(worktreePath, 'debris.txt'), 'left by a crash\n')

    await removeWorktree(repoPath, worktreePath)

    expect(existsSync(worktreePath)).toBe(false)
    await createWorktree({ repoPath, worktreePath, branch: 'agent/tst-1' })
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true)
  })

  it('never deletes the clone itself or a folder that holds it', async () => {
    await expect(removeWorktree(repoPath, repoPath)).rejects.toThrow(/clone/i)
    await expect(removeWorktree(repoPath, root)).rejects.toThrow(/clone/i)

    expect(existsSync(join(repoPath, '.git'))).toBe(true)
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

describe('base ref and merge', () => {
  let root: string
  let bare: string
  let clone: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'steward-merge-'))
    bare = join(root, 'origin.git')
    git(root, ['init', '-q', '--bare', '-b', 'main', bare])
    clone = join(root, 'clone')
    git(root, ['clone', '-q', bare, clone])
    git(clone, ['config', 'user.name', 'Steward Test'])
    git(clone, ['config', 'user.email', 'steward-test@example.test'])
    writeFileSync(join(clone, 'README.md'), '# repo\n')
    git(clone, ['add', 'README.md'])
    git(clone, ['commit', '-qm', 'initial'])
    git(clone, ['push', '-q', 'origin', 'main'])
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function commitOnOrigin(file: string, body: string): void {
    const other = join(root, `other-${file}`)
    git(root, ['clone', '-q', bare, other])
    git(other, ['config', 'user.name', 'Other'])
    git(other, ['config', 'user.email', 'other@example.test'])
    writeFileSync(join(other, file), body)
    git(other, ['add', file])
    git(other, ['commit', '-qm', `add ${file}`])
    git(other, ['push', '-q', 'origin', 'main'])
  }

  it('fetches the base branch so a new worktree starts from origin, not a stale HEAD', async () => {
    await fetchBase(clone, 'origin', 'main')
    commitOnOrigin('remote.txt', 'from origin\n')
    await fetchBase(clone, 'origin', 'main')

    const worktreePath = join(root, 'wt')
    await createWorktree({ repoPath: clone, worktreePath, branch: 'agent/tst-1', baseRef: 'origin/main' })

    expect(existsSync(join(worktreePath, 'remote.txt'))).toBe(true)
  })

  it('attaches an existing branch, keeping its commits', async () => {
    git(clone, ['checkout', '-q', '-b', 'agent/tst-1'])
    writeFileSync(join(clone, 'work.txt'), 'earlier\n')
    git(clone, ['add', 'work.txt'])
    git(clone, ['commit', '-qm', 'earlier work'])
    git(clone, ['push', '-q', 'origin', 'agent/tst-1'])
    git(clone, ['checkout', '-q', 'main'])

    const worktreePath = join(root, 'wt')
    await attachWorktree({ repoPath: clone, worktreePath, branch: 'agent/tst-1' })

    expect(existsSync(join(worktreePath, 'work.txt'))).toBe(true)
  })

  it('refuses to attach a branch that does not exist', async () => {
    await expect(
      attachWorktree({ repoPath: clone, worktreePath: join(root, 'wt'), branch: 'agent/missing' }),
    ).rejects.toThrow(/agent\/missing/)
  })

  it('merges the base into an attached branch', async () => {
    git(clone, ['checkout', '-q', '-b', 'agent/tst-1'])
    writeFileSync(join(clone, 'work.txt'), 'earlier\n')
    git(clone, ['add', 'work.txt'])
    git(clone, ['commit', '-qm', 'earlier work'])
    git(clone, ['checkout', '-q', 'main'])
    commitOnOrigin('remote.txt', 'from origin\n')
    await fetchBase(clone, 'origin', 'main')

    const worktreePath = join(root, 'wt')
    await attachWorktree({ repoPath: clone, worktreePath, branch: 'agent/tst-1' })
    const outcome = await mergeIntoWorktree(worktreePath, 'origin/main')

    expect(outcome).toBe('merged')
    expect(existsSync(join(worktreePath, 'remote.txt'))).toBe(true)
  })

  it('reports a conflict and leaves the merge for the agent to resolve', async () => {
    git(clone, ['checkout', '-q', '-b', 'agent/tst-1'])
    writeFileSync(join(clone, 'README.md'), 'branch version\n')
    git(clone, ['add', 'README.md'])
    git(clone, ['commit', '-qm', 'branch change'])
    git(clone, ['checkout', '-q', 'main'])
    commitOnOrigin('README.md', 'main version\n')
    await fetchBase(clone, 'origin', 'main')

    const worktreePath = join(root, 'wt')
    await attachWorktree({ repoPath: clone, worktreePath, branch: 'agent/tst-1' })
    const outcome = await mergeIntoWorktree(worktreePath, 'origin/main')

    expect(outcome).toBe('conflict')
    expect(readFileSync(join(worktreePath, 'README.md'), 'utf8')).toContain('<<<<<<<')
  })

  it('can abort a conflicted merge', async () => {
    git(clone, ['checkout', '-q', '-b', 'agent/tst-1'])
    writeFileSync(join(clone, 'README.md'), 'branch version\n')
    git(clone, ['add', 'README.md'])
    git(clone, ['commit', '-qm', 'branch change'])
    git(clone, ['checkout', '-q', 'main'])
    commitOnOrigin('README.md', 'main version\n')
    await fetchBase(clone, 'origin', 'main')
    const worktreePath = join(root, 'wt')
    await attachWorktree({ repoPath: clone, worktreePath, branch: 'agent/tst-1' })
    await mergeIntoWorktree(worktreePath, 'origin/main')

    await abortMerge(worktreePath)

    expect(readFileSync(join(worktreePath, 'README.md'), 'utf8')).toBe('branch version\n')
  })

  it('reports up to date when the base is already merged in', async () => {
    const worktreePath = join(root, 'wt')
    await createWorktree({ repoPath: clone, worktreePath, branch: 'agent/tst-up', baseRef: 'origin/main' })

    expect(await mergeIntoWorktree(worktreePath, 'origin/main')).toBe('up-to-date')
  })
})
