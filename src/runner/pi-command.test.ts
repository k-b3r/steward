import { describe, expect, it } from 'vitest'

import { buildPiRunArgs, MODEL_KEY_ENV_NAMES, type PiRunInput } from './pi-command'

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
      '--network=slirp4netns',
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
      '--network=slirp4netns',
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
    const args = pi({ passEnv: ['ANTHROPIC_API_KEY', 'OPENCODE_API_KEY'] })
    expect(args.filter((arg, index) => args[index - 1] === '-e')).toEqual(['ANTHROPIC_API_KEY', 'OPENCODE_API_KEY'])
  })

  it('allows the two model keys with no extra allowlist', () => {
    expect(MODEL_KEY_ENV_NAMES).toEqual(['OPENCODE_API_KEY', 'ANTHROPIC_API_KEY'])
    expect(() => pi({ passEnv: ['OPENCODE_API_KEY'] })).not.toThrow()
    expect(() => pi({ passEnv: ['ANTHROPIC_API_KEY'] })).not.toThrow()
  })

  it('forwards an extra name only when the caller lists it in extraAllowedEnv', () => {
    expect(pi({ passEnv: ['HIGH_LEVEL'], extraAllowedEnv: ['HIGH_LEVEL'] })).toContain('HIGH_LEVEL')
    expect(pi({ passEnv: ['DIGIT_COUNT'], extraAllowedEnv: ['DIGIT_COUNT'] })).toContain('DIGIT_COUNT')
  })

  it('accepts a pinned image reference with a registry, a digest and a tag', () => {
    expect(pi({ image: 'ghcr.io/k-b3r/steward-pi:1.5.0' })).toContain('ghcr.io/k-b3r/steward-pi:1.5.0')
    expect(pi({ image: 'localhost/steward-pi@sha256:abc123' })).toContain('localhost/steward-pi@sha256:abc123')
  })

  it('omits --model when no model is given', () => {
    expect(pi({ model: undefined })).not.toContain('--model')
  })

  it('keeps outbound network: the model API needs it', () => {
    // A container without network cannot reach the provider, so no --network=none.
    expect(pi()).not.toContain('--network=none')
    expect(pi()).not.toContain('--network=host')
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

  // The agent container's only credential is the model key: any other name is refused.
  it.each([
    'DATABASE_URL',
    'NPM_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GH_ACCOUNT',
    'LINEAR_API_KEY',
    'SSH_AUTH_SOCK',
    'GIT_AUTHOR_NAME',
    'STEWARD_API_TOKEN',
    'HIGH_LEVEL',
    'PI_CODING_AGENT_SESSION_DIR',
  ])('refuses to pass %s into the agent container when it is not allowlisted', (name) => {
    expect(() => pi({ passEnv: [name] })).toThrow(RangeError)
    expect(() => pi({ passEnv: [name] })).toThrow(new RegExp(name))
  })

  it.each([
    'DATABASE_URL',
    'NPM_TOKEN',
    'GITHUB_TOKEN',
    'STEWARD_API_TOKEN',
    'GH_TOKEN',
    'SSH_AUTH_SOCK',
    'GIT_AUTHOR_NAME',
  ])('refuses %s even when the caller lists it in extraAllowedEnv', (name) => {
    expect(() => pi({ passEnv: [name], extraAllowedEnv: [name] })).toThrow(new RegExp(name))
  })

  it.each([
    'GH_ACCOUNT',
    'GIT_SSH',
    'SSH_KEY',
    'MY_GITHUB_THING',
    'LINEAR_KEY',
    'REDIS_URL',
    'STEWARD_X',
    'MY_SECRET',
    'DB_PASSWORD',
    'API_TOKEN',
  ])('refuses the extraAllowedEnv name %s', (name) => {
    expect(() => pi({ extraAllowedEnv: [name] })).toThrow(RangeError)
  })

  it.each(['lower_case', 'WITH-DASH', '1DIGIT'])(
    'refuses the extraAllowedEnv name %s, which is not an upper-case variable name',
    (name) => {
      expect(() => pi({ extraAllowedEnv: [name] })).toThrow(RangeError)
    },
  )

  it.each(['-rm', ' steward-pi', 'steward pi', '', '--privileged', 'steward-pi;rm', 'steward\npi'])(
    'refuses the image %j, which would be read as a podman option or is malformed',
    (image) => {
      expect(() => pi({ image })).toThrow(RangeError)
    },
  )

  // `model` follows `--model`, so Pi decides whether a leading dash is a flag or a value.
  it.each(['-x', '--help', '--model', ' anthropic/claude-sonnet-5-5', 'anthropic/claude sonnet', ''])(
    'refuses the model %j, which Pi could read as a flag or is malformed',
    (model) => {
      expect(() => pi({ model })).toThrow(RangeError)
    },
  )

  it('accepts a provider/model pattern', () => {
    expect(pi({ model: 'opencode-go/deepseek-v4.1-flash' })).toContain('opencode-go/deepseek-v4.1-flash')
  })

  it.each(['-x', '--session', '-01J8Z3Q4X0', ' 01J8Z3Q4X0', '01J8Z3Q4X0 ', '01J8Z3/Q4', ''])(
    'refuses the resume session id %j, which Pi could read as a flag or is malformed',
    (resumeSessionId) => {
      expect(() => pi({ resumeSessionId })).toThrow(RangeError)
    },
  )

  it('accepts a uuid as the resume session id', () => {
    expect(pi({ resumeSessionId: '0193f2c1-7b4e-7a3c-9d21-6f8b0e5a2c47' })).toContain(
      '0193f2c1-7b4e-7a3c-9d21-6f8b0e5a2c47',
    )
  })

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

  it('uses slirp4netns, never host networking or the default pasta', () => {
    const args = buildPiRunArgs(BASE)
    expect(args).toContain('--network=slirp4netns')
    expect(args.filter((arg) => arg.startsWith('--network'))).toEqual(['--network=slirp4netns'])
  })
})
