// Pure: what the claim does about the pull requests already open for a ticket.

export type ClaimPr = { number: number; headRefName: string; title: string; isDraft: boolean; author: string }

export type ClaimInput = {
  identifier: string
  /** The account this instance acts as. */
  ghAccount: string
  branch: string
  /** Open PRs that name the ticket (the lookup already matched the identifier). */
  openPrs: readonly ClaimPr[]
  /** PR numbers steward stored on any job: the PRs it opened itself. */
  knownPrNumbers: ReadonlySet<number>
  /** The PR this job stored on an earlier attempt, if any. */
  jobPrNumber: number | null
}

export type ClaimDecision =
  { action: 'claim' } | { action: 'reuse'; number: number } | { action: 'skip'; reason: string }

/**
 * A PR by another account is ignored: a stranger can open a PR on a public repo and must not stall a
 * ticket. Of the PRs by our own account, the job's stored PR or any PR steward opened is reused; one
 * the owner opened by hand blocks the claim.
 */
export function decideClaim(input: ClaimInput): ClaimDecision {
  const account = input.ghAccount.toLowerCase()
  const own = input.openPrs.filter((pr) => pr.author.toLowerCase() === account)

  if (input.jobPrNumber !== null && own.some((pr) => pr.number === input.jobPrNumber)) {
    return { action: 'reuse', number: input.jobPrNumber }
  }
  const byHand = own.find((pr) => !input.knownPrNumbers.has(pr.number))
  if (byHand !== undefined) {
    return {
      action: 'skip',
      reason: `existing pull request #${byHand.number} for ${input.identifier} was opened by hand`,
    }
  }
  const steward = own[0]
  return steward === undefined ? { action: 'claim' } : { action: 'reuse', number: steward.number }
}
