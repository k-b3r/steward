// API entry point: reads the environment, binds 127.0.0.1 only, and serves the app.
import { readFileSync } from 'node:fs'

import { serve } from '@hono/node-server'

import { createContext } from '../bootstrap'
import { loadConfig } from '../platform/config'
import { sleep } from '../platform/delay'
import { closePool } from '../platform/db'
import { readTranscript } from '../runner/transcript'
import * as store from '../db/store'
import { cancelJob, confirmJob, decideAction, declineJob, reconsiderJob, retryJob } from '../jobs-commands'
import { createApp } from './app'

const configFile = process.env.STEWARD_CONFIG_FILE
const file: Record<string, unknown> | undefined =
  configFile === undefined ? undefined : (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>)
const config = loadConfig(process.env, file)
const ctx = createContext(config, (line) => process.stdout.write(`${line}\n`))
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

const app = createApp({
  queries: {
    getJob: (id) => store.getJob(db, id),
    listJobs: (filter) => store.listJobs(db, filter),
    listActions: (filter) => store.listActions(db, filter),
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
  config: { apiToken: config.API_TOKEN, port: config.API_PORT, allowedOrigins: config.ALLOWED_ORIGINS },
  sleep,
})

const server = serve({ fetch: app.fetch, port: config.API_PORT, hostname: '127.0.0.1' }, (info) => {
  ctx.logger.info('API listening', { instance: config.INSTANCE, address: info.address, port: info.port })
})

async function shutdown(): Promise<void> {
  server.close()
  await queue.close()
  await closePool(ctx.pool)
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
