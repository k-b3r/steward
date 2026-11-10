// One summary of everything waiting on a person, in plain English. Pure: no clock, no I/O and no
// tracker markup. The caller passes the jobs it already read and the time to age them against.
import type { Job, JobState } from './types'

type DigestItem = {
  identifier: string
  /** The ticket text, verbatim: the digest adds no markup and escapes nothing. */
  title: string
  state: JobState
  /** Whole days since the job row was created, never negative. */
  ageDays: number
  url: string
}

export type Digest = {
  counts: { proposals: number; reviewing: number; failed: number }
  /** Every waiting job, grouped: proposals, then reviewing, then failed. Oldest first in a group. */
  items: DigestItem[]
  /** One line per item. Empty: `Nothing is waiting on you.` */
  text: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const EMPTY_TEXT = 'Nothing is waiting on you.'
const TITLE_SEPARATOR = ': '

/**
 * The states that wait on a person, grouped. `proposed` waits for a confirm; `pr_open` and the
 * states after it wait on a person to read or merge the draft; `failed` waits on a person to
 * retry or drop it. Every other state is the orchestrator's or another system's business.
 */
const GROUPS = [
  { key: 'proposals', states: ['proposed'] },
  { key: 'reviewing', states: ['pr_open', 'in_review', 'changes_requested', 'ci_failed'] },
  { key: 'failed', states: ['failed'] },
] as const satisfies readonly { key: keyof Digest['counts']; states: readonly JobState[] }[]

type WaitingState = (typeof GROUPS)[number]['states'][number]

/** The jobs whose state is in `states`, narrowed to the states the groups name. */
type WaitingJob = Job & { state: WaitingState }

const isWaitingJob = (job: Job, states: readonly WaitingState[]): job is WaitingJob =>
  (states as readonly JobState[]).includes(job.state)

/**
 * Every state the digest reports, in the order the groups read them. The caller reads exactly these,
 * so a state added to a group is read without a second list to keep in step.
 */
export const WAITING_STATES: readonly WaitingState[] = GROUPS.flatMap((group) => group.states)

function ageInDays(createdAt: Date, now: Date): number {
  const elapsed = now.getTime() - createdAt.getTime()
  return elapsed <= 0 ? 0 : Math.floor(elapsed / DAY_MS)
}

function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`
}

/** What each waiting state asks of a person. A new waiting state needs an entry here. */
const PHRASES: Record<WaitingState, (age: string) => string> = {
  proposed: (age) => `draft waiting ${age}`,
  pr_open: (age) => `pull request open for ${age}`,
  in_review: (age) => `in review for ${age}`,
  changes_requested: (age) => `changes requested ${age} ago`,
  ci_failed: (age) => `checks failing for ${age}`,
  failed: (age) => `failed ${age} ago`,
}

function waitingFor(state: WaitingState, ageDays: number): string {
  return PHRASES[state](days(ageDays))
}

const byOldest = (a: { createdAt: Date; identifier: string }, b: { createdAt: Date; identifier: string }): number => {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime()
  if (byTime !== 0) return byTime
  return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0
}

/**
 * Builds the digest from the jobs it is given. Jobs in any other state are ignored, so the caller
 * may pass a broad read. The text is one line per item; a title that spans lines is folded onto
 * one, because a digest line is a whole item.
 */
export function buildDigest(input: { jobs: Job[]; now: Date }): Digest {
  const counts: Digest['counts'] = { proposals: 0, reviewing: 0, failed: 0 }
  const items: DigestItem[] = []
  const lines: string[] = []

  for (const group of GROUPS) {
    const waiting = input.jobs.filter((job): job is WaitingJob => isWaitingJob(job, group.states)).sort(byOldest)
    counts[group.key] = waiting.length

    for (const job of waiting) {
      const ageDays = ageInDays(job.createdAt, input.now)
      items.push({ identifier: job.identifier, title: job.title, state: job.state, ageDays, url: job.url })
      lines.push(
        `${job.identifier} ${job.title}${TITLE_SEPARATOR}${waitingFor(job.state, ageDays)}`.replace(/\s+/g, ' ').trim(),
      )
    }
  }

  return { counts, items, text: lines.length === 0 ? EMPTY_TEXT : lines.join('\n') }
}
