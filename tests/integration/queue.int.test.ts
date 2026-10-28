import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { createJobQueue } from '../../src/worker/queue'

// CI gives the integration job a Postgres service only, so these tests run when a Redis is supplied
// (locally: TEST_REDIS_URL=redis://127.0.0.1:6380).
const redisUrl = process.env.TEST_REDIS_URL

type Queue = ReturnType<typeof createJobQueue>

const queues: Queue[] = []

function makeQueue(): Queue {
  if (redisUrl === undefined) {
    throw new Error('TEST_REDIS_URL is required for these tests')
  }
  const queue = createJobQueue({ redisUrl, queueName: `steward-test-${randomUUID()}` })
  queues.push(queue)
  return queue
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()))
})

describe.skipIf(redisUrl === undefined)('job queue', () => {
  it('enqueues a job and reports it as present', async () => {
    const queue = makeQueue()
    const jobId = randomUUID()

    expect(await queue.hasJob(jobId)).toBe(false)
    await queue.enqueue(jobId)
    expect(await queue.hasJob(jobId)).toBe(true)
  })

  it('treats a duplicate enqueue as one job', async () => {
    const queue = makeQueue()
    const jobId = randomUUID()
    const calls: string[] = []
    const firstCall = deferred<string>()

    await queue.enqueue(jobId)
    await queue.enqueue(jobId)
    await queue.startWorker(async (id) => {
      calls.push(id)
      firstCall.resolve(id)
    })

    expect(await firstCall.promise).toBe(jobId)
    await sleep(300)
    expect(calls).toEqual([jobId])
  })

  it('reports a delayed job as present', async () => {
    const queue = makeQueue()
    const jobId = randomUUID()

    await queue.enqueue(jobId, 60_000)

    expect(await queue.hasJob(jobId)).toBe(true)
  })

  it('passes the steward job id to the handler', async () => {
    const queue = makeQueue()
    const jobId = randomUUID()
    const processed = deferred<string>()

    await queue.startWorker(async (id) => {
      processed.resolve(id)
    })
    await queue.enqueue(jobId)

    expect(await processed.promise).toBe(jobId)
  })

  it('keeps working after a handler throws', async () => {
    const queue = makeQueue()
    const failingId = randomUUID()
    const succeedingId = randomUUID()
    const seen: string[] = []
    const processedSecond = deferred<string>()

    await queue.startWorker(async (id) => {
      seen.push(id)
      if (id === failingId) {
        throw new Error('boom')
      }
      processedSecond.resolve(id)
    })
    await queue.enqueue(failingId)
    await queue.enqueue(succeedingId)

    expect(await processedSecond.promise).toBe(succeedingId)
    expect(seen).toEqual([failingId, succeedingId])
  })

  it('accepts a re-enqueue of the same job from inside its own handler', async () => {
    const queue = makeQueue()
    const jobId = randomUUID()
    const calls: string[] = []
    const twice = deferred<void>()

    await queue.startWorker(async (id) => {
      calls.push(id)
      if (calls.length === 1) {
        await queue.enqueue(id)
      } else {
        twice.resolve()
      }
    })
    await queue.enqueue(jobId)
    await Promise.race([twice.promise, sleep(5000)])

    expect(calls).toEqual([jobId, jobId])
  })

  it('accepts a re-enqueue after the job already completed', async () => {
    const queue = makeQueue()
    const jobId = randomUUID()
    const calls: string[] = []
    const first = deferred<void>()
    const second = deferred<void>()

    await queue.startWorker(async (id) => {
      calls.push(id)
      if (calls.length === 1) first.resolve()
      else second.resolve()
    })
    await queue.enqueue(jobId)
    await first.promise
    await sleep(300)
    await queue.enqueue(jobId)
    await Promise.race([second.promise, sleep(5000)])

    expect(calls).toEqual([jobId, jobId])
  })
})
