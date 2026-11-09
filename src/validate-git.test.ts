import { describe, expect, it } from 'vitest'

import { joinChangedFiles, parseDiffNameStatus, parseNumstat } from './validate-git'

// Hand-written `git diff --cached -M --name-status -z` and `--numstat -z` bytes: a NUL after each
// field, so a path with a space, a tab or a newline is one token and is never quoted.

describe('parseDiffNameStatus', () => {
  it('reads added, modified, deleted and renamed paths in the order git printed them', () => {
    const output = 'A\0src/new.ts\0M\0src/changed.ts\0D\0src/gone.ts\0R100\0src/old.ts\0src/moved.ts\0'

    expect(parseDiffNameStatus(output)).toEqual([
      { status: 'A', path: 'src/new.ts' },
      { status: 'M', path: 'src/changed.ts' },
      { status: 'D', path: 'src/gone.ts' },
      { status: 'R', path: 'src/moved.ts', oldPath: 'src/old.ts' },
    ])
    expect(parseDiffNameStatus('')).toEqual([])
  })

  it.each([
    ['M\0docs/my file.md\0', { status: 'M', path: 'docs/my file.md' }],
    ['A\0weird\nname.txt\0', { status: 'A', path: 'weird\nname.txt' }],
    ['C75\0src/a.ts\0src/b.ts\0', { status: 'A', path: 'src/b.ts' }],
    ['R\0a.ts\0b.ts\0', { status: 'R', path: 'b.ts', oldPath: 'a.ts' }],
    ['T\0src/link\0', { status: 'M', path: 'src/link' }],
    ['A\0src/new.ts', { status: 'A', path: 'src/new.ts' }],
  ])('reads %j', (record, expected) => {
    expect(parseDiffNameStatus(record)).toEqual([expected])
  })

  it.each(['R100\0src/old.ts\0', 'A\0'])('refuses output cut short: %j', (record) => {
    expect(() => parseDiffNameStatus(record)).toThrow(/truncated/)
  })
})

describe('parseNumstat', () => {
  it('reads counts per path, with a binary file and a rename keyed by its new path', () => {
    const counts = parseNumstat('3\t1\tsrc/new.ts\0-\t-\tlogo.png\0-\t-\t\0src/old.png\0src/new.png\0')

    expect(counts).toEqual(
      new Map([
        ['src/new.ts', { added: 3, deleted: 1 }],
        ['logo.png', { added: 0, deleted: 0 }],
        ['src/new.png', { added: 0, deleted: 0 }],
      ]),
    )
    expect(counts.has('src/old.png')).toBe(false)
    expect(parseNumstat('')).toEqual(new Map())
  })

  it('keeps a path with a space and a path with a newline', () => {
    const counts = parseNumstat('5\t0\tdocs/my file.md\0' + '1\t2\ta\nb.txt\0')

    expect(counts.get('docs/my file.md')).toEqual({ added: 5, deleted: 0 })
    expect(counts.get('a\nb.txt')).toEqual({ added: 1, deleted: 2 })
  })

  it.each(['src/new.ts\0', 'one\t0\tsrc/new.ts\0', '1.5\t0\tsrc/new.ts\0'])('refuses a bad record %j', (output) => {
    expect(() => parseNumstat(output)).toThrow(/numstat|line count/)
  })
})

describe('joinChangedFiles', () => {
  it('joins the counts to the status and both paths, and counts a missing one as 0/0', () => {
    const status = parseDiffNameStatus('A\0src/new.ts\0R100\0src/old.ts\0src/moved.ts\0A\0logo.png\0')
    const counts = parseNumstat('3\t1\tsrc/new.ts\0-\t-\t\0src/old.ts\0src/moved.ts\0')

    expect(joinChangedFiles(status, counts)).toEqual([
      { status: 'A', path: 'src/new.ts', added: 3, deleted: 1 },
      { status: 'R', path: 'src/moved.ts', oldPath: 'src/old.ts', added: 0, deleted: 0 },
      { status: 'A', path: 'logo.png', added: 0, deleted: 0 },
    ])
  })
})
