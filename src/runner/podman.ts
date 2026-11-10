// The real Podman effects the Pi runner needs: a spawned container and a kill. All the process
// work lives here, so the runner itself stays a state machine over injected effects. The ambient
// environment is passed in by the composition root; this file reads no environment of its own.
import { spawn as spawnProcess } from 'node:child_process'

import type { PiChild } from './pi'

export type PodmanSpawn = (cmd: string, args: string[], opts: { env: Record<string, string> }) => PiChild

/**
 * The ambient variables the `podman` client needs to find its binary, its rootless socket and its
 * config. Everything else, the Linear key and the API token included, stays out of the child: the
 * client only talks to the container engine, and the agent inside never sees the host environment.
 */
const PODMAN_AMBIENT = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  'CONTAINERS_CONF',
  'CONTAINERS_STORAGE_CONF',
]

function allowedAmbient(ambient: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of PODMAN_AMBIENT) {
    const value = ambient[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * Spawns `podman run`. The child gets the allowlisted ambient variables plus the names the runner
 * forwards (the model key), so `podman` resolves on PATH and finds its own configuration; nothing
 * else from the host environment is added.
 */
export function createPodmanSpawn(ambient: Readonly<Record<string, string | undefined>>): PodmanSpawn {
  return (cmd, args, opts) => {
    const child = spawnProcess(cmd, args, {
      env: { ...allowedAmbient(ambient), ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exit: new Promise((resolve) => {
        child.on('error', () => resolve({ code: null, signal: null }))
        child.on('close', (code, signal) => resolve({ code, signal }))
      }),
      kill: () => {
        child.kill('SIGTERM')
      },
    }
  }
}
