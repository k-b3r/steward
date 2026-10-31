// Local-only API auth: Host allow-list, Origin allow-list, then the bearer token.
// The token is compared in constant time and never echoed in a response.
import { timingSafeEqual } from 'node:crypto'

import type { MiddlewareHandler } from 'hono'

/**
 * What the local guard needs to refuse a request before any route runs. All four fields come from
 * the validated `Config` (`API_TOKEN`, `API_PORT`, `ALLOWED_ORIGINS`, `ALLOWED_HOSTS`), copied by
 * `src/composition/api.ts`; `src/entries/api.ts` binds the server to `127.0.0.1` on that port. A Host
 * other than `127.0.0.1:<port>`, `localhost:<port>` or one of the extra values is refused with 403,
 * and so is an unlisted Origin; a missing or wrong bearer token is refused with 401.
 * Exported, but `createAuthMiddleware` is the only consumer: `src/api/app.ts` passes its own
 * `AppConfig`, which carries the same four fields.
 */
export type AuthConfig = {
  /** The full `API_TOKEN` value (32+ characters); compared with the bearer token in constant time. */
  apiToken: string
  /** `API_PORT`; the Host header must be exactly `127.0.0.1:<port>` or `localhost:<port>`. */
  port: number
  /** Exact `Origin` values, from `ALLOWED_ORIGINS`; empty by default, which rejects every cross-origin request. */
  allowedOrigins: readonly string[]
  /**
   * Extra exact Host values (lowercase) for a reverse proxy or tunnel, from `ALLOWED_HOSTS`;
   * empty by default, which leaves only the two loopback names.
   */
  allowedHosts: readonly string[]
}

const ALLOW_HEADERS = 'Authorization, Content-Type, Last-Event-ID'
const ALLOW_METHODS = 'GET, POST, OPTIONS'

function isAllowedHost(host: string | undefined, port: number, extraHosts: readonly string[]): boolean {
  if (host === undefined) return false
  const normalized = host.toLowerCase()
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}` || extraHosts.includes(normalized)
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  // timingSafeEqual throws on a length mismatch, so check first and still take constant time.
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer (.+)$/i.exec(header)
  return match?.[1] ?? null
}

export function createAuthMiddleware(config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!isAllowedHost(c.req.header('host'), config.port, config.allowedHosts)) {
      return c.json({ error: 'forbidden' }, 403)
    }

    const origin = c.req.header('origin')
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
      return c.json({ error: 'forbidden' }, 403)
    }

    if (origin !== undefined) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Headers', ALLOW_HEADERS)
      c.header('Access-Control-Allow-Methods', ALLOW_METHODS)
    }

    // A preflight carries no Authorization header; only an allowed Origin reaches this point.
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204)
    }

    const token = bearerToken(c.req.header('authorization'))
    if (token === null || !safeEqual(token, config.apiToken)) {
      return c.json({ error: 'unauthorized' }, 401)
    }

    await next()
  }
}
