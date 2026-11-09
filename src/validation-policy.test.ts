import { describe, expect, it } from 'vitest'

import {
  type ChangedFile,
  checkDiff,
  type CommandResult,
  decideValidation,
  globMatch,
  parseValidationConfig,
  type ValidationInput,
} from './validation-policy'

const COMMAND = { name: 'typecheck', run: 'pnpm typecheck' }

function policy() {
  return parseValidationConfig({ commands: [COMMAND] }).diff
}

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: 'M', added: 1, deleted: 0, ...overrides }
}

function result(name: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return { name, exitCode: 0, timedOut: false, outputTail: '', ...overrides }
}

function input(overrides: Partial<ValidationInput> = {}): ValidationInput {
  return { results: [result('typecheck')], violations: [], attempt: 1, maxRetries: 2, ...overrides }
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

  it('leaves a generated/ directory out of the line count at the top level too', () => {
    const files = [
      file('generated/client.ts', { added: 3000, deleted: 0 }),
      file('src/a.ts', { added: 10, deleted: 0 }),
    ]

    expect(checkDiff(files, policy())).toEqual([])
    expect(checkDiff([file('generated/client.ts', { added: 801, deleted: 0 })], policy())).toEqual([])
  })

  it('still counts a file that only mentions generated/ in its name', () => {
    expect(checkDiff([file('src/generated-notes.ts', { added: 801, deleted: 0 })], policy())).toEqual([
      { rule: 'too-large', detail: '801 changed lines, the limit is 800' },
    ])
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

  it('reports a contract test renamed to a normal name, by its old path', () => {
    const violations = checkDiff(
      [file('src/a.ts', { status: 'R', oldPath: 'src/a.contract.test.ts', added: 0, deleted: 0 })],
      policy(),
    )

    expect(violations).toEqual([
      {
        rule: 'contract-test-changed',
        path: 'src/a.contract.test.ts',
        detail: 'src/a.ts was renamed from src/a.contract.test.ts; contract tests may only be added',
      },
    ])
  })

  it('reports a contract test renamed to another contract test once', () => {
    const violations = checkDiff(
      [file('src/b.contract.test.ts', { status: 'R', oldPath: 'src/a.contract.test.ts', added: 0, deleted: 0 })],
      policy(),
    )

    expect(violations.map((v) => [v.rule, v.path])).toEqual([['contract-test-changed', 'src/b.contract.test.ts']])
  })

  it('reports a forbidden file renamed to an allowed name, by its old path', () => {
    const violations = checkDiff([file('env.txt', { status: 'R', oldPath: '.env', added: 0, deleted: 0 })], policy())

    expect(violations).toEqual([
      { rule: 'forbidden-path', path: '.env', detail: 'env.txt was renamed from .env; .env is a forbidden path' },
    ])
  })

  it('reports a rename into a forbidden path by its new path', () => {
    const violations = checkDiff([file('.env', { status: 'R', oldPath: 'env.txt', added: 0, deleted: 0 })], policy())

    expect(violations).toEqual([{ rule: 'forbidden-path', path: '.env', detail: '.env is a forbidden path' }])
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

describe('decideValidation', () => {
  it('passes when every command exits 0 and nothing is violated', () => {
    expect(decideValidation(input({ results: [result('typecheck'), result('lint')] }))).toEqual({ action: 'pass' })
  })

  it('retries on a non-zero exit and feeds the failure back', () => {
    const decision = decideValidation(
      input({ results: [result('typecheck', { exitCode: 2, outputTail: 'error TS2322: bad type' })] }),
    )

    expect(decision.action).toBe('retry')
    if (decision.action !== 'retry') return
    expect(decision.feedback).toContain('`typecheck`')
    expect(decision.feedback).toContain('code 2')
    expect(decision.feedback).toContain('error TS2322: bad type')
  })

  it('retries on a timeout even when the exit code is 0', () => {
    const decision = decideValidation(input({ results: [result('test', { timedOut: true, exitCode: 0 })] }))

    expect(decision.action).toBe('retry')
    if (decision.action !== 'retry') return
    expect(decision.feedback).toContain('`test` timed out')
  })

  it('retries on a diff violation that may be fixed', () => {
    const decision = decideValidation(
      input({ violations: [{ rule: 'too-large', detail: '900 changed lines, the limit is 800' }] }),
    )

    expect(decision.action).toBe('retry')
    if (decision.action !== 'retry') return
    expect(decision.feedback).toContain('too-large')
    expect(decision.feedback).toContain('900 changed lines')
  })

  it('leaves out the passing commands from the feedback', () => {
    const decision = decideValidation(
      input({ results: [result('lint'), result('typecheck', { exitCode: 1, outputTail: 'boom' })] }),
    )

    expect(decision.action).toBe('retry')
    if (decision.action !== 'retry') return
    expect(decision.feedback).toContain('typecheck')
    expect(decision.feedback).not.toContain('lint')
  })

  it('keeps the last 40 lines of a failing command output', () => {
    const outputTail = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
    const decision = decideValidation(input({ results: [result('typecheck', { exitCode: 1, outputTail })] }))

    expect(decision.action).toBe('retry')
    if (decision.action !== 'retry') return
    expect(decision.feedback).toContain('line 100')
    expect(decision.feedback).toContain('line 61')
    expect(decision.feedback).not.toContain('line 60')
  })

  it('stops retrying after the last allowed retry', () => {
    const failing = [result('typecheck', { exitCode: 1 })]

    expect(decideValidation(input({ results: failing, attempt: 1, maxRetries: 2 })).action).toBe('retry')
    expect(decideValidation(input({ results: failing, attempt: 2, maxRetries: 2 })).action).toBe('retry')
    expect(decideValidation(input({ results: failing, attempt: 3, maxRetries: 2 }))).toEqual({
      action: 'fail',
      kind: 'agent',
      reason: expect.stringContaining('after 3 runs'),
    })
  })

  it('fails at once when no retries are allowed', () => {
    const decision = decideValidation(input({ results: [result('typecheck', { exitCode: 1 })], maxRetries: 0 }))

    expect(decision.action).toBe('fail')
  })

  it('never retries a forbidden path, even with retries left', () => {
    const decision = decideValidation(
      input({
        results: [result('typecheck', { exitCode: 1 })],
        violations: [{ rule: 'forbidden-path', path: '.env', detail: '.env matches a forbidden path' }],
        attempt: 1,
        maxRetries: 2,
      }),
    )

    expect(decision).toEqual({ action: 'fail', kind: 'agent', reason: expect.stringContaining('.env') })
  })

  it('never retries a changed contract test', () => {
    const decision = decideValidation(
      input({
        violations: [{ rule: 'contract-test-changed', path: 'src/a.contract.test.ts', detail: 'M on a contract test' }],
      }),
    )

    expect(decision.action).toBe('fail')
    if (decision.action !== 'fail') return
    expect(decision.kind).toBe('agent')
    expect(decision.reason).toContain('contract-test-changed')
  })

  it('rejects an attempt below 1 or a negative maxRetries', () => {
    expect(() => decideValidation(input({ attempt: 0 }))).toThrow(RangeError)
    expect(() => decideValidation(input({ maxRetries: -1 }))).toThrow(RangeError)
  })

  it('caps the feedback at 8000 characters and cuts the oldest output first', () => {
    const block = (tag: string) =>
      Array.from({ length: 40 }, (_, i) =>
        i === 0 ? `${tag}-START` : i === 39 ? `${tag}-END` : 'x'.repeat(1000),
      ).join('\n')
    const decision = decideValidation(
      input({
        results: [
          result('first', { exitCode: 1, outputTail: block('A') }),
          result('second', { exitCode: 1, outputTail: block('B') }),
        ],
      }),
    )

    expect(decision.action).toBe('retry')
    if (decision.action !== 'retry') return
    expect(decision.feedback.length).toBeLessThanOrEqual(8000)
    expect(decision.feedback).toContain('B-END')
    expect(decision.feedback).not.toContain('A-START')
  })

  it('caps the feedback even when the violations alone are too long', () => {
    const violations = Array.from({ length: 300 }, (_, i) => ({
      rule: 'too-large' as const,
      detail: `${i} ${'y'.repeat(100)}`,
    }))
    const decision = decideValidation(input({ violations }))

    expect(decision.action).toBe('retry')
    if (decision.action !== 'retry') return
    expect(decision.feedback.length).toBeLessThanOrEqual(8000)
    expect(decision.feedback).toContain('truncated')
  })
})
