import { describe, expect, it } from 'vitest'

import { planResume } from './log-resume'

describe('planResume', () => {
  it('keeps the position while the job still has no run', () => {
    expect(planResume({ after: 12 }, undefined)).toEqual({ resume: { after: 12 }, restart: false })
  })

  it('keeps the position when the lookup failed, which is not the same as no runs', () => {
    // The caller passes undefined for both; the decision is the same: change nothing.
    expect(planResume({ run: 2, after: 30 }, undefined)).toEqual({ resume: { run: 2, after: 30 }, restart: false })
  })

  it('switches to a run that appeared, from its first envelope', () => {
    expect(planResume({ after: 40 }, 1)).toEqual({ resume: { run: 1, after: 0 }, restart: true })
  })

  it('moves to a newer run only when the caller asks for it: the same run keeps its position', () => {
    expect(planResume({ run: 1, after: 40 }, 1)).toEqual({ resume: { run: 1, after: 40 }, restart: false })
  })

  it('starts a different run over, because the old seq belongs to the other one', () => {
    expect(planResume({ run: 1, after: 40 }, 2)).toEqual({ resume: { run: 2, after: 0 }, restart: true })
  })
})
