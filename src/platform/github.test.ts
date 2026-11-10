import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Exec } from './github'
import {
  checkIdentity,
  createExecFileExec,
  listOpenPrsForTicket,
  openDraftPr,
  pushBranch,
  pushEmptyClaim,
  remoteBranchExists,
  updatePrBody,
} from './github'

// A real-looking token that must never reach args, a return value or a message.
const TOKEN = `ghp_${'a'.repeat(30)}`
const OTHER_TOKEN = `ghp_${'b'.repeat(25)}`
const [GIT_NAME, GIT_EMAIL, ACCOUNT, REPO, BRANCH] = [
  'k-b3r',
  'dev.kimbermudez@gmail.com',
  'k-b3r',
  'k-b3r/steward',
  'agent/INV-1',
]

type Call = { cmd: string; args: string[]; opts?: { cwd?: string; env?: Record<string, string> } }
type Reply = { code?: number; stdout?: string; stderr?: string }
const TOKEN_REPLY: Reply = { code: 0, stdout: `${TOKEN}\n` }

function fakeExec(reply: (cmd: string, args: string[]) => Reply): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const result = reply(cmd, args)
    return { code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  return { exec, calls }
}

/** The token lookup succeeds; every other gh subcommand answers `reply`. */
function ghExec(reply: (args: string[]) => Reply): { exec: Exec; calls: Call[] } {
  return fakeExec((cmd, args) => (cmd !== 'gh' ? {} : args[0] === 'auth' ? TOKEN_REPLY : reply(args)))
}

/** gh holds the token; a git push answers `pushReply`, a commit answers `commitReply`. */
function gitExec(commitReply: Reply = {}, pushReply: Reply = {}): { exec: Exec; calls: Call[] } {
  return fakeExec((cmd, args) => {
    if (cmd === 'gh') return TOKEN_REPLY
    if (args.includes('commit')) return commitReply
    return args.includes('push') ? pushReply : {}
  })
}

/** Awaits a call that must reject and returns the error, so its message can be inspected. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected the call to reject')
}

const identity = { 'user.name': GIT_NAME, 'user.email': GIT_EMAIL, 'steward.account': ACCOUNT }
const identityInput = { repoPath: '/clone', ghAccount: ACCOUNT, gitName: GIT_NAME, gitEmail: GIT_EMAIL }

function identityExec(
  overrides: Partial<typeof identity> = {},
  ghReply: Reply = TOKEN_REPLY,
): { exec: Exec; calls: Call[] } {
  const values: Record<string, string | undefined> = { ...identity, ...overrides }
  return fakeExec((cmd, args) => {
    if (cmd !== 'git') return ghReply
    const value = values[args[args.length - 1] ?? '']
    return value === undefined ? { code: 1, stderr: 'not found' } : { code: 0, stdout: `${value}\n` }
  })
}

const pushInput = {
  repoPath: '/clone',
  worktreePath: '/clone/worktrees/INV-1',
  repo: REPO,
  branch: BRANCH,
  ghAccount: ACCOUNT,
}
const prInput = {
  repo: REPO,
  head: BRANCH,
  base: 'main',
  title: 'INV-1: claim',
  body: 'Draft claim for INV-1',
  ghAccount: ACCOUNT,
}

describe('createExecFileExec', () => {
  it('resolves exit codes and output instead of throwing', async () => {
    const exec = createExecFileExec(process.env)
    const root = mkdtempSync(join(tmpdir(), 'steward-exec-'))
    try {
      const ok = await exec('git', ['--version'])
      const bad = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'refs/heads/nope'])
      const missing = await exec('steward-command-that-does-not-exist', [])

      expect(ok.code).toBe(0)
      expect(ok.stdout).toContain('git version')
      expect(bad.code).not.toBe(0)
      expect(missing.code).not.toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('merges the given env over the ambient environment it was built with', async () => {
    const script = 'process.stdout.write(`${process.env.STEWARD_PROBE}|${process.env.GH_TOKEN}`)'
    const exec = createExecFileExec({ PATH: process.env.PATH, STEWARD_PROBE: 'ambient' })

    const result = await exec(process.execPath, ['-e', script], { env: { GH_TOKEN: TOKEN } })

    expect(result.stdout).toBe(`ambient|${TOKEN}`)
  })
})

describe('checkIdentity', () => {
  it('passes when the clone config and the gh account match', async () => {
    const { exec, calls } = identityExec()

    await expect(checkIdentity({ exec }, identityInput)).resolves.toEqual({ ok: true })
    expect(calls.find((call) => call.cmd === 'gh')?.args).toEqual(['auth', 'token', '--user', ACCOUNT])
    for (const call of calls) expect(call.args).not.toContain(TOKEN)
    // Local only: a global author in ~/.gitconfig must not pass the check.
    for (const call of calls.filter((call) => call.cmd === 'git')) expect(call.args).toContain('--local')
  })

  const cases: [string, Partial<typeof identity>, Reply, RegExp][] = [
    ['a different author name', { 'user.name': 'Someone Else' }, TOKEN_REPLY, /user\.name/],
    ['a different author email', { 'user.email': 'other@example.test' }, TOKEN_REPLY, /user\.email/],
    ['a different steward.account', { 'steward.account': 'work' }, TOKEN_REPLY, /steward\.account/],
    ['an unset author name', { 'user.name': undefined }, TOKEN_REPLY, /user\.name.*not set/],
    [
      'an account gh cannot produce a token for',
      {},
      { code: 1, stdout: `${TOKEN}\n`, stderr: 'no oauth token' },
      /k-b3r.*not logged in/,
    ],
  ]

  it.each(cases)('reports %s as a setup failure that names the field', async (_label, overrides, reply, reason) => {
    const { exec } = identityExec(overrides, reply)

    const result = await checkIdentity({ exec }, identityInput)

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(reason) })
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})

describe('pushBranch', () => {
  it('pushes the branch to the repo URL with the token only in the child env', async () => {
    const { exec, calls } = gitExec()

    await pushBranch({ exec }, pushInput)

    const push = calls.find((call) => call.args.includes('push'))
    expect(push?.args).toEqual([
      '-C',
      pushInput.worktreePath,
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'push',
      `https://github.com/${REPO}.git`,
      `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
    ])
    expect(push?.args).not.toContain(TOKEN)
    expect(push?.opts?.env?.GH_TOKEN).toBe(TOKEN)
    const args = calls.flatMap((call) => call.args)
    expect(args).not.toContain('--force')
    expect(args).not.toContain('-f')
    expect(args.some((arg) => arg.startsWith('+'))).toBe(false)
  })

  it('redacts the token and token-shaped text from a failed push', async () => {
    const { exec } = gitExec({}, { code: 128, stderr: `rejected ${TOKEN} by ${OTHER_TOKEN}` })

    const error = await rejection(pushBranch({ exec }, pushInput))

    expect(error.message).toMatch(/git push failed \(exit 128\)/)
    expect(error.message).toContain('[REDACTED]')
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).not.toContain(OTHER_TOKEN)
  })

  it('refuses to push without a token for the account', async () => {
    const { exec, calls } = fakeExec(() => ({ code: 1, stdout: `${TOKEN}\n` }))

    const error = await rejection(pushBranch({ exec }, pushInput))

    expect(error.message).toMatch(/k-b3r.*not logged in/)
    expect(error.message).not.toContain(TOKEN)
    expect(calls.some((call) => call.args.includes('push'))).toBe(false)
  })

  // The branch goes into `refs/heads/<branch>` and onto the command line, so the set of names
  // is what git accepts in a ref and what cannot be read as an option.
  it.each([
    '-f',
    '.hidden',
    'agent/INV 1',
    'agent/INV..1',
    'agent/INV:1',
    'agent/INV~1',
    'agent/INV^1',
    'agent/INV?1',
    'agent/INV*1',
    'agent/INV[1',
    'agent/INV\\1',
    'agent/INV-1.',
    'agent/INV-1.lock',
    'agent/x.lock/y',
    'agent/.hidden',
    'agent//INV-1',
    '/agent/INV-1',
    'agent/INV-1/',
  ])('refuses the unsafe branch name %j before running anything', async (branch) => {
    const { exec, calls } = gitExec()

    await expect(pushBranch({ exec }, { ...pushInput, branch })).rejects.toThrow(/Unsafe branch name/)
    expect(calls).toHaveLength(0)
  })

  it('accepts the punctuation git allows in a ref', async () => {
    const { exec, calls } = gitExec()

    await pushBranch({ exec }, { ...pushInput, branch: 'release/1.2_fix-3' })

    expect(calls.some((call) => call.args.includes('push'))).toBe(true)
  })
})

describe('pushEmptyClaim', () => {
  it('makes an empty commit in the worktree and then pushes it', async () => {
    const { exec, calls } = gitExec()

    await pushEmptyClaim({ exec }, { ...pushInput, message: 'claim INV-1' })

    expect(calls[0]).toEqual({
      cmd: 'git',
      args: ['-C', pushInput.worktreePath, 'commit', '--allow-empty', '-m', 'claim INV-1'],
      opts: { cwd: pushInput.worktreePath },
    })
    expect(calls[0]?.opts?.env).toBeUndefined()
    expect(calls.findIndex((call) => call.args.includes('push'))).toBeGreaterThan(0)
  })

  it('does not push when the empty commit fails', async () => {
    const { exec, calls } = gitExec({ code: 1, stderr: 'could not commit' })

    await expect(pushEmptyClaim({ exec }, { ...pushInput, message: 'claim INV-1' })).rejects.toThrow(/commit.*failed/i)
    expect(calls.some((call) => call.args.includes('push'))).toBe(false)
  })
})

describe('openDraftPr', () => {
  it('creates a draft PR and reads its number from the printed URL', async () => {
    const { exec, calls } = ghExec(() => ({ stdout: `https://github.com/${REPO}/pull/42\n` }))

    await expect(openDraftPr({ exec }, prInput)).resolves.toEqual({
      number: 42,
      url: `https://github.com/${REPO}/pull/42`,
    })

    const create = calls.find((call) => call.args[1] === 'create')
    expect(create?.args).toEqual([
      'pr',
      'create',
      '--draft',
      '--repo',
      REPO,
      '--head',
      BRANCH,
      '--base',
      'main',
      '--title',
      'INV-1: claim',
      '--body',
      'Draft claim for INV-1',
    ])
    expect(create?.args).not.toContain(TOKEN)
    expect(create?.opts?.env?.GH_TOKEN).toBe(TOKEN)
  })

  it('reads a URL that gh printed on stderr', async () => {
    const { exec } = ghExec(() => ({ stderr: `https://github.com/${REPO}/pull/7\n` }))

    await expect(openDraftPr({ exec }, prInput)).resolves.toEqual({
      number: 7,
      url: `https://github.com/${REPO}/pull/7`,
    })
  })

  it('fails clearly without a URL and redacts a failed create', async () => {
    const noUrl = ghExec(() => ({ stdout: 'warning: something odd\n' }))
    await expect(openDraftPr({ exec: noUrl.exec }, prInput)).rejects.toThrow(/did not print a pull request URL/)

    const failed = ghExec(() => ({ code: 1, stderr: `could not create PR with ${TOKEN}` }))
    const error = await rejection(openDraftPr({ exec: failed.exec }, prInput))
    expect(error.message).toMatch(/gh pr create failed \(exit 1\)/)
    expect(error.message).not.toContain(TOKEN)
  })
})

describe('updatePrBody', () => {
  it('edits the PR body with the account token', async () => {
    const { exec, calls } = ghExec(() => ({}))

    await updatePrBody({ exec }, { repo: REPO, number: 42, body: 'Validation passed', ghAccount: ACCOUNT })

    const edit = calls.find((call) => call.args[1] === 'edit')
    expect(edit?.args).toEqual(['pr', 'edit', '42', '--repo', REPO, '--body', 'Validation passed'])
    expect(edit?.args).not.toContain(TOKEN)
    expect(edit?.opts?.env?.GH_TOKEN).toBe(TOKEN)

    const failed = ghExec(() => ({ code: 1, stderr: `no such PR ${TOKEN}` }))
    const error = await rejection(
      updatePrBody({ exec: failed.exec }, { repo: REPO, number: 42, body: 'x', ghAccount: ACCOUNT }),
    )
    expect(error.message).toMatch(/gh pr edit 42 failed \(exit 1\)/)
    expect(error.message).not.toContain(TOKEN)
  })
})

describe('listOpenPrsForTicket', () => {
  type RestPr = {
    number: number
    head: { ref: string }
    title: string
    draft: boolean
    user: { login: string }
  }
  const pr = (number: number, ref: string, title: string, draft: boolean, login: string): RestPr => ({
    number,
    head: { ref },
    title,
    draft,
    user: { login },
  })
  const prs = [
    pr(7, BRANCH, 'INV-1: claim', true, 'k-b3r'),
    pr(8, 'agent/INV-12', 'INV-12: other', false, 'k-b3r'),
    pr(9, 'agent/INV-3', 'fix [inv-1] in prose', true, 'them'),
    pr(10, 'agent/INV-3', 'XINV-1 is another ticket', false, 'them'),
    pr(11, 'agent/INV-1-keep-tokens', 'unrelated', true, 'them'),
  ]
  const input = { repo: REPO, identifier: 'INV-1', ghAccount: ACCOUNT }

  it('pages through every open PR and maps the REST fields to the summary shape', async () => {
    // Two pages, as `gh api --paginate --slurp` prints them: one array per page.
    const { exec, calls } = ghExec(() => ({ stdout: JSON.stringify([prs.slice(0, 4), prs.slice(4)]) }))

    const result = await listOpenPrsForTicket({ exec }, input)

    expect(result).toEqual([
      { number: 7, headRefName: BRANCH, title: 'INV-1: claim', isDraft: true, author: 'k-b3r' },
      { number: 9, headRefName: 'agent/INV-3', title: 'fix [inv-1] in prose', isDraft: true, author: 'them' },
      { number: 11, headRefName: 'agent/INV-1-keep-tokens', title: 'unrelated', isDraft: true, author: 'them' },
    ])
    const api = calls.find((call) => call.args[0] === 'api')
    expect(api?.args).toEqual(['api', '--paginate', '--slurp', `repos/${REPO}/pulls?state=open&per_page=100`])
    expect(api?.args).not.toContain(TOKEN)
    expect(api?.opts?.env?.GH_TOKEN).toBe(TOKEN)
    // A different ticket with the same prefix is not a match.
    await expect(listOpenPrsForTicket({ exec }, { ...input, identifier: 'INV-7' })).resolves.toEqual([])
    await expect(listOpenPrsForTicket({ exec }, { ...input, identifier: 'INV-12' })).resolves.toHaveLength(1)
  })

  it('keeps the word-boundary rule for title and branch matches', async () => {
    // A single page, as gh prints it when it does not have to slurp more than one.
    const { exec } = ghExec(() => ({ stdout: JSON.stringify(prs) }))

    await expect(listOpenPrsForTicket({ exec }, input)).resolves.toHaveLength(3)
    await expect(listOpenPrsForTicket({ exec }, { ...input, identifier: 'INV-12' })).resolves.toEqual([
      { number: 8, headRefName: 'agent/INV-12', title: 'INV-12: other', isDraft: false, author: 'k-b3r' },
    ])
  })

  it('treats regex characters in an identifier literally', async () => {
    const miss = ghExec(() => ({ stdout: JSON.stringify([[{ ...prs[0], title: 'AxB ticket' }]]) }))
    await expect(listOpenPrsForTicket({ exec: miss.exec }, { ...input, identifier: 'A.B' })).resolves.toEqual([])

    const hit = ghExec(() => ({ stdout: JSON.stringify([[{ ...prs[0], title: 'fix A.B now' }]]) }))
    await expect(listOpenPrsForTicket({ exec: hit.exec }, { ...input, identifier: 'A.B' })).resolves.toHaveLength(1)
  })

  it('fails clearly on bad JSON and redacts a failed list', async () => {
    const bad = ghExec(() => ({ stdout: 'not json' }))
    await expect(listOpenPrsForTicket({ exec: bad.exec }, input)).rejects.toThrow(/did not return JSON/)

    const wrongShape = ghExec(() => ({ stdout: JSON.stringify([[{ number: 1 }]]) }))
    await expect(listOpenPrsForTicket({ exec: wrongShape.exec }, input)).rejects.toThrow(/unexpected shape/)

    const failed = ghExec(() => ({ code: 1, stderr: `HTTP 401 for ${TOKEN}` }))
    const error = await rejection(listOpenPrsForTicket({ exec: failed.exec }, input))
    expect(error.message).not.toContain(TOKEN)
  })
})

describe('the token stays out of arguments across a whole claim', () => {
  it('passes the token only as GH_TOKEN on the gh calls', async () => {
    const { exec, calls } = fakeExec((cmd, args) => {
      if (cmd === 'gh' && args[0] === 'auth') return TOKEN_REPLY
      if (cmd === 'gh' && args[1] === 'create') return { stdout: `https://github.com/${REPO}/pull/5\n` }
      return {}
    })

    await pushEmptyClaim({ exec }, { ...pushInput, message: 'claim INV-1' })
    await openDraftPr({ exec }, prInput)
    await updatePrBody({ exec }, { repo: REPO, number: 5, body: 'done', ghAccount: ACCOUNT })

    expect(calls).not.toContainEqual(expect.objectContaining({ args: expect.arrayContaining([TOKEN]) }))
    expect(calls.find((call) => call.args.includes('commit'))?.opts?.env?.GH_TOKEN).toBeUndefined()
    const gh = calls.filter((call) => call.cmd === 'gh')
    expect(gh.filter((call) => call.args[0] === 'auth')).toHaveLength(3)
    for (const call of gh.filter((call) => call.args[0] !== 'auth')) expect(call.opts?.env?.GH_TOKEN).toBe(TOKEN)
  })
})

describe('remoteBranchExists', () => {
  const input = { repoPath: '/clone', repo: REPO, branch: BRANCH, ghAccount: ACCOUNT }
  const lsExec = (reply: Reply) => fakeExec((cmd) => (cmd === 'gh' ? TOKEN_REPLY : reply))

  it('is true when ls-remote prints the ref, false when it prints nothing', async () => {
    const present = lsExec({ stdout: `abc123\trefs/heads/${BRANCH}\n` })
    const absent = lsExec({})

    await expect(remoteBranchExists({ exec: present.exec }, input)).resolves.toBe(true)
    await expect(remoteBranchExists({ exec: absent.exec }, input)).resolves.toBe(false)
  })

  it('asks for exactly that ref with the token only in the env', async () => {
    const { exec, calls } = lsExec({})

    await remoteBranchExists({ exec }, input)

    const call = calls.find((c) => c.cmd === 'git')
    expect(call?.args).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      'ls-remote',
      '--heads',
      `https://github.com/${REPO}.git`,
      `refs/heads/${BRANCH}`,
    ])
    expect(call?.opts?.env).toEqual({ GH_TOKEN: TOKEN, GIT_TERMINAL_PROMPT: '0' })
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(TOKEN)
  })

  it('throws, redacted, when ls-remote fails instead of reading it as absent', async () => {
    const { exec } = lsExec({ code: 128, stderr: `fatal: could not read ${TOKEN}` })

    const error = await rejection(remoteBranchExists({ exec }, input))

    expect(error.message).toContain('git ls-remote failed (exit 128)')
    expect(error.message).not.toContain(TOKEN)
  })

  it('refuses an unsafe branch or repo before running anything', async () => {
    const { exec, calls } = lsExec({})

    await rejection(remoteBranchExists({ exec }, { ...input, branch: '--upload-pack=x' }))
    await rejection(remoteBranchExists({ exec }, { ...input, repo: 'a b' }))

    expect(calls).toEqual([])
  })
})
