// Pure intake decisions. No clock, randomness, I/O or environment: the caller
// supplies the current jobs, the open proposal count and both caps.

import type { WorkItem } from './types'

type IntakeAction = 'queue' | 'propose'

type IntakeDecision = {
  /** The feed item, unchanged. */
  item: WorkItem
  /** `queue` creates a queued job and enqueues it; `propose` waits for a human confirm first. */
  action: IntakeAction
  /** Short tag the caller logs: the item's status name, `baseline` or `burst over cap`. */
  reason: string
}

type IntakeSkip = {
  /** The item that gets no job this poll. */
  item: WorkItem
  /** Short tag the caller logs: `already has a job`, `proposal limit` or `unknown status`. */
  reason: string
}

export type IntakeResult = {
  /** Items to act on, in feed order. */
  decisions: IntakeDecision[]
  /** Items that get no job, also in feed order. */
  skipped: IntakeSkip[]
}

/**
 * Everything `decideIntake` is allowed to know: the poll's items, the counts read before it and the caps to
 * apply. `runIntakePoll` in src/intake.ts assembles it from `IntakeStore` and `IntakeConfig`, which is what
 * keeps the policy free of clock, database and environment; the policy tests build it directly.
 */
export type IntakeInput = {
  /** One poll's items, in feed order; both output lists keep that order. */
  items: WorkItem[]
  /** Source ids that already have a job for this source, from `knownSourceIds`. */
  knownSourceIds: ReadonlySet<string>
  /** False on the first poll for a source, which turns In Progress items into the baseline. */
  sourceHasJobs: boolean
  /** Existing `proposed` jobs across all sources, from `countOpenProposals`. */
  openProposals: number
  /** Cap on open proposals; proposals made earlier in this poll count towards it too. */
  maxOpenProposals: number
  /** Above this many new In Progress items, every one of them becomes a proposal. */
  maxEnqueuePerPoll: number
}

const ALREADY_HAS_JOB = 'already has a job'
const BASELINE = 'baseline'
const BURST_OVER_CAP = 'burst over cap'
const PROPOSAL_LIMIT = 'proposal limit'
const UNKNOWN_STATUS = 'unknown status'
const IN_PROGRESS = 'In Progress'

function isProposalStatus(status: string): boolean {
  return status === 'Todo' || status === 'Backlog'
}

/**
 * Decides what to do with one poll of a feed. Input order is preserved in both
 * output lists. A proposal is skipped once `openProposals` plus proposals made
 * earlier in this poll reach `maxOpenProposals`; queueing is never capped there.
 */
export function decideIntake(input: IntakeInput): IntakeResult {
  const newInProgress = input.items.filter(
    (item) => !input.knownSourceIds.has(item.sourceId) && item.status === IN_PROGRESS,
  ).length
  const baseline = !input.sourceHasJobs
  const burstOverCap = newInProgress > input.maxEnqueuePerPoll

  const decisions: IntakeDecision[] = []
  const skipped: IntakeSkip[] = []
  let proposalsSoFar = 0

  const propose = (item: WorkItem, reason: string): void => {
    if (input.openProposals + proposalsSoFar >= input.maxOpenProposals) {
      skipped.push({ item, reason: PROPOSAL_LIMIT })
      return
    }
    decisions.push({ item, action: 'propose', reason })
    proposalsSoFar += 1
  }

  for (const item of input.items) {
    if (input.knownSourceIds.has(item.sourceId)) {
      skipped.push({ item, reason: ALREADY_HAS_JOB })
      continue
    }

    if (item.status === IN_PROGRESS) {
      if (baseline) {
        propose(item, BASELINE)
      } else if (burstOverCap) {
        propose(item, BURST_OVER_CAP)
      } else {
        decisions.push({ item, action: 'queue', reason: IN_PROGRESS })
      }
      continue
    }

    if (isProposalStatus(item.status)) {
      propose(item, item.status)
      continue
    }

    skipped.push({ item, reason: UNKNOWN_STATUS })
  }

  return { decisions, skipped }
}
