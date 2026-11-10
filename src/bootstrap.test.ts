import { describe, expect, it } from 'vitest'

import { runnerEnv, secretsOf } from './bootstrap'
import type { Config } from './platform/config'

function config(overrides: Partial<Config> = {}): Config {
  return {
    INSTANCE: 'personal',
    DATABASE_URL: 'postgres://steward:pw@localhost:5432/steward_personal',
    REDIS_QUEUE_URL: 'redis://localhost:6379/0',
    REDIS_SLOT_URL: 'redis://localhost:6380/0',
    LINEAR_API_KEY: 'fake-linear-key',
    LINEAR_TEAM_KEY: 'TST',
    GH_ACCOUNT: 'k-b3r',
    GIT_USER_NAME: 'k-b3r',
    GIT_USER_EMAIL: 'dev.kimbermudez@gmail.com',
    API_TOKEN: 'token-0123456789abcdef0123456789abcdef',
    API_PORT: 3000,
    ALLOWED_ORIGINS: [],
    ALLOWED_HOSTS: [],
    SLOT_COUNT: 3,
    POLL_INTERVAL_MS: 30000,
    MAX_ENQUEUE_PER_POLL: 2,
    MAX_OPEN_PROPOSALS: 20,
    RUN_RETENTION_DAYS: 30,
    MAX_ATTEMPTS: 3,
    DRY_RUN: true,
    REPO_PATH: '/home/you/steward-instances/personal/repo',
    BASE_BRANCH: 'main',
    ALLOWED_STATUSES: ['In Progress'],
    RUNS_DIR: '/home/you/steward-instances/personal/runs',
    RUNNER: 'pi',
    PI_IMAGE: 'steward-pi:1.5.0',
    PI_TURN_CAP: 40,
    PI_TIMEOUT_MS: 1_200_000,
    PI_MODEL_API_KEY: 'sk-model-0123456789',
    PI_MODEL_API_KEY_ENV: 'OPENCODE_API_KEY',
    CLAIM_ENABLED: false,
    VALIDATION_ENABLED: false,
    LINEAR_WRITES_ENABLED: false,
    ...overrides,
  }
}

describe('runnerEnv', () => {
  it('maps the model key to the provider variable name, and nothing else', () => {
    expect(runnerEnv(config())).toEqual({ OPENCODE_API_KEY: 'sk-model-0123456789' })
    expect(runnerEnv(config({ PI_MODEL_API_KEY_ENV: 'ANTHROPIC_API_KEY' }))).toEqual({
      ANTHROPIC_API_KEY: 'sk-model-0123456789',
    })
  })

  it('is empty when no key is configured, as with the echo runner', () => {
    expect(runnerEnv(config({ PI_MODEL_API_KEY: undefined, RUNNER: 'echo' }))).toEqual({})
  })
})

describe('secretsOf', () => {
  it('includes the model key, so the logger and transcripts redact it', () => {
    expect(secretsOf(config())).toContain('sk-model-0123456789')
  })
})
