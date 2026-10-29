// Builds the HTTP app with everything it needs. This is the only place in the API path that
// knows the database, the queue and the runner; src/api/ itself is HTTP only.

import { createContext } from '../bootstrap'
import type { Config } from '../platform/config'
import { sleep } from '../platform/delay'
import { closePool } from '../platform/db'
import { readTranscript } from '../runner/transcript'
import * as store from '../db/store'
import { getJob, listActions, listJobs } from '../jobs-queries'
import { cancelJob, confirmJob, decideAction, declineJob, reconsiderJob, retryJob } from '../jobs-commands'
import { createApp } from '../api/app'
import { readStaticFile } from '../platform/static'

export function composeApi(config: Config, write: (line: string) => void) {
  const ctx = createContext(config, write)
  const { db, runner, queue } = ctx

  // The composition root is the only place that knows both the database and the HTTP layer.
  const commandDeps = {
    store: {
      getJob: (id: string) => store.getJob(db, id),
      getAction: (id: string) => store.getAction(db, id),
      transitionJob: (
        id: string,
        to: Parameters<typeof store.transitionJob>[2],
        opts: Parameters<typeof store.transitionJob>[3],
      ) => store.transitionJob(db, id, to, opts),
      decideAction: (id: string, decision: 'approved' | 'rejected', opts: { now: Date; reason?: string }) =>
        store.decideAction(db, id, decision, opts),
    },
    clock: ctx.clock,
    enqueue: (jobId: string) => queue.enqueue(jobId),
    cancelRun: (jobId: string) => runner.cancel(jobId),
  }

  const queryStore = {
    getJob: (id: string) => store.getJob(db, id),
    listJobs: (filter?: Parameters<typeof store.listJobs>[1]) => store.listJobs(db, filter),
    listActions: (filter?: Parameters<typeof store.listActions>[1]) => store.listActions(db, filter),
  }

  const app = createApp({
    reads: {
      getJob: (id) => getJob({ store: queryStore }, id),
      listJobs: (filter) => listJobs({ store: queryStore }, filter),
      listActions: (filter) => listActions({ store: queryStore }, filter),
    },
    commands: {
      confirm: (id) => confirmJob(commandDeps, id),
      decline: (id, reason) => declineJob(commandDeps, id, reason),
      reconsider: (id) => reconsiderJob(commandDeps, id),
      retry: (id) => retryJob(commandDeps, id),
      cancel: (id) => cancelJob(commandDeps, id),
      decideAction: (id, decision, reason) => decideAction(commandDeps, id, decision, reason),
    },
    readLog: (jobId, afterSeq) => Promise.resolve(readTranscript(runner.transcriptDir(jobId), afterSeq)),
    config: {
      apiToken: config.API_TOKEN,
      port: config.API_PORT,
      allowedOrigins: config.ALLOWED_ORIGINS,
      allowedHosts: config.ALLOWED_HOSTS,
    },
    sleep,
  })

  // The built dashboard, served from the same origin as the API. Absent before the first build,
  // in which case the API answers only /v1.
  const dashboardDir = config.DASHBOARD_DIR
  const withStatic =
    dashboardDir === undefined
      ? app
      : app.get('*', (c) => {
          const file = readStaticFile(dashboardDir, c.req.path)
          if (file === null) return c.notFound()
          return new Response(file.body, { status: 200, headers: { 'Content-Type': file.contentType } })
        })

  const close = async (): Promise<void> => {
    await queue.close()
    await closePool(ctx.pool)
  }

  return { app: withStatic, logger: ctx.logger, close }
}
