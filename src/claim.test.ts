import { describe, expect, it } from 'vitest'

import { ClaimSetupError, claimJob, CLAIM_BODY_LINE, type ClaimDeps, type ClaimInput } from './claim'
import type { Exec } from './platform/github'

const TOKEN = `ghp_${'a'.repeat(30)}`
type Call = { cmd: string; args: string[] }
type Reply = { code?: number; stdout?: string; stderr?: string }

type World = {
  prs?: { number: number; headRefName: string; title: string; isDraft: boolean; author: { login: string } }[]
  remoteHasBranch?: boolean
  identityOk?: boolean
  prCreate?: Reply
  known?: number[]
}

function setup(world: World = {}) {
  const calls: Call[] = []
  const stored: { jobId: string; pr: { branch: string; number: number; url: string } }[] = []
  let remote = world.remoteHasBranch ?? false
  let prCreate = world.prCreate ?? { stdout: 'https://github.com/k-b3r/steward-scratch/pull/12\n' }

  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args })
    const reply = ((): Reply => {
      if (cmd === 'gh' && args[0] === 'auth') return { stdout: `${TOKEN}\n` }
      // `gh api --paginate --slurp` prints one array per page, in the REST shape (decision 41).
      if (cmd === 'gh' && args[0] === 'api') {
        const page = (world.prs ?? []).map((pr) => ({
          number: pr.number,
          head: { ref: pr.headRefName },
          title: pr.title,
          draft: pr.isDraft,
          user: pr.author,
        }))
        return { stdout: JSON.stringify([page]) }
      }
      if (cmd === 'gh' && args[1] === 'create') return prCreate
      if (cmd === 'git' && args.includes('config')) {
        const key = args[args.length - 1]
        const bad = world.identityOk === false && key === 'user.name'
        const values: Record<string, string> = {
          'user.name': bad ? 'someone-else' : 'k-b3r',
          'user.email': 'dev@example.com',
          'steward.account': 'k-b3r',
        }
        return { stdout: `${values[key ?? ''] ?? ''}\n` }
      }
      if (cmd === 'git' && args.includes('ls-remote')) return { stdout: remote ? 'abc\trefs/heads/INV-78\n' : '' }
      if (cmd === 'git' && args.includes('push')) {
        remote = true
        return {}
      }
      return {}
    })()
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  const deps: ClaimDeps = {
    exec,
    knownPullRequestNumbers: async () => new Set(world.known ?? []),
    setJobPullRequest: async (jobId, pr) => {
      stored.push({ jobId, pr })
    },
  }
  return {
    deps,
    calls,
    stored,
    failNextPrCreate: (reply: Reply) => {
      prCreate = reply
    },
  }
}

const input: ClaimInput = {
  repoPath: '/clone',
  worktreePath: '/clone/wt/INV-78',
  repo: 'k-b3r/steward-scratch',
  baseBranch: 'main',
  ghAccount: 'k-b3r',
  gitName: 'k-b3r',
  gitEmail: 'dev@example.com',
  job: {
    id: 'job-1',
    identifier: 'INV-78',
    title: 'Fix the thing',
    url: 'https://linear.app/x/INV-78',
    prNumber: null,
  },
}

const ownPr = (number: number, over = {}) => ({
  number,
  headRefName: 'INV-78',
  title: 'INV-78: Fix the thing',
  isDraft: true,
  author: { login: 'k-b3r' },
  ...over,
})

const gitArgs = (calls: Call[], word: string) => calls.filter((c) => c.cmd === 'git' && c.args.includes(word))

describe('claimJob', () => {
  it('pushes an empty commit, opens a draft PR and stores it', async () => {
    const { deps, calls, stored } = setup()

    const result = await claimJob(deps, input)

    expect(result).toEqual({ kind: 'claimed', number: 12, url: 'https://github.com/k-b3r/steward-scratch/pull/12' })
    expect(gitArgs(calls, 'commit')[0]?.args).toContain('--allow-empty')
    expect(gitArgs(calls, 'push')).toHaveLength(1)
    expect(stored).toEqual([
      {
        jobId: 'job-1',
        pr: { branch: 'INV-78', number: 12, url: 'https://github.com/k-b3r/steward-scratch/pull/12' },
      },
    ])
  })

  it('titles the PR with the ticket and keeps the body to the link and one fixed line', async () => {
    const { deps, calls } = setup()

    await claimJob({ ...deps }, { ...input, job: { ...input.job, title: 'Fix it' } })

    const create = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create')?.args ?? []
    expect(create).toContain('--draft')
    expect(create[create.indexOf('--title') + 1]).toBe('INV-78: Fix it')
    expect(create[create.indexOf('--body') + 1]).toBe(`https://linear.app/x/INV-78\n\n${CLAIM_BODY_LINE}`)
    expect(create[create.indexOf('--base') + 1]).toBe('main')
    expect(create[create.indexOf('--head') + 1]).toBe('INV-78')
  })

  it('throws a setup error when the identity does not match, before any write', async () => {
    const { deps, calls } = setup({ identityOk: false })

    const error = await claimJob(deps, input).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ClaimSetupError)
    expect(error).toMatchObject({ kind: 'setup' })
    expect((error as Error).message).toContain('user.name')
    expect(gitArgs(calls, 'push')).toEqual([])
    expect(calls.some((c) => c.args[1] === 'list')).toBe(false)
  })

  it('skips, writing nothing, when the owner opened a PR for the ticket by hand', async () => {
    const { deps, calls, stored } = setup({ prs: [ownPr(30)], known: [5] })

    const result = await claimJob(deps, input)

    expect(result).toMatchObject({ kind: 'skipped' })
    expect(result.kind === 'skipped' && result.reason).toContain('#30')
    expect(gitArgs(calls, 'push')).toEqual([])
    expect(stored).toEqual([])
  })

  it("ignores another account's PR and claims", async () => {
    const stranger = ownPr(31, { author: { login: 'mallory' } })
    const { deps } = setup({ prs: [stranger] })

    expect(await claimJob(deps, input)).toMatchObject({ kind: 'claimed' })
  })

  it("reuses the job's stored PR without pushing or opening another", async () => {
    const { deps, calls, stored } = setup({ prs: [ownPr(12)], known: [12] })

    const result = await claimJob(deps, { ...input, job: { ...input.job, prNumber: 12 } })

    expect(result).toEqual({ kind: 'reused', number: 12, url: 'https://github.com/k-b3r/steward-scratch/pull/12' })
    expect(gitArgs(calls, 'push')).toEqual([])
    expect(calls.some((c) => c.args[1] === 'create')).toBe(false)
    expect(stored).toEqual([])
  })

  it("reuses a PR steward opened for another job's record and stores it on this job", async () => {
    const { deps, stored } = setup({ prs: [ownPr(12)], known: [12] })

    expect(await claimJob(deps, input)).toMatchObject({ kind: 'reused', number: 12 })
    expect(stored).toHaveLength(1)
  })

  it('does not push again after a push that was followed by a failed PR open', async () => {
    const { deps, calls, stored, failNextPrCreate } = setup()
    failNextPrCreate({ code: 1, stderr: 'HTTP 502' })

    await expect(claimJob(deps, input)).rejects.toThrow('gh pr create failed')
    expect(gitArgs(calls, 'push')).toHaveLength(1)
    expect(stored).toEqual([])

    failNextPrCreate({ stdout: 'https://github.com/k-b3r/steward-scratch/pull/12\n' })
    const result = await claimJob(deps, input)

    expect(result).toMatchObject({ kind: 'claimed', number: 12 })
    expect(gitArgs(calls, 'push')).toHaveLength(1)
    expect(gitArgs(calls, 'commit')).toHaveLength(1)
    expect(stored).toHaveLength(1)
  })

  it('never puts the token in an argument or an error', async () => {
    const { deps, calls, failNextPrCreate } = setup()
    failNextPrCreate({ code: 1, stderr: `bad credentials ${TOKEN}` })

    const error = await claimJob(deps, input).catch((e: unknown) => e)

    expect((error as Error).message).not.toContain(TOKEN)
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(TOKEN)
  })
})
