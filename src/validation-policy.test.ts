import { describe, expect, it } from 'vitest'

import { type ChangedFile, checkDiff, globMatch, parseValidationConfig } from './validation-policy'

const COMMAND = { name: 'typecheck', run: 'pnpm typecheck' }

function policy() {
  return parseValidationConfig({ commands: [COMMAND] }).diff
}

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'M', added: 1, deleted: 0, ...overrides }
}

describe('parseValidationConfig', () => {
  it('applies the defaults when only commands are given', () => {
    const config = parseValidationConfig({ commands: [COMMAND] })

    expect(config).toEqual({
      commands: [COMMAND],
      diff: {
        maxChangedLines: 800,
        forbiddenPaths: ['.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/id_rsa*', '.github/workflows/**'],
        allowedPaths: ['.env.example', '**/.env.example'],
      },
      maxRetries: 2,
    })
  })

  it('keeps the commands in the order given', () => {
    const config = parseValidationConfig({
      commands: [
        { name: 'lint', run: 'pnpm lint' },
        { name: 'test', run: 'pnpm test', timeoutSec: 600 },
        { name: 'typecheck', run: 'pnpm typecheck' },
      ],
    })

    expect(config.commands.map((c) => c.name)).toEqual(['lint', 'test', 'typecheck'])
    expect(config.commands[1]?.timeoutSec).toBe(600)
  })

  it('takes the diff limits and maxRetries it is given', () => {
    const config = parseValidationConfig({
      commands: [COMMAND],
      diff: { maxChangedLines: 120, forbiddenPaths: ['secrets/**'] },
      maxRetries: 0,
    })

    expect(config.diff.maxChangedLines).toBe(120)
    expect(config.diff.forbiddenPaths).toEqual(['secrets/**'])
    expect(config.diff.allowedPaths).toEqual(['.env.example', '**/.env.example'])
    expect(config.maxRetries).toBe(0)
    expect(parseValidationConfig({ commands: [COMMAND], maxRetries: 5 }).maxRetries).toBe(5)
  })

  it('does not share default arrays between parses', () => {
    const first = parseValidationConfig({ commands: [COMMAND] })
    first.diff.forbiddenPaths.push('extra')

    expect(parseValidationConfig({ commands: [COMMAND] }).diff.forbiddenPaths).not.toContain('extra')
  })

  it('rejects maxRetries outside 0..5 and non-integers', () => {
    for (const maxRetries of [6, -1, 1.5]) {
      expect(() => parseValidationConfig({ commands: [COMMAND], maxRetries })).toThrow(/maxRetries/)
    }
  })

  it('rejects a config with no commands', () => {
    expect(() => parseValidationConfig({ commands: [] })).toThrow(/at least one command/)
  })

  it('rejects an empty or blank command name', () => {
    expect(() => parseValidationConfig({ commands: [{ name: '', run: 'x' }] })).toThrow(/commands\.0\.name/)
    expect(() => parseValidationConfig({ commands: [{ name: '   ', run: 'x' }] })).toThrow(/commands\.0\.name/)
  })

  it('rejects an empty or blank run', () => {
    expect(() => parseValidationConfig({ commands: [{ name: 'a', run: '' }] })).toThrow(/commands\.0\.run/)
    expect(() => parseValidationConfig({ commands: [{ name: 'a', run: '  ' }] })).toThrow(/commands\.0\.run/)
  })

  it('rejects duplicate command names', () => {
    expect(() =>
      parseValidationConfig({
        commands: [
          { name: 'lint', run: 'a' },
          { name: 'lint', run: 'b' },
        ],
      }),
    ).toThrow(/duplicate.*lint/i)
  })

  it('rejects a timeout that is not positive', () => {
    expect(() => parseValidationConfig({ commands: [{ ...COMMAND, timeoutSec: 0 }] })).toThrow(/timeoutSec/)
  })

  it('reports every problem in one error', () => {
    let message = ''
    try {
      parseValidationConfig({
        commands: [
          { name: '', run: 'x' },
          { name: 'a', run: '' },
          { name: 'a', run: 'y' },
        ],
        maxRetries: 9,
      })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toMatch(/commands\.0\.name/)
    expect(message).toMatch(/commands\.1\.run/)
    expect(message).toMatch(/duplicate.*a/i)
    expect(message).toMatch(/maxRetries/)
  })

  it('rejects input that is not an object', () => {
    expect(() => parseValidationConfig(null)).toThrow(Error)
    expect(() => parseValidationConfig('pnpm test')).toThrow(Error)
  })
})

describe('globMatch', () => {
  it('lets * match within one path segment only', () => {
    expect(globMatch('*.ts', 'a.ts')).toBe(true)
    expect(globMatch('*.ts', 'src/a.ts')).toBe(false)
  })

  it('lets **/ match zero or more directories', () => {
    expect(globMatch('**/*.pem', 'server.pem')).toBe(true)
    expect(globMatch('**/*.pem', 'config/keys/server.pem')).toBe(true)
    expect(globMatch('**/*.pem', 'server.pem.txt')).toBe(false)
  })

  it('lets a trailing ** match everything below a directory', () => {
    expect(globMatch('.github/workflows/**', '.github/workflows/ci.yml')).toBe(true)
    expect(globMatch('.github/workflows/**', '.github/workflows/nested/x.yml')).toBe(true)
    expect(globMatch('.github/workflows/**', '.github/other.yml')).toBe(false)
  })

  it('matches ? as one character that is not a slash', () => {
    expect(globMatch('a?c', 'abc')).toBe(true)
    expect(globMatch('a?c', 'ac')).toBe(false)
    expect(globMatch('a?c', 'a/c')).toBe(false)
  })

  it('matches literal dots and does not treat them as wildcards', () => {
    expect(globMatch('.env', '.env')).toBe(true)
    expect(globMatch('.env', 'xenv')).toBe(false)
    expect(globMatch('.env.*', '.env.local')).toBe(true)
    expect(globMatch('.env.*', '.env')).toBe(false)
  })

  it('matches id_rsa files with any suffix anywhere in the tree', () => {
    expect(globMatch('**/id_rsa*', 'id_rsa')).toBe(true)
    expect(globMatch('**/id_rsa*', 'keys/id_rsa.pub')).toBe(true)
    expect(globMatch('**/id_rsa*', 'keys/rsa.pub')).toBe(false)
  })
})

describe('checkDiff', () => {
  it('reports nothing for an empty or small diff', () => {
    expect(checkDiff([], policy())).toEqual([])
    expect(checkDiff([file('src/a.ts', { added: 10, deleted: 2 })], policy())).toEqual([])
  })

  it('reports too-large above the limit and not at it', () => {
    const atLimit = [file('src/a.ts', { added: 500, deleted: 300 })]
    const overLimit = [file('src/a.ts', { added: 500, deleted: 301 })]

    expect(checkDiff(atLimit, policy())).toEqual([])
    expect(checkDiff(overLimit, policy())).toEqual([
      { rule: 'too-large', detail: '801 changed lines, the limit is 800' },
    ])
  })

  it('leaves lockfiles and generated files out of the line count', () => {
    const files = [
      file('pnpm-lock.yaml', { added: 5000, deleted: 0 }),
      file('apps/web/package-lock.json', { added: 3000, deleted: 0 }),
      file('src/schema.generated.ts', { added: 3000, deleted: 0 }),
      file('src/generated/client.ts', { added: 3000, deleted: 0 }),
      file('src/a.ts', { added: 10, deleted: 0 }),
      file('package.json', { added: 1, deleted: 0 }),
    ]

    expect(checkDiff(files, policy()).map((v) => v.rule)).not.toContain('too-large')
  })

  it('reports forbidden paths, but not the allowed .env.example', () => {
    const violations = checkDiff(
      [
        file('.env', { status: 'M' }),
        file('.env.local', { status: 'A' }),
        file('config/keys/server.pem'),
        file('.github/workflows/ci.yml'),
        file('src/id_rsa_backup'),
        file('.env.example', { status: 'A' }),
        file('docs/env.md'),
        file('app/.env', { status: 'M' }),
        file('server/.env.production', { status: 'A' }),
        file('app/.env.example', { status: 'A' }),
      ],
      policy(),
    )

    expect(violations.filter((v) => v.rule === 'forbidden-path').map((v) => v.path)).toEqual([
      '.env',
      '.env.local',
      '.github/workflows/ci.yml',
      'app/.env',
      'config/keys/server.pem',
      'server/.env.production',
      'src/id_rsa_backup',
    ])
  })

  it('reports a forbidden path that is deleted', () => {
    const violations = checkDiff([file('.env', { status: 'D', added: 0, deleted: 1 })], policy())

    expect(violations).toEqual([{ rule: 'forbidden-path', path: '.env', detail: expect.any(String) }])
  })

  it('does not report a forbidden path that the policy allows', () => {
    const allowed = { ...policy(), forbiddenPaths: ['.env.*'], allowedPaths: ['.env.example'] }

    expect(checkDiff([file('.env.example', { status: 'M' })], allowed)).toEqual([])
    expect(checkDiff([file('.env.local')], allowed)).toHaveLength(1)
  })

  it('reports a changed contract test but lets one be added', () => {
    const violations = checkDiff(
      [
        file('src/a.contract.test.ts', { status: 'M' }),
        file('src/b.contract.test.ts', { status: 'D', added: 0, deleted: 9 }),
        file('src/c.contract.test.ts', { status: 'R' }),
        file('src/d.contract.test.ts', { status: 'A' }),
      ],
      policy(),
    )

    expect(violations.map((v) => [v.rule, v.path])).toEqual([
      ['contract-test-changed', 'src/a.contract.test.ts'],
      ['contract-test-changed', 'src/b.contract.test.ts'],
      ['contract-test-changed', 'src/c.contract.test.ts'],
    ])
  })

  it('reports a lockfile changed without a package.json in the same diff', () => {
    expect(checkDiff([file('pnpm-lock.yaml')], policy())).toEqual([
      {
        rule: 'lockfile-without-manifest',
        path: 'pnpm-lock.yaml',
        detail: expect.any(String),
      },
    ])
  })

  it('accepts a lockfile changed together with a package.json, in any directory', () => {
    expect(checkDiff([file('pnpm-lock.yaml'), file('package.json')], policy())).toEqual([])
    expect(
      checkDiff([file('yarn.lock', { status: 'D', deleted: 4, added: 0 }), file('dashboard/package.json')], policy()),
    ).toEqual([])
  })

  it('lists violations by rule order, then by path', () => {
    const violations = checkDiff(
      [
        file('pnpm-lock.yaml'),
        file('z.contract.test.ts'),
        file('.env'),
        file('a.contract.test.ts'),
        file('src/big.ts', { added: 900, deleted: 0 }),
      ],
      policy(),
    )

    expect(violations.map((v) => [v.rule, v.path])).toEqual([
      ['too-large', undefined],
      ['forbidden-path', '.env'],
      ['contract-test-changed', 'a.contract.test.ts'],
      ['contract-test-changed', 'z.contract.test.ts'],
      ['lockfile-without-manifest', 'pnpm-lock.yaml'],
    ])
  })
})
