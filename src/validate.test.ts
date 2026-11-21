import { describe, expect, it } from 'vitest'

import type { Exec } from './platform/github'
import { parseValidationConfig, type ValidationConfig } from './validation-policy'
import {
  collectChangedFiles,
  loadValidationConfig,
  type RunChecksInput,
  type RunExec,
  runChecks,
  type ValidateWorktreeInput,
  validateWorktree,
} from './validate'

// A staged two-file diff that breaks no rule: one addition, one binary modification.
const STATUS = 'A\0src/new.ts\0M\0src/changed.ts\0'
const NUMSTAT = '3\t1\tsrc/new.ts\0' + '-\t-\tsrc/changed.ts\0'
const WT = '/runs/BUY-41/1/worktree'
const CONFIG_PATH = '/home/you/steward-instances/personal/validation.json'
const FILES = [
  { status: 'A', path: 'src/new.ts', added: 3, deleted: 1 },
  { status: 'M', path: 'src/changed.ts', added: 0, deleted: 0 },
]

type Call = { cmd: string; args: string[] }
const config = (spec: unknown): ValidationConfig => parseValidationConfig(spec)
const TWO = config({
  commands: [
    { name: 'node', run: 'node --version' },
    { name: 'pnpm', run: 'pnpm --version' },
  ],
})

/** A git double recording its calls and printing the given diff text, or FILES. */
function fakeGit(status = STATUS, numstat = NUMSTAT) {
  const calls: Call[] = []
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args })
    const stdout = args.includes('add') ? '' : args.includes('--name-status') ? status : numstat
    return Promise.resolve({ code: 0, stdout, stderr: '' })
  }
  return { calls, exec }
}

function fakeRun(reply: (command: string) => { code?: number; output?: string } = () => ({})) {
  const calls: Call[] = []
  const podman: RunExec = (cmd, args) => {
    calls.push({ cmd, args })
    if (args[0] === 'kill') return Promise.resolve({ code: 0, output: '' })
    const outcome = reply(args.at(-1) ?? '')
    return Promise.resolve({ code: outcome.code ?? 0, output: outcome.output ?? '' })
  }
  return { calls, podman }
}

function fakeTime() {
  let now = 0
  return {
    clock: () => new Date(now),
    sleep: (ms: number) => {
      now += ms
      return Promise.resolve()
    },
    elapsed: () => now,
  }
}

const runDeps = (podman: RunExec, time = fakeTime(), redact = (text: string) => text) => ({
  podman,
  clock: time.clock,
  sleep: time.sleep,
  redact,
})

const CHECK_INPUT: RunChecksInput = {
  config: config({ commands: [{ name: 'node', run: 'node --version' }] }),
  instance: 'personal',
  jobId: 'BUY-41',
  runNumber: 1,
  image: 'steward-pi:1.5.0',
  worktreePath: WT,
  limits: { cpus: 2, memoryMb: 4096, pidsLimit: 512 },
}
const WT_INPUT: ValidateWorktreeInput = { ...CHECK_INPUT, baseRef: 'origin/main', attempt: 1 }

function worktree(git = fakeGit(), run = fakeRun(), time = fakeTime()) {
  return { deps: { exec: git.exec, ...runDeps(run.podman, time) }, runCalls: run.calls, gitCalls: git.calls }
}

describe('collectChangedFiles', () => {
  it('stages the worktree, then reads the diff against the base ref', async () => {
    const { calls, exec } = fakeGit()

    expect(await collectChangedFiles({ exec }, { worktreePath: WT, baseRef: 'origin/main' })).toEqual(FILES)
    expect(calls.map((call) => call.args)).toEqual([
      ['-C', WT, 'add', '-A'],
      ['-C', WT, 'diff', '--cached', '-M', '--name-status', '-z', 'origin/main'],
      ['-C', WT, 'diff', '--cached', '-M', '--numstat', '-z', 'origin/main'],
    ])
  })

  it.each(['--upload-pack=evil', 'origin/main..evil', '', 'a b'])('refuses the base ref %j before git', async (ref) => {
    const { calls, exec } = fakeGit()

    await expect(collectChangedFiles({ exec }, { worktreePath: WT, baseRef: ref })).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(0)
  })
})

describe('runChecks', () => {
  it('runs the commands in config order, one container each', async () => {
    const { calls, podman } = fakeRun((command) => ({ output: `${command}\n` }))

    expect(await runChecks(runDeps(podman), { ...CHECK_INPUT, config: TWO })).toEqual([
      { name: 'node', exitCode: 0, timedOut: false, outputTail: 'node --version\n' },
      { name: 'pnpm', exitCode: 0, timedOut: false, outputTail: 'pnpm --version\n' },
    ])
    expect(calls.map((call) => call.args.at(-1))).toEqual(['node --version', 'pnpm --version'])
    expect(calls[0]?.args).toContain('steward-personal-check-BUY-41-1-0')
    expect(calls[1]?.args).toContain('steward-personal-check-BUY-41-1-1')
  })

  it('stops at the first failing command and does not run or report the rest', async () => {
    const { calls, podman } = fakeRun((command) => (command === 'node --version' ? { code: 2, output: 'boom\n' } : {}))

    expect(await runChecks(runDeps(podman), { ...CHECK_INPUT, config: TWO })).toEqual([
      { name: 'node', exitCode: 2, timedOut: false, outputTail: 'boom\n' },
    ])
    expect(calls).toHaveLength(1)
  })

  it.each([
    [undefined, 600_000],
    [5, 5_000],
  ])('kills the container after %s seconds of no answer', async (timeoutSec, waited) => {
    const time = fakeTime()
    const calls: Call[] = []
    let finish: ((outcome: { code: number; output: string }) => void) | undefined
    const podman: RunExec = (_cmd, args) => {
      calls.push({ cmd: 'podman', args })
      if (args[0] === 'kill') {
        finish?.({ code: 137, output: 'killed\n' })
        return Promise.resolve({ code: 0, output: '' })
      }
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    const command = { name: 'node', run: 'node', ...(timeoutSec === undefined ? {} : { timeoutSec }) }

    const results = await runChecks(runDeps(podman, time), { ...CHECK_INPUT, config: config({ commands: [command] }) })

    expect(results).toEqual([{ name: 'node', exitCode: 137, timedOut: true, outputTail: 'killed\n' }])
    expect(calls[1]?.args).toEqual(['kill', 'steward-personal-check-BUY-41-1-0'])
    expect(time.elapsed()).toBe(waited)
  })

  it('reports -1 when the attached run never comes back after the kill', async () => {
    const time = fakeTime()
    const podman: RunExec = (_cmd, args) =>
      args[0] === 'kill' ? Promise.resolve({ code: 0, output: '' }) : new Promise(() => undefined)
    const input = { ...CHECK_INPUT, config: config({ commands: [{ name: 'node', run: 'node', timeoutSec: 2 }] }) }

    expect(await runChecks(runDeps(podman, time), input)).toEqual([
      { name: 'node', exitCode: -1, timedOut: true, outputTail: '' },
    ])
    expect(time.elapsed()).toBe(12_000)
  })

  it('redacts the tail, then cuts it to its last 64 KB', async () => {
    const { podman } = fakeRun(() => ({ output: `s3cret${'x'.repeat(70_000)}` }))
    const redact = (text: string) => text.split('s3cret').join('[REDACTED]')

    const results = await runChecks(runDeps(podman, fakeTime(), redact), CHECK_INPUT)

    expect(results[0]?.outputTail).toHaveLength(64 * 1024)
    expect(results[0]?.outputTail).not.toContain('s3cret')
  })
})

describe('validateWorktree', () => {
  it('passes when the diff is clean and every check exits 0', async () => {
    const { deps, runCalls } = worktree()

    expect(await validateWorktree(deps, WT_INPUT)).toEqual({
      decision: { action: 'pass' },
      results: [{ name: 'node', exitCode: 0, timedOut: false, outputTail: '' }],
      violations: [],
    })
    expect(runCalls[0]?.args).toContain('node --version')
  })

  it.each([
    ['a forbidden path', 'M\0.env\0', '1\t0\tsrc/a.ts\0', 'forbidden-path', 0, 'fail'],
    ['a changed contract test', 'M\0src/a.contract.test.ts\0', '1\t0\tsrc/a.ts\0', 'contract-test-changed', 0, 'fail'],
    ['a too-large diff', 'M\0src/a.ts\0', '900\t0\tsrc/a.ts\0', 'too-large', 1, 'retry'],
  ])('judges %s', async (_label, status, numstat, rule, checks, action) => {
    const { deps, runCalls } = worktree(fakeGit(status, numstat))

    const outcome = await validateWorktree(deps, WT_INPUT)

    expect(outcome.results).toHaveLength(checks)
    expect(runCalls).toHaveLength(checks)
    expect(outcome.violations.map((violation) => violation.rule)).toEqual([rule])
    expect(outcome.decision.action).toBe(action)
  })

  it("retries with the failing output, then fails once the config's maxRetries are spent", async () => {
    const { deps } = worktree(
      fakeGit(),
      fakeRun(() => ({ code: 1, output: 'test failed\n' })),
    )

    expect(await validateWorktree(deps, WT_INPUT)).toMatchObject({
      decision: { action: 'retry', feedback: expect.stringContaining('test failed') },
    })
    expect((await validateWorktree(deps, { ...WT_INPUT, attempt: 3 })).decision).toEqual({
      action: 'fail',
      kind: 'agent',
      reason: 'still failing after 3 runs: node exit 1',
    })
  })
})

describe('loadValidationConfig', () => {
  const readFile = (contents: string) => () => contents

  it('reads the file through the injected reader and parses it', () => {
    const config = loadValidationConfig(
      readFile(JSON.stringify({ commands: [{ name: 'test', run: 'pnpm test' }] })),
      CONFIG_PATH,
    )

    expect(config.commands).toEqual([{ name: 'test', run: 'pnpm test' }])
    expect(config.maxRetries).toBe(2)
    expect(config.diff.maxChangedLines).toBe(800)
  })

  it('names the path, never the contents, for bad JSON, an unreadable file or a schema failure', () => {
    const badJson = () => loadValidationConfig(readFile('{"commands": [ oops SECRET-VALUE'), CONFIG_PATH)

    expect(badJson).toThrow(`the validation config ${CONFIG_PATH} is not valid JSON`)
    expect(() =>
      loadValidationConfig(() => {
        throw new Error('ENOENT: no such file or directory')
      }, CONFIG_PATH),
    ).toThrow(CONFIG_PATH)
    expect(() => loadValidationConfig(readFile('{"commands": []}'), CONFIG_PATH)).toThrow(CONFIG_PATH)
    expect(() => loadValidationConfig(readFile('{"commands": []}'), CONFIG_PATH)).toThrow(/commands/)
  })
})
