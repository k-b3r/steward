import { describe, expect, it } from 'vitest'

import { branchName } from './branch-name'

describe('branchName', () => {
  it('puts the ticket identifier under agent/, lowercased', () => {
    expect(branchName('INV-12')).toBe('agent/inv-12')
  })

  it('replaces a character git does not allow in a branch name', () => {
    expect(branchName('INV 12:x')).toBe('agent/inv-12-x')
  })
})
