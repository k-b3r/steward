// The only module allowed to import BullMQ and ioredis. BullMQ is a delivery
// mechanism only: the job id is the keeper of identity and Postgres stays the
// source of truth. BullMQ never retries; the retry policy runs in Postgres.
import { randomUUID } from 'node:crypto'

import { Queue, Worker } from 'bullmq'

type JobData = {
  /** The steward job id, a `jobs` row id. The BullMQ job id is this value plus a UUID suffix. */
  id: string
}

const JOB_NAME = 'job'
const KEEP_COMPLETED = { age: 60 * 60, count: 100 }
const KEEP_FAILED = { age: 24 * 60 * 60, count: 100 }
const PENDING_STATES = ['waiting', 'delayed', 'prioritized'] as const
const PRESENT_STATES = [...PENDING_STATES, 'active'] as const

type JobQueue = {
  /** Adds the id with an optional delay; a no-op when a waiting, delayed or prioritized record exists. */
  enqueue(jobId: string, delayMs?: number): Promise<void>
  /** True while a record exists in waiting, delayed, prioritized or active, so a running job counts. */
  hasJob(jobId: string): Promise<boolean>
  /** Registers the handler and waits until the worker is ready; throws on a second call or after close. */
  startWorker(handler: (jobId: string) => Promise<void>): Promise<void>
  /** Closes the worker, then the queue. A second call is a no-op. */
  close(): Promise<void>
}

/**
 * Creates the BullMQ queue used for delivery. The steward job id travels in the
 * job data. Each BullMQ job gets its own unique id, because BullMQ ignores an add
 * whose id already exists, even for a finished or still-running job, and a retry
 * is enqueued from inside the handler of the job it retries. Enqueueing a job that
 * is already waiting or delayed is a no-op, so duplicates are still avoided.
 */
export function createJobQueue(opts: { redisUrl: string; queueName: string }): JobQueue {
  const { redisUrl, queueName } = opts
  const queue = new Queue<JobData>(queueName, {
    connection: { url: redisUrl },
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: KEEP_COMPLETED,
      removeOnFail: KEEP_FAILED,
    },
  })

  let worker: Worker<JobData, void> | undefined
  let closed = false

  async function has(jobId: string, states: readonly (typeof PRESENT_STATES)[number][]): Promise<boolean> {
    const found = await queue.getJobs([...states])
    return found.some((job) => job.data.id === jobId)
  }

  function hasPending(jobId: string): Promise<boolean> {
    return has(jobId, PENDING_STATES)
  }

  return {
    async enqueue(jobId: string, delayMs = 0): Promise<void> {
      if (await hasPending(jobId)) {
        return
      }
      await queue.add(JOB_NAME, { id: jobId }, { jobId: `${jobId}_${randomUUID()}`, delay: delayMs })
    },

    async hasJob(jobId: string): Promise<boolean> {
      return has(jobId, PRESENT_STATES)
    },

    async startWorker(handler: (jobId: string) => Promise<void>): Promise<void> {
      if (closed) {
        throw new Error('Cannot start a worker on a closed queue')
      }
      if (worker !== undefined) {
        throw new Error('Worker already started')
      }

      worker = new Worker<JobData, void>(
        queueName,
        async (job) => {
          await handler(job.data.id)
        },
        { connection: { url: redisUrl, maxRetriesPerRequest: null } },
      )
      // Processor errors become failed jobs. Connection errors are retried by
      // BullMQ; without a listener Node would treat the event as fatal.
      worker.on('error', () => {
        // Intentionally ignored: the job handler owns its own logging.
      })
      await worker.waitUntilReady()
    },

    async close(): Promise<void> {
      if (closed) {
        return
      }
      closed = true
      if (worker !== undefined) {
        await worker.close()
        worker = undefined
      }
      await queue.close()
    },
  }
}
