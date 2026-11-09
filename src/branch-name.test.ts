import { describe, expect, it } from 'vitest'

import { branchName } from './branch-name'

describe('branchName', () => {
  it('is the ticket identifier exactly as the tracker gave it', () => {
    expect(branchName('INV-12')).toBe('INV-12')
  })

  it('keeps the case of the identifier', () => {
    expect(branchName('Tst-ext-1')).toBe('Tst-ext-1')
  })

  it('replaces a character git does not allow in a branch name', () => {
    expect(branchName('INV 12:x')).toBe('INV-12-x')
  })

  it('drops a leading dash, which git would read as an option', () => {
    expect(branchName('-INV-12')).toBe('INV-12')
    expect(branchName('--INV-12')).toBe('INV-12')
  })

  it('throws when no name is left', () => {
    expect(() => branchName(' -: ')).toThrow(/no usable branch name/)
  })
})
