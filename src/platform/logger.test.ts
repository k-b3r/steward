import { describe, expect, it } from 'vitest'

import { createLogger } from './logger'

const CLOCK = new Date('2026-10-27T02:41:48.000Z')

function capture(options: { secrets?: readonly string[]; clock?: () => Date } = {}) {
  const lines: string[] = []
  const logger = createLogger({
    write: (line) => lines.push(line),
    clock: options.clock ?? (() => CLOCK),
    secrets: options.secrets,
  })
  return { logger, lines }
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe('createLogger', () => {
  it('writes one JSON line with the clock timestamp, level, message and fields', () => {
    const { logger, lines } = capture()

    logger.info('job started', { jobId: 'job-1', attempt: 2 })

    expect(lines).toHaveLength(1)
    expect(parseLine(lines[0])).toEqual({
      ts: '2026-10-27T02:41:48.000Z',
      level: 'info',
      msg: 'job started',
      jobId: 'job-1',
      attempt: 2,
    })
    expect(lines[0]).not.toContain('\n')
  })

  it('writes warn and error levels to separate lines', () => {
    const { logger, lines } = capture()

    logger.warn('careful')
    logger.error('broken', { code: 'E_FAIL' })

    expect(lines).toHaveLength(2)
    expect(parseLine(lines[0])).toMatchObject({ level: 'warn', msg: 'careful' })
    expect(parseLine(lines[1])).toMatchObject({ level: 'error', msg: 'broken', code: 'E_FAIL' })
  })

  it('redacts secrets in the message and in every nested string', () => {
    const { logger, lines } = capture({ secrets: ['supersecret123', 'tok_abcdef'] })

    logger.error('request supersecret123 failed', {
      url: 'https://example.com/?api=supersecret123',
      nested: { list: ['supersecret123', { note: 'token tok_abcdef' }] },
      count: 3,
      ok: false,
      nothing: null,
    })

    const parsed = parseLine(lines[0])
    const serialized = lines[0]

    expect(serialized).not.toContain('supersecret123')
    expect(serialized).not.toContain('tok_abcdef')
    expect(parsed.msg).toBe('request [REDACTED] failed')
    expect(parsed.url).toBe('https://example.com/?api=[REDACTED]')
    expect(parsed.nested).toEqual({ list: ['[REDACTED]', { note: 'token [REDACTED]' }] })
    expect(parsed.count).toBe(3)
    expect(parsed.ok).toBe(false)
    expect(parsed.nothing).toBeNull()
  })

  it('ignores empty secrets instead of rewriting every character', () => {
    const { logger, lines } = capture({ secrets: ['', 'abc'] })

    logger.info('abc', { value: 'abc' })

    const parsed = parseLine(lines[0])

    expect(parsed.msg).toBe('[REDACTED]')
    expect(parsed.value).toBe('[REDACTED]')
  })

  it('redacts values under sensitive keys case-insensitively, at any depth', () => {
    const { logger, lines } = capture()

    logger.warn('credentials seen', {
      Authorization: 'Bearer abc',
      API_KEY: 'key-1',
      ApiKey: 'key-2',
      token: 'tok-1',
      Password: 'pw-1',
      nested: { password: 'pw-2', safe: 'visible' },
      safe: 'also visible',
    })

    const parsed = parseLine(lines[0])
    const nested = parsed.nested as Record<string, unknown>

    expect(parsed.Authorization).toBe('[REDACTED]')
    expect(parsed.API_KEY).toBe('[REDACTED]')
    expect(parsed.ApiKey).toBe('[REDACTED]')
    expect(parsed.token).toBe('[REDACTED]')
    expect(parsed.Password).toBe('[REDACTED]')
    expect(nested.password).toBe('[REDACTED]')
    expect(nested.safe).toBe('visible')
    expect(parsed.safe).toBe('also visible')
  })

  it('replaces circular references with [Circular] instead of throwing', () => {
    const { logger, lines } = capture()
    const node: Record<string, unknown> = { label: 'root' }
    node.self = node
    const list: unknown[] = ['first']
    list.push(list)

    expect(() => logger.info('circular', { node, list, token: node })).not.toThrow()

    const parsed = parseLine(lines[0])
    const circularNode = parsed.node as Record<string, unknown>
    const circularList = parsed.list as unknown[]

    expect(circularNode.label).toBe('root')
    expect(circularNode.self).toBe('[Circular]')
    expect(circularList[0]).toBe('first')
    expect(circularList[1]).toBe('[Circular]')
    expect(parsed.token).toBe('[REDACTED]')
  })

  it('does not mutate the caller fields object', () => {
    const { logger } = capture({ secrets: ['supersecret123'] })
    const nested = { note: 'supersecret123' }
    const fields = { nested, token: 'tok-1' }

    logger.info('supersecret123', fields)

    expect(nested.note).toBe('supersecret123')
    expect(fields.token).toBe('tok-1')
  })
})
