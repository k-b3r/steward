// The claim: prove the identity, look at the open PRs for the ticket, then either reuse one, skip, or
// push an empty commit on the job branch and open a draft PR. Nothing here calls it yet. Every
// outside call goes through the injected Exec and store functions.
import { branchName } from './branch-name'
import { decideClaim } from './claim-policy'
import {
  checkIdentity,
  listOpenPrsForTicket,
  openDraftPr,
  pushEmptyClaim,
  remoteBranchExists,
  type Exec,
} from './platform/github'

/** The clone's identity is wrong. Never retried: the worker maps `kind` to a `setup` failure. */
export class ClaimSetupError extends Error {
  readonly kind = 'setup'

  constructor(message: string) {
    super(message)
    this.name = 'ClaimSetupError'
  }
}

export type ClaimDeps = {
  exec: Exec
  knownPullRequestNumbers: () => Promise<Set<number>>
  setJobPullRequest: (jobId: string, pr: { branch: string; number: number; url: string }) => Promise<void>
}

export type ClaimInput = {
  repoPath: string
  worktreePath: string
  /** `owner/name`. */
  repo: string
  baseBranch: string
  ghAccount: string
  gitName: string
  gitEmail: string
  job: { id: string; identifier: string; title: string; url: string; prNumber: number | null }
}

export type ClaimResult =
  | { kind: 'claimed'; number: number; url: string }
  | { kind: 'reused'; number: number; url: string }
  | { kind: 'skipped'; reason: string }

export const CLAIM_BODY_LINE = "Opened by steward. The agent's changes land here once they pass validation."

/**
 * The PR body holds the ticket link and one fixed line, nothing else from the ticket: a ticket body
 * is untrusted text and this PR can be public.
 */
function claimBody(ticketUrl: string): string {
  return `${ticketUrl}\n\n${CLAIM_BODY_LINE}`
}

export async function claimJob(deps: ClaimDeps, input: ClaimInput): Promise<ClaimResult> {
  const { exec } = deps
  const { job } = input

  const identity = await checkIdentity(
    { exec },
    {
      repoPath: input.repoPath,
      ghAccount: input.ghAccount,
      gitName: input.gitName,
      gitEmail: input.gitEmail,
    },
  )
  if (!identity.ok) throw new ClaimSetupError(identity.reason)

  const branch = branchName(job.identifier)
  const openPrs = await listOpenPrsForTicket(
    { exec },
    { repo: input.repo, identifier: job.identifier, ghAccount: input.ghAccount },
  )
  const decision = decideClaim({
    identifier: job.identifier,
    ghAccount: input.ghAccount,
    branch,
    openPrs,
    knownPrNumbers: await deps.knownPullRequestNumbers(),
    jobPrNumber: job.prNumber,
  })

  if (decision.action === 'skip') return { kind: 'skipped', reason: decision.reason }
  if (decision.action === 'reuse') {
    const url = `https://github.com/${input.repo}/pull/${decision.number}`
    if (job.prNumber !== decision.number) {
      await deps.setJobPullRequest(job.id, { branch, number: decision.number, url })
    }
    return { kind: 'reused', number: decision.number, url }
  }

  // A draft PR that failed after the push leaves the branch on the remote; pushing again would be
  // rejected, so the retry goes straight to the PR.
  const pushed = await remoteBranchExists(
    { exec },
    { repoPath: input.repoPath, repo: input.repo, branch, ghAccount: input.ghAccount },
  )
  if (!pushed) {
    await pushEmptyClaim(
      { exec },
      {
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        repo: input.repo,
        branch,
        ghAccount: input.ghAccount,
        message: `${job.identifier}: claim`,
      },
    )
  }
  const pr = await openDraftPr(
    { exec },
    {
      repo: input.repo,
      head: branch,
      base: input.baseBranch,
      title: `${job.identifier}: ${job.title}`,
      body: claimBody(job.url),
      ghAccount: input.ghAccount,
    },
  )
  await deps.setJobPullRequest(job.id, { branch, number: pr.number, url: pr.url })
  return { kind: 'claimed', number: pr.number, url: pr.url }
}
