// API process entry: reads the environment, binds 127.0.0.1 only, and serves the app.
// The wiring lives in composition/api.ts; this file only starts and stops the process.
import { readFileSync } from 'node:fs'

import { serve } from '@hono/node-server'

import { composeApi } from '../composition/api'
import { loadConfig } from '../platform/config'

const configFile = process.env.STEWARD_CONFIG_FILE
const file: Record<string, unknown> | undefined =
  configFile === undefined ? undefined : (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>)
const config = loadConfig(process.env, file)
const { app, logger, close } = composeApi(config, (line) => process.stdout.write(`${line}\n`))

const server = serve({ fetch: app.fetch, port: config.API_PORT, hostname: '127.0.0.1' }, (info) => {
  logger.info('API listening', { instance: config.INSTANCE, address: info.address, port: info.port })
})

async function shutdown(): Promise<void> {
  server.close()
  await close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
