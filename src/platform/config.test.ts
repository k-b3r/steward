import { describe, expect, it } from 'vitest'

import { instanceNames, loadConfig, redactConfig } from './config'
import type { Config } from './config'

const SECRET_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'REDIS_QUEUE_URL',
  'REDIS_SLOT_URL',
  'LINEAR_API_KEY',
  'API_TOKEN',
]

const BASE_ENV: Record<string, string> = {
  INSTANCE: 'personal',
  DATABASE_URL: 'postgres://steward:pw@localhost:5432/steward_personal',
  TEST_DATABASE_URL: 'postgres://steward:pw@localhost:5432/steward_personal_test',
  REDIS_QUEUE_URL: 'redis://localhost:6379/0',
  REDIS_SLOT_URL: 'redis://localhost:6380/0',
  LINEAR_API_KEY: 'lin_api_0123456789',
  LINEAR_TEAM_KEY: 'TST',
  API_TOKEN: 'token-0123456789abcdef0123456789abcdef',
  REPO_PATH: '/home/you/Develop/scratch-repo',
  HOME: '/home/you',
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...BASE_ENV, ...overrides }
}

function errorMessage(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw')
}

describe('loadConfig', () => {
  it('applies the documented defaults when only required values are set', () => {
    const config = loadConfig(env())

    expect(config.API_PORT).toBe(3000)
    expect(config.ALLOWED_ORIGINS).toEqual([])
    expect(config.SLOT_COUNT).toBe(3)
    expect(config.POLL_INTERVAL_MS).toBe(30000)
    expect(config.MAX_ENQUEUE_PER_POLL).toBe(2)
    expect(config.MAX_OPEN_PROPOSALS).toBe(20)
    expect(config.RUN_RETENTION_DAYS).toBe(30)
    expect(config.MAX_ATTEMPTS).toBe(3)
    expect(config.DRY_RUN).toBe(true)
    expect(config.RUNS_DIR).toBe('/home/you/runs/personal')
  })

  it('coerces numeric strings and trims origins', () => {
    const config = loadConfig(
      env({
        API_PORT: '4321',
        ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:5173',
        SLOT_COUNT: '5',
        POLL_INTERVAL_MS: '1500',
        MAX_ENQUEUE_PER_POLL: '1',
        MAX_OPEN_PROPOSALS: '4',
        RUN_RETENTION_DAYS: '7',
        MAX_ATTEMPTS: '6',
      }),
    )

    expect(config.API_PORT).toBe(4321)
    expect(config.ALLOWED_ORIGINS).toEqual(['https://app.example.com', 'http://localhost:5173'])
    expect(config.SLOT_COUNT).toBe(5)
    expect(config.POLL_INTERVAL_MS).toBe(1500)
    expect(config.MAX_ENQUEUE_PER_POLL).toBe(1)
    expect(config.MAX_OPEN_PROPOSALS).toBe(4)
    expect(config.RUN_RETENTION_DAYS).toBe(7)
    expect(config.MAX_ATTEMPTS).toBe(6)
  })

  it('accepts the inclusive boundaries of every numeric range', () => {
    const low = loadConfig(
      env({
        API_PORT: '1024',
        SLOT_COUNT: '1',
        POLL_INTERVAL_MS: '1000',
        MAX_ENQUEUE_PER_POLL: '0',
        MAX_OPEN_PROPOSALS: '1',
        RUN_RETENTION_DAYS: '1',
        MAX_ATTEMPTS: '1',
      }),
    )
    const high = loadConfig(env({ API_PORT: '65535', SLOT_COUNT: '16' }))

    expect([low.API_PORT, low.SLOT_COUNT, low.POLL_INTERVAL_MS, low.MAX_ENQUEUE_PER_POLL]).toEqual([1024, 1, 1000, 0])
    expect([low.MAX_OPEN_PROPOSALS, low.RUN_RETENTION_DAYS, low.MAX_ATTEMPTS]).toEqual([1, 1, 1])
    expect([high.API_PORT, high.SLOT_COUNT]).toEqual([65535, 16])
  })

  it.each([
    ['INSTANCE missing', { INSTANCE: undefined }, 'INSTANCE'],
    ['INSTANCE starts with a number', { INSTANCE: '1personal' }, 'INSTANCE'],
    ['INSTANCE has uppercase', { INSTANCE: 'Personal' }, 'INSTANCE'],
    ['INSTANCE is too long', { INSTANCE: `a${'b'.repeat(31)}` }, 'INSTANCE'],
    ['DATABASE_URL missing', { DATABASE_URL: undefined }, 'DATABASE_URL'],
    ['REDIS_QUEUE_URL missing', { REDIS_QUEUE_URL: undefined }, 'REDIS_QUEUE_URL'],
    ['REDIS_SLOT_URL missing', { REDIS_SLOT_URL: undefined }, 'REDIS_SLOT_URL'],
    ['LINEAR_API_KEY missing', { LINEAR_API_KEY: undefined }, 'LINEAR_API_KEY'],
    ['LINEAR_TEAM_KEY empty', { LINEAR_TEAM_KEY: '' }, 'LINEAR_TEAM_KEY'],
    ['API_TOKEN missing', { API_TOKEN: undefined }, 'API_TOKEN'],
    ['API_TOKEN too short', { API_TOKEN: 'token-too-short'.padEnd(31, 'x') }, 'API_TOKEN'],
    ['API_PORT not numeric', { API_PORT: '3000abc' }, 'API_PORT'],
    ['API_PORT empty', { API_PORT: '' }, 'API_PORT'],
    ['API_PORT not an integer', { API_PORT: '3000.5' }, 'API_PORT'],
    ['API_PORT below range', { API_PORT: '80' }, 'API_PORT'],
    ['API_PORT above range', { API_PORT: '70000' }, 'API_PORT'],
    ['SLOT_COUNT below range', { SLOT_COUNT: '0' }, 'SLOT_COUNT'],
    ['SLOT_COUNT above range', { SLOT_COUNT: '17' }, 'SLOT_COUNT'],
    ['POLL_INTERVAL_MS below range', { POLL_INTERVAL_MS: '999' }, 'POLL_INTERVAL_MS'],
    ['POLL_INTERVAL_MS not numeric', { POLL_INTERVAL_MS: 'soon' }, 'POLL_INTERVAL_MS'],
    ['MAX_ENQUEUE_PER_POLL below range', { MAX_ENQUEUE_PER_POLL: '-1' }, 'MAX_ENQUEUE_PER_POLL'],
    ['MAX_OPEN_PROPOSALS below range', { MAX_OPEN_PROPOSALS: '0' }, 'MAX_OPEN_PROPOSALS'],
    ['RUN_RETENTION_DAYS below range', { RUN_RETENTION_DAYS: '0' }, 'RUN_RETENTION_DAYS'],
    ['MAX_ATTEMPTS below range', { MAX_ATTEMPTS: '0' }, 'MAX_ATTEMPTS'],
    ['REPO_PATH missing', { REPO_PATH: undefined }, 'REPO_PATH'],
    ['REPO_PATH relative', { REPO_PATH: 'scratch-repo' }, 'REPO_PATH'],
    ['RUNS_DIR and HOME both missing', { RUNS_DIR: undefined, HOME: undefined }, 'RUNS_DIR'],
    ['ALLOWED_ORIGINS not a URL', { ALLOWED_ORIGINS: 'not-a-url' }, 'ALLOWED_ORIGINS'],
    ['ALLOWED_ORIGINS has a path', { ALLOWED_ORIGINS: 'https://example.com/api' }, 'ALLOWED_ORIGINS'],
    [
      'ALLOWED_ORIGINS has an empty entry',
      { ALLOWED_ORIGINS: 'https://example.com,,http://localhost' },
      'ALLOWED_ORIGINS',
    ],
  ])('rejects %s', (_name, overrides, key) => {
    expect(errorMessage(() => loadConfig(env(overrides)))).toContain(key)
  })

  it.each(SECRET_KEYS)('rejects the secret %s when it appears in the config file', (key) => {
    const message = errorMessage(() => loadConfig(env(), { [key]: 'from-a-file' }))

    expect(message).toContain(key)
    expect(message).not.toContain('from-a-file')
  })

  it('reads non-secret values from the config file when env does not set them', () => {
    const config = loadConfig(
      {
        DATABASE_URL: BASE_ENV.DATABASE_URL,
        REDIS_QUEUE_URL: BASE_ENV.REDIS_QUEUE_URL,
        REDIS_SLOT_URL: BASE_ENV.REDIS_SLOT_URL,
        LINEAR_API_KEY: BASE_ENV.LINEAR_API_KEY,
        API_TOKEN: BASE_ENV.API_TOKEN,
        HOME: '/home/file-user',
      },
      {
        INSTANCE: 'from-file',
        LINEAR_TEAM_KEY: 'FIL',
        REPO_PATH: '/tmp/from-file',
        SLOT_COUNT: 4,
        ALLOWED_ORIGINS: ['https://file.example.com'],
      },
    )

    expect(config.INSTANCE).toBe('from-file')
    expect(config.LINEAR_TEAM_KEY).toBe('FIL')
    expect(config.REPO_PATH).toBe('/tmp/from-file')
    expect(config.SLOT_COUNT).toBe(4)
    expect(config.ALLOWED_ORIGINS).toEqual(['https://file.example.com'])
    expect(config.RUNS_DIR).toBe('/home/file-user/runs/from-file')
  })

  it('lets env values win over config file values', () => {
    const config = loadConfig(env({ INSTANCE: 'from-env', SLOT_COUNT: '2' }), {
      INSTANCE: 'from-file',
      SLOT_COUNT: 8,
      LINEAR_TEAM_KEY: 'FIL',
      REPO_PATH: '/tmp/from-file',
    })

    expect(config.INSTANCE).toBe('from-env')
    expect(config.SLOT_COUNT).toBe(2)
    expect(config.LINEAR_TEAM_KEY).toBe('TST')
    expect(config.REPO_PATH).toBe(BASE_ENV.REPO_PATH)
  })

  it('refuses to share one Redis instance between the queue and slot roles', () => {
    const redisUrl = 'redis://localhost:6379/0'
    const message = errorMessage(() => loadConfig(env({ REDIS_QUEUE_URL: redisUrl, REDIS_SLOT_URL: redisUrl })))

    expect(message).toContain('REDIS_QUEUE_URL')
    expect(message).toContain('REDIS_SLOT_URL')
    expect(message).not.toContain(redisUrl)
  })

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses DRY_RUN=%s as %s', (value, expected) => {
    expect(loadConfig(env({ DRY_RUN: value })).DRY_RUN).toBe(expected)
  })

  it.each(['TRUE', 'yes', 'on', '2', ''])('rejects DRY_RUN=%s', (value) => {
    expect(errorMessage(() => loadConfig(env({ DRY_RUN: value })))).toContain('DRY_RUN')
  })

  it('defaults ALLOWED_ORIGINS to an empty list for an empty string', () => {
    expect(loadConfig(env({ ALLOWED_ORIGINS: '' })).ALLOWED_ORIGINS).toEqual([])
  })

  it('uses RUNS_DIR from env without requiring HOME', () => {
    const config = loadConfig(env({ HOME: undefined, RUNS_DIR: '/srv/steward/runs' }))

    expect(config.RUNS_DIR).toBe('/srv/steward/runs')
  })

  it('never includes a secret value in a validation error', () => {
    const apiToken = 'UNIQUE_API_TOKEN_VALUE_0123456789abcdef'
    const databaseUrl = 'postgres://UNIQUE_DB_PASSWORD@localhost:5432/steward'
    const message = errorMessage(() =>
      loadConfig(env({ API_TOKEN: apiToken, DATABASE_URL: databaseUrl, API_PORT: 'not-a-number' })),
    )

    expect(message).toContain('API_PORT')
    expect(message).not.toContain(apiToken)
    expect(message).not.toContain(databaseUrl)
    expect(message).not.toContain('UNIQUE_DB_PASSWORD')
  })

  it('redacts every secret in redactConfig and leaves the rest intact', () => {
    const config = loadConfig(env())
    const redacted = redactConfig(config)

    for (const key of SECRET_KEYS) {
      expect(redacted[key]).toBe('[REDACTED]')
    }
    expect(redacted.INSTANCE).toBe('personal')
    expect(redacted.API_PORT).toBe(3000)
    expect(redacted.DRY_RUN).toBe(true)
    expect(redacted.RUNS_DIR).toBe('/home/you/runs/personal')
    expect(redacted.TEST_DATABASE_URL).toBe('[REDACTED]')

    const serialized = JSON.stringify(redacted)
    for (const secret of [
      config.DATABASE_URL,
      config.TEST_DATABASE_URL,
      config.REDIS_QUEUE_URL,
      config.REDIS_SLOT_URL,
      config.LINEAR_API_KEY,
      config.API_TOKEN,
    ]) {
      expect(secret).toBeDefined()
      expect(serialized).not.toContain(secret as string)
    }
  })

  it('omits an absent optional TEST_DATABASE_URL from redactConfig', () => {
    const config = loadConfig(env({ TEST_DATABASE_URL: undefined }))
    const redacted = redactConfig(config) as Partial<Config> & Record<string, unknown>

    expect(redacted.TEST_DATABASE_URL).toBeUndefined()
  })
})

describe('instanceNames', () => {
  it('derives the unit, database and network names from the instance', () => {
    expect(instanceNames('personal')).toEqual({
      unit: 'steward@personal',
      dbName: 'steward_personal',
      redisNetwork: 'steward-personal-net',
    })
  })

  it('replaces hyphens with underscores in the database name only', () => {
    expect(instanceNames('my-work')).toEqual({
      unit: 'steward@my-work',
      dbName: 'steward_my_work',
      redisNetwork: 'steward-my-work-net',
    })
  })
})
