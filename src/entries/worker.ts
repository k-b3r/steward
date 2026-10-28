// Worker process entry: reads the environment and runs the worker until told to stop.
// The wiring lives in composition/worker.ts; this file only starts and stops the process.
import { readFileSync } from 'node:fs'

import { composeWorker } from '../composition/worker'
import { loadConfig } from '../platform/config'

const configFile = process.env.STEWARD_CONFIG_FILE
const file: Record<string, unknown> | undefined =
  configFile === undefined ? undefined : (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>)
const config = loadConfig(process.env, file)
const worker = composeWorker(config, (line) => process.stdout.write(`${line}\n`))

async function shutdown(): Promise<void> {
  await worker.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

await worker.start()
await worker.poll()
