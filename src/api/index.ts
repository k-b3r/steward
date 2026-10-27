// API entry point: reads the environment, binds 127.0.0.1 only, and serves the app.
import { readFileSync } from 'node:fs'

import { serve } from '@hono/node-server'

import { createContext } from '../bootstrap'
import { loadConfig } from '../platform/config'
import { sleep } from '../platform/delay'
import { closePool } from '../platform/db'
import { readTranscript } from '../runner/transcript'
import * as store from '../db/store'
import { createApp } from './app'

const configFile = process.env.STEWARD_CONFIG_FILE
const file: Record<string, unknown> | undefined =
  configFile === undefined ? undefined : (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>)
const config = loadConfig(process.env, file)
const ctx = createContext(config, (line) => process.stdout.write(`${line}\n`))
const { db, runner, queue } = ctx

const app = createApp({
  store: {
    getJob: (id) => store.getJob(db, id),
    listJobs: (filter) => store.listJobs(db, filter),
    transitionJob: (id, to, opts) => store.transitionJob(db, id, to, opts),
    listActions: (filter) => store.listActions(db, filter),
    decideAction: (id, decision, opts) => store.decideAction(db, id, decision, opts),
  },
  enqueue: (jobId) => queue.enqueue(jobId),
  cancelRun: (jobId) => runner.cancel(jobId),
  readLog: (jobId, afterSeq) => Promise.resolve(readTranscript(runner.transcriptDir(jobId), afterSeq)),
  clock: ctx.clock,
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
