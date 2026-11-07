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

// The reconnect position is the highest seq seen so far, not the position the resume plan was made
// with: a plan made before a long stream would replay everything it already showed.
describe('the position a reconnect uses', () => {
  it('grows while the stream is open, and a later plan starts from the newest seq', () => {
    let resume = planResume({ after: 0 }, 2).resume
    const seen = [1, 2, 3, 4] // envelopes delivered while the stream was open

    resume = { ...resume, after: Math.max(resume.after, ...seen) }

    expect(resume).toEqual({ run: 2, after: 4 })
    // A refusal for a *different* run starts over; the same run keeps the newest position.
    expect(planResume(resume, 2)).toEqual({ resume, restart: false })
    expect(planResume(resume, 3)).toEqual({ resume: { run: 3, after: 0 }, restart: true })
  })
})
