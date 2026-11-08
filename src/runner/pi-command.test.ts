import { describe, expect, it } from 'vitest'

import { buildPiRunArgs, type PiRunInput } from './pi-command'

const BASE: PiRunInput = {
  instance: 'personal',
  jobId: 'BUY-41',
  runNumber: 1,
  image: 'steward-pi:1.5.0',
  worktreePath: '/home/kim/steward-instances/personal/runs/BUY-41/1/worktree',
  sessionDir: '/home/kim/steward-instances/personal/runs/BUY-41/1/session',
  prompt: 'Fix the failing test',
  passEnv: ['ANTHROPIC_API_KEY'],
  limits: { cpus: 2, memoryMb: 4096, pidsLimit: 512 },
  model: 'anthropic/claude-sonnet-5-5',
}

const pi = (overrides: Partial<PiRunInput> = {}): string[] => buildPiRunArgs({ ...BASE, ...overrides })

describe('buildPiRunArgs', () => {
  it('builds the exact argv for a fresh run', () => {
    expect(pi()).toEqual([
      'run',
      '--rm',
      '--name',
      'steward-personal-job-BUY-41-1',
      '--userns=keep-id',
      '--cpus=2',
      '--memory=4096m',
      '--pids-limit=512',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      '/home/kim/steward-instances/personal/runs/BUY-41/1/worktree:/workspace:rw',
      '-v',
      '/home/kim/steward-instances/personal/runs/BUY-41/1/session:/session:rw',
      '-w',
      '/workspace',
      '-e',
      'ANTHROPIC_API_KEY',
      'steward-pi:1.5.0',
      '-p',
      '--mode',
      'json',
      '--session-dir',
      '/session',
      '--model',
      'anthropic/claude-sonnet-5-5',
      '--',
      'Fix the failing test',
    ])
  })

  it('builds the exact argv for a resume, with --session and the prompt last', () => {
    expect(pi({ resumeSessionId: '01J8Z3Q4X0' })).toEqual([
      'run',
      '--rm',
      '--name',
      'steward-personal-job-BUY-41-1',
      '--userns=keep-id',
      '--cpus=2',
      '--memory=4096m',
      '--pids-limit=512',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      '/home/kim/steward-instances/personal/runs/BUY-41/1/worktree:/workspace:rw',
      '-v',
      '/home/kim/steward-instances/personal/runs/BUY-41/1/session:/session:rw',
      '-w',
      '/workspace',
      '-e',
      'ANTHROPIC_API_KEY',
      'steward-pi:1.5.0',
      '-p',
      '--mode',
      'json',
      '--session-dir',
      '/session',
      '--model',
      'anthropic/claude-sonnet-5-5',
      '--session',
      '01J8Z3Q4X0',
      '--',
      'Fix the failing test',
    ])
  })

  it('passes every env var by name only, never with a value', () => {
    const args = pi({ passEnv: ['ANTHROPIC_API_KEY', 'PI_CODING_AGENT_SESSION_DIR'] })
    expect(args.filter((arg, index) => args[index - 1] === '-e')).toEqual([
      'ANTHROPIC_API_KEY',
      'PI_CODING_AGENT_SESSION_DIR',
    ])
  })

  it('omits --model when no model is given', () => {
    expect(pi({ model: undefined })).not.toContain('--model')
  })

  it('keeps outbound network: the model API needs it', () => {
    // A container without network cannot reach the provider, so no --network=none.
    expect(pi().some((arg) => arg.startsWith('--network'))).toBe(false)
  })

  it('is a pure function of its input', () => {
    const input: PiRunInput = { ...BASE, passEnv: [...BASE.passEnv] }
    const first = buildPiRunArgs(input)
    const second = buildPiRunArgs(input)
    expect(first).toEqual(second)
    expect(input.passEnv).toEqual(['ANTHROPIC_API_KEY'])
  })
})

describe('buildPiRunArgs guards', () => {
  it.each(['anthropic_api_key', 'ANTHROPIC-KEY', '1ANTHROPIC', 'ANTHROPIC KEY', ''])(
    'refuses the env name %s, which is not an upper-case variable name',
    (name) => {
      expect(() => pi({ passEnv: [name] })).toThrow(RangeError)
    },
  )

  // The agent container never gets tracker or GitHub credentials; only the model key is allowed in.
  it.each(['GITHUB_TOKEN', 'GH_TOKEN', 'GH_ACCOUNT', 'LINEAR_API_KEY', 'SSH_AUTH_SOCK', 'GIT_AUTHOR_NAME'])(
    'refuses to pass %s into the agent container',
    (name) => {
      expect(() => pi({ passEnv: [name] })).toThrow(Error)
      expect(() => pi({ passEnv: [name] })).toThrow(new RegExp(name))
    },
  )

  it.each(['runs/BUY-41/worktree', './worktree'])('refuses the relative worktree path %s', (path) => {
    expect(() => pi({ worktreePath: path })).toThrow(RangeError)
  })

  it.each(['/runs/a:/b', '/runs/a\nb'])('refuses the worktree path %j', (path) => {
    expect(() => pi({ worktreePath: path })).toThrow(RangeError)
  })

  it.each(['session', '/runs/a:b', '/runs/a\nb'])('refuses the session dir %j', (path) => {
    expect(() => pi({ sessionDir: path })).toThrow(RangeError)
  })

  it.each(['BUY 41', 'BUY/41', 'BUY_41', ''])('refuses the job id %j', (jobId) => {
    expect(() => pi({ jobId })).toThrow(RangeError)
  })

  it.each(['Personal', '1personal', 'personal_x', '', 'a'.repeat(33)])('refuses the instance name %j', (instance) => {
    expect(() => pi({ instance })).toThrow(RangeError)
  })

  it.each([0, -1, 1.5, Number.NaN])('refuses the run number %s', (runNumber) => {
    expect(() => pi({ runNumber })).toThrow(RangeError)
  })

  it.each([
    { cpus: 0 },
    { cpus: 1.5 },
    { memoryMb: -1 },
    { memoryMb: Number.NaN },
    { pidsLimit: 0 },
    { pidsLimit: 2.5 },
  ])('refuses the limits %j', (bad) => {
    expect(() => pi({ limits: { ...BASE.limits, ...bad } })).toThrow(RangeError)
  })
})
