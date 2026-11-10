import { describe, expect, it } from 'vitest'

import { createPodmanSpawn } from './podman'

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  return text
}

describe('createPodmanSpawn', () => {
  it('passes the allowlisted ambient and the forwarded variables, and reports the exit code', async () => {
    const spawn = createPodmanSpawn({ PATH: process.env.PATH, HOME: '/home/from-ambient' })
    const child = spawn('sh', ['-c', 'echo "$HOME $FORWARDED_MARK"; exit 3'], {
      env: { FORWARDED_MARK: 'from-forwarded' },
    })

    expect((await readAll(child.stdout)).trim()).toBe('/home/from-ambient from-forwarded')
    expect(await child.exit).toEqual({ code: 3, signal: null })
  })

  it('keeps every other host variable out of the child, secrets included', async () => {
    const spawn = createPodmanSpawn({
      PATH: process.env.PATH,
      LINEAR_API_KEY: 'lin-secret-0123',
      API_TOKEN: 'token-secret-0123',
      PI_MODEL_API_KEY: 'model-secret-0123',
    })
    const child = spawn('sh', ['-c', 'env'], { env: { OPENCODE_API_KEY: 'forwarded-model-key' } })

    const output = await readAll(child.stdout)

    expect(output).toContain('OPENCODE_API_KEY=forwarded-model-key')
    expect(output).not.toContain('lin-secret-0123')
    expect(output).not.toContain('token-secret-0123')
    expect(output).not.toContain('model-secret-0123')
  })

  it('reports a killed process by its signal rather than a code', async () => {
    const spawn = createPodmanSpawn({ PATH: process.env.PATH })
    // `exec` replaces the shell, so the signal reaches the process that holds the pipes open.
    const child = spawn('sh', ['-c', 'exec sleep 30'], { env: {} })

    child.kill()

    const exit = await child.exit
    expect(exit.code).toBeNull()
    expect(exit.signal).not.toBeNull()
  })

  it('resolves a failed start as a null code instead of rejecting', async () => {
    const spawn = createPodmanSpawn({ PATH: process.env.PATH })
    const child = spawn('steward-no-such-binary', [], { env: {} })

    expect(await child.exit).toEqual({ code: null, signal: null })
  })
})
