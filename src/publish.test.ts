import { describe, expect, it } from 'vitest'

import type { Exec } from './platform/github'
import { publish, runValidationLoop, type ValidatedAttempt } from './publish'
import { type CommandResult, decideValidation, type DiffViolation } from './validation-policy'

const WORKTREE = '/home/you/steward-instances/personal/runs/INV-80/worktree'
const INPUT = {
  worktreePath: WORKTREE,
  repo: 'k-b3r/scratch',
  branch: 'INV-80',
  prNumber: 7,
  ghAccount: 'k-b3r',
  commitMessage: 'INV-80: add hello.txt',
  maxRetries: 0,
}

/** A git and gh double. Every call joins `log`, so the whole order is one list to assert on. */
function fakeExec(log: string[], opts: { staged?: boolean; commitCode?: number; pushCode?: number } = {}) {
  const calls: { cmd: string; args: string[] }[] = []
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args })
    log.push(`${cmd} ${args.join(' ')}`)
    const reply = (code = 0, stdout = '') => ({ code, stdout, stderr: '' })
    if (cmd === 'gh' && args[0] === 'auth') return reply(0, 'gho_test000000000000000000\n')
    if (cmd === 'gh') return reply()
    if (args.includes('--quiet')) return reply(opts.staged === false ? 0 : 1)
    if (args.includes('commit')) return reply(opts.commitCode ?? 0)
    if (args.includes('push')) return reply(opts.pushCode ?? 0)
    return reply()
  }
  return { calls, exec }
}

function step(entry: string): string | undefined {
  if (entry.startsWith('validate')) return 'validate'
  if (entry.startsWith('resume')) return 'resume'
  if (entry.includes(' commit ')) return 'commit'
  if (entry.includes(' push ')) return 'push'
  if (entry.includes(' pr edit ')) return 'body'
  return undefined
}

const steps = (log: readonly string[]): string[] => log.map(step).filter((one) => one !== undefined)

const PASSING: CommandResult[] = [{ name: 'test', exitCode: 0, timedOut: false, outputTail: 'ok\n' }]
const FAILING: CommandResult[] = [{ name: 'test', exitCode: 1, timedOut: false, outputTail: 'boom\n' }]
const passed = (): ValidatedAttempt => ({ decision: { action: 'pass' }, results: PASSING, violations: [] })
const retry = (feedback = 'fix it'): ValidatedAttempt => ({
  decision: { action: 'retry', feedback },
  results: FAILING,
  violations: [],
})
const failed = (reason = 'gave up'): ValidatedAttempt => ({
  decision: { action: 'fail', kind: 'agent', reason },
  results: FAILING,
  violations: [],
})

/** A loop double: replays the decisions, recording the attempts, the feedback and the whole order. */
function replay(decisions: ValidatedAttempt[], log: string[] = []) {
  const attempts: number[] = []
  const resumes: string[] = []
  const validate = (attempt: number) => {
    attempts.push(attempt)
    log.push(`validate ${attempt}`)
    const next = decisions[attempt - 1]
    if (next === undefined) throw new Error(`unexpected validation attempt ${attempt}`)
    return Promise.resolve(next)
  }
  const resume = (feedback: string) => {
    resumes.push(feedback)
    log.push('resume')
    return Promise.resolve()
  }
  return { attempts, resumes, validate, resume }
}

describe('runValidationLoop', () => {
  it('passes on the first attempt, and on the one after the feedback', async () => {
    const first = replay([passed()])
    const one = await runValidationLoop(first, { maxRetries: 2 })
    expect([one.status, one.attempts, first.attempts, first.resumes]).toEqual(['passed', 1, [1], []])
    expect(one.report).toContain('Validation passed after 1 attempt.')

    const second = replay([retry('the test failed'), passed()])
    const two = await runValidationLoop(second, { maxRetries: 2 })
    expect([two.status, two.attempts, second.attempts, second.resumes]).toEqual([
      'passed',
      2,
      [1, 2],
      ['the test failed'],
    ])
    expect(two.report).toContain('Validation passed after 2 attempts.')
  })

  it('spends the retries, then fails with the decision reason and never validates again', async () => {
    const deciding = (maxRetries: number) => (attempt: number) =>
      Promise.resolve({
        decision: decideValidation({ results: FAILING, violations: [], attempt, maxRetries }),
        results: FAILING,
        violations: [],
      })
    const resumes: string[] = []
    const resume = (feedback: string) => {
      resumes.push(feedback)
      return Promise.resolve()
    }

    const result = await runValidationLoop({ validate: deciding(2), resume }, { maxRetries: 2 })
    expect([result.status, result.attempts, resumes.length]).toEqual(['failed', 3, 2])
    expect(result.reason).toContain('still failing after 3 runs')
    expect(result.report).toContain('Validation failed after 3 attempts.')
    expect(result.report).toContain('boom')

    // A decision that keeps asking for a retry cannot push the loop past the budget either.
    const attempts: number[] = []
    let resumed = 0
    const always = (attempt: number) => {
      attempts.push(attempt)
      return Promise.resolve(retry())
    }
    const capped = await runValidationLoop(
      {
        validate: always,
        resume: () => {
          resumed += 1
          return Promise.resolve()
        },
      },
      { maxRetries: 0 },
    )
    expect([attempts, resumed, capped.status, capped.attempts]).toEqual([[1], 0, 'failed', 1])
    expect(capped.reason).toContain('retry')
  })

  it('fails a forbidden path at once, without resuming', async () => {
    const violations: DiffViolation[] = [{ rule: 'forbidden-path', path: '.env', detail: '.env is a forbidden path' }]
    const decisions = [
      { decision: decideValidation({ results: [], violations, attempt: 1, maxRetries: 2 }), results: [], violations },
    ]
    const { attempts, resumes, validate, resume } = replay(decisions)

    const result = await runValidationLoop({ validate, resume }, { maxRetries: 2 })

    expect([result.status, result.attempts, attempts, resumes]).toEqual(['failed', 1, [1], []])
    expect(result.reason).toContain('forbidden-path')
    expect(result.report).toContain('forbidden-path (.env)')
  })

  it('propagates a resume that throws, without validating again', async () => {
    const { attempts, validate } = replay([retry(), passed()])
    const resume = () => Promise.reject(new Error('the agent container died'))

    await expect(runValidationLoop({ validate, resume }, { maxRetries: 2 })).rejects.toThrow('the agent container died')
    expect(attempts).toEqual([1])
  })

  it('refuses an impossible retry budget', async () => {
    const deps = { validate: () => Promise.resolve(passed()), resume: () => Promise.resolve() }

    await expect(runValidationLoop(deps, { maxRetries: -1 })).rejects.toThrow(RangeError)
    await expect(runValidationLoop(deps, { maxRetries: 1.5 })).rejects.toThrow(RangeError)
  })
})

describe('publish', () => {
  it('validates, commits, pushes, then writes the report, with no forced push', async () => {
    const log: string[] = []
    const { calls, exec } = fakeExec(log)
    const { validate, resume } = replay([passed()], log)

    const result = await publish({ exec, validate, resume }, INPUT)

    expect(result).toEqual({ status: 'published', attempts: 1 })
    expect(steps(log)).toEqual(['validate', 'commit', 'push', 'body'])
    const committed = calls.find((call) => call.args.includes('commit'))
    expect(committed?.args).toEqual(['-C', WORKTREE, 'commit', '-m', INPUT.commitMessage])
    expect(log.join(' ')).not.toMatch(/user\.(name|email)/)
    const pushed = calls.find((call) => call.args.includes('push'))?.args ?? []
    expect(pushed.join(' ')).toContain(`refs/heads/${INPUT.branch}:refs/heads/${INPUT.branch}`)
    for (const forced of ['--force', '-f', '+refs/heads']) expect(pushed).not.toContain(forced)
    const body = calls.find((call) => call.args.includes('--body'))?.args.at(-1)
    expect(body).toContain('Validation passed after 1 attempt.')
    expect(body?.trimEnd().endsWith('Generated by steward.')).toBe(true)
  })

  it('pushes nothing on a failed validation or a clean index, and reports both', async () => {
    const failedLog: string[] = []
    const failing = fakeExec(failedLog)
    const failingRun = replay([failed('never retried: forbidden-path (.env): .env is a forbidden path')], failedLog)

    const failedResult = await publish(
      { exec: failing.exec, validate: failingRun.validate, resume: failingRun.resume },
      INPUT,
    )

    expect([failedResult.status, failedResult.attempts]).toEqual(['failed', 1])
    expect(failedResult.reason).toContain('forbidden-path')
    expect(steps(failedLog)).toEqual(['validate', 'body'])
    expect(failedLog.join('\n')).not.toContain(' push ')
    expect(failedLog.find((entry) => entry.includes(' pr edit '))).toContain('Validation failed after 1 attempt.')

    const cleanLog: string[] = []
    const clean = fakeExec(cleanLog, { staged: false })
    const cleanRun = replay([passed()], cleanLog)

    const none = await publish({ exec: clean.exec, validate: cleanRun.validate, resume: cleanRun.resume }, INPUT)

    expect(none).toEqual({ status: 'no-changes', attempts: 1 })
    expect(steps(cleanLog)).toEqual(['validate', 'body'])
    expect(clean.calls[0]?.args).toEqual(['-C', WORKTREE, 'diff', '--cached', '--quiet'])
    expect(cleanLog.join('\n')).not.toContain(' push ')
    expect(cleanLog.find((entry) => entry.includes(' pr edit '))).toContain('no changes')
  })

  it('stops before the commit when a resume throws, and before the body when the commit or push fails', async () => {
    const resumeLog: string[] = []
    const resumeRun = fakeExec(resumeLog)
    const retrying = replay([retry(), passed()], resumeLog)
    const resume = () => {
      resumeLog.push('resume')
      return Promise.reject(new Error('resume failed'))
    }

    await expect(
      publish({ exec: resumeRun.exec, validate: retrying.validate, resume }, { ...INPUT, maxRetries: 2 }),
    ).rejects.toThrow('resume failed')
    expect(steps(resumeLog)).toEqual(['validate', 'resume'])

    for (const [option, failure] of [
      [{ commitCode: 1 }, /git commit/],
      [{ pushCode: 1 }, /git push/],
    ] as const) {
      const log: string[] = []
      const fake = fakeExec(log, option)
      const run = replay([passed()], log)

      await expect(publish({ exec: fake.exec, validate: run.validate, resume: run.resume }, INPUT)).rejects.toThrow(
        failure,
      )
      expect(steps(log)).toEqual(option.commitCode === 1 ? ['validate', 'commit'] : ['validate', 'commit', 'push'])
    }
  })
})
