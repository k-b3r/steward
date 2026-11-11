import { describe, expect, it } from 'vitest'

import { decideClaim, type ClaimInput, type ClaimPr } from './claim-policy'

const pr = (over: Partial<ClaimPr> = {}): ClaimPr => ({
  number: 5,
  headRefName: 'INV-1',
  title: 'INV-1: thing',
  isDraft: true,
  author: 'k-b3r',
  ...over,
})

const input = (over: Partial<ClaimInput> = {}): ClaimInput => ({
  identifier: 'INV-1',
  ghAccount: 'k-b3r',
  branch: 'INV-1',
  openPrs: [],
  knownPrNumbers: new Set(),
  jobPrNumber: null,
  ...over,
})

describe('decideClaim', () => {
  it('claims when no PR is open', () => {
    expect(decideClaim(input())).toEqual({ action: 'claim' })
  })

  it("ignores a stranger's PR, even one with the exact ticket id", () => {
    const stranger = pr({ number: 9, author: 'mallory', headRefName: 'INV-1', title: 'INV-1' })

    expect(decideClaim(input({ openPrs: [stranger] }))).toEqual({ action: 'claim' })
    expect(decideClaim(input({ openPrs: [stranger], knownPrNumbers: new Set([9]) }))).toEqual({ action: 'claim' })
  })

  it('compares the author case-insensitively', () => {
    const own = pr({ author: 'K-B3R' })

    expect(decideClaim(input({ openPrs: [own] }))).toMatchObject({ action: 'skip' })
    expect(decideClaim(input({ openPrs: [own], knownPrNumbers: new Set([5]) }))).toEqual({
      action: 'reuse',
      number: 5,
    })
    expect(decideClaim(input({ ghAccount: 'K-b3R', openPrs: [pr()] }))).toMatchObject({ action: 'skip' })
  })

  it("reuses the job's stored PR while it is open", () => {
    expect(decideClaim(input({ openPrs: [pr({ number: 7 })], jobPrNumber: 7 }))).toEqual({ action: 'reuse', number: 7 })
  })

  it('does not reuse a stored PR that is no longer open', () => {
    expect(decideClaim(input({ jobPrNumber: 7 }))).toEqual({ action: 'claim' })
  })

  it("does not reuse a stored PR number that a stranger's open PR now carries", () => {
    expect(decideClaim(input({ openPrs: [pr({ number: 7, author: 'mallory' })], jobPrNumber: 7 }))).toEqual({
      action: 'claim',
    })
  })

  it('skips an own PR steward does not know, naming it', () => {
    const decision = decideClaim(input({ openPrs: [pr({ number: 12 })], knownPrNumbers: new Set([5]) }))

    expect(decision).toMatchObject({ action: 'skip' })
    expect(decision.action === 'skip' && decision.reason).toContain('#12')
  })

  it('reuses an own PR steward opened (a known number)', () => {
    expect(decideClaim(input({ openPrs: [pr({ number: 5 })], knownPrNumbers: new Set([5]) }))).toEqual({
      action: 'reuse',
      number: 5,
    })
  })

  it('skips when a hand-made PR sits next to a known one and the job has no stored PR', () => {
    const openPrs = [pr({ number: 5 }), pr({ number: 6 })]

    expect(decideClaim(input({ openPrs, knownPrNumbers: new Set([5]) }))).toMatchObject({ action: 'skip' })
  })
})
