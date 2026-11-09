import { describe, expect, it } from 'vitest'

import { buildCheckRunArgs, type CheckRunInput } from './validate-command'

const BASE: CheckRunInput = {
  instance: 'personal',
  jobId: 'BUY-41',
  runNumber: 2,
  index: 1,
  image: 'steward-pi:1.5.0',
  worktreePath: '/home/kim/steward-instances/personal/runs/BUY-41/2/worktree',
  command: 'pnpm test',
  limits: { cpus: 2, memoryMb: 4096, pidsLimit: 512 },
}

const args = (overrides: Partial<CheckRunInput> = {}): string[] => buildCheckRunArgs({ ...BASE, ...overrides })

describe('buildCheckRunArgs', () => {
  it('builds the exact argv for one check', () => {
    // One line per group of flags; the command is appended separately, since it is one argument.
    const expected = [
      'run --rm --name steward-personal-check-BUY-41-2-1 --userns=keep-id',
      '--cpus=2 --memory=4096m --pids-limit=512 --cap-drop=ALL --security-opt=no-new-privileges',
      `--network=slirp4netns -v ${BASE.worktreePath}:/workspace:rw -w /workspace`,
      '--entrypoint sh steward-pi:1.5.0 -c',
    ].flatMap((line) => line.split(' '))

    expect(args()).toEqual([...expected, 'pnpm test'])
    // No -e and no --env: a check gets no model key and no credentials.
    expect(args().filter((arg) => arg === '-e' || arg.startsWith('--env'))).toEqual([])
  })

  it.each([
    [{ jobId: 'BUY 41' }],
    [{ jobId: '' }],
    [{ instance: 'Personal' }],
    [{ index: -1 }],
    [{ worktreePath: 'worktree' }],
    [{ worktreePath: '/runs/a:b' }],
    [{ worktreePath: '/runs/a\nb' }],
    [{ image: '--privileged' }],
    [{ command: '   ' }],
    [{ limits: { cpus: 0 } }],
  ])('refuses %j', (bad) => {
    const overrides = bad as Partial<CheckRunInput>
    const limits = { ...BASE.limits, ...overrides.limits }
    expect(() => args({ ...overrides, limits })).toThrow(RangeError)
  })
})
