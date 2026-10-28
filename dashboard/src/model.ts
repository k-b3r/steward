// Presentation rules: how job states group and read in the UI.
import type { JobResponse } from './api'

type JobState = JobResponse['state']

export const STATE_LABEL: Record<JobState, string> = {
  proposed: 'Proposed',
  declined: 'Declined',
  queued: 'Queued',
  claiming: 'Claiming',
  running: 'Running',
  pr_open: 'PR open',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  merged: 'Merged',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATE_ICON: Record<JobState, string> = {
  proposed: 'i-proposed',
  declined: 'i-x',
  queued: 'i-queued',
  claiming: 'i-running',
  running: 'i-running',
  pr_open: 'i-pr_open',
  in_review: 'i-in_review',
  changes_requested: 'i-changes_requested',
  merged: 'i-merged',
  done: 'i-done',
  failed: 'i-failed',
  cancelled: 'i-cancelled',
}

export const stateIcon = (state: JobState): string => STATE_ICON[state]
// The design styles `.s-<state>`; states it has no colour for borrow a neighbour.
export const stateClass = (state: JobState): string =>
  state === 'claiming'
    ? 's-running'
    : state === 'proposed'
      ? 's-queued'
      : state === 'declined'
        ? 's-cancelled'
        : `s-${state}`
export const isSpinning = (state: JobState): boolean => state === 'running' || state === 'claiming'

export const LANES: { name: string; states: JobState[] }[] = [
  { name: 'Waiting', states: ['proposed', 'queued', 'claiming'] },
  { name: 'Working', states: ['running'] },
  { name: 'In review', states: ['pr_open', 'in_review', 'changes_requested'] },
  { name: 'Finished', states: ['merged', 'done', 'failed', 'cancelled', 'declined'] },
]

export const FILTERS: { name: string; states: JobState[] }[] = [
  { name: 'All', states: [] },
  { name: 'Active', states: ['queued', 'claiming', 'running'] },
  { name: 'Review', states: ['pr_open', 'in_review', 'changes_requested'] },
  { name: 'Proposed', states: ['proposed'] },
  { name: 'Failed', states: ['failed'] },
  { name: 'Done', states: ['merged', 'done'] },
]

export const RETRYABLE: JobState[] = ['failed', 'cancelled']
export const CANCELLABLE: JobState[] = ['queued', 'claiming', 'running', 'pr_open', 'in_review', 'changes_requested']

export function relativeTime(iso: string | null, now: number): string {
  if (iso === null) return '—'
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  const text = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`
  return seconds >= 0 ? `in ${text}` : `${text} ago`
}
