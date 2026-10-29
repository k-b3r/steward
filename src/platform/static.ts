// Serves the built dashboard from the same origin as the API, so no CORS is needed and the
// Content-Security-Policy's `connect-src 'self'` holds.
import { readFileSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

/** A path inside `root`, or null when it escapes it (a `..` segment, or an absolute path). */
export function resolveAssetPath(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath.split('?')[0] ?? '/')
  } catch {
    // A malformed escape is not an asset: treat it like a missing file.
    return null
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  // Normalise the root too: a root such as /srv/x/../dist would otherwise never prefix its own files.
  const base = resolve(root)
  const resolved = normalize(join(base, relative))
  if (!resolved.startsWith(base.endsWith(sep) ? base : base + sep)) return null
  return resolved
}

export type StaticFile = { body: ArrayBuffer; contentType: string }

/** Reads a file under `root`; null when it is missing, a directory, or outside the root. */
export function readStaticFile(root: string, requestPath: string): StaticFile | null {
  const path = resolveAssetPath(root, requestPath)
  if (path === null) return null
  try {
    if (!statSync(path).isFile()) return null
    const extension = path.slice(path.lastIndexOf('.'))
    const file = readFileSync(path)
    // A standalone ArrayBuffer, which Response accepts as a body.
    const body = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
    return { body, contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream' }
  } catch {
    return null
  }
}

/** The response for a dashboard request, or null when there is nothing to serve (the caller answers 404). */
export function staticResponse(root: string, requestPath: string): Response | null {
  const file = readStaticFile(root, requestPath)
  if (file === null) return null
  return new Response(file.body, {
    status: 200,
    // nosniff: the browser must trust the type we send, never guess one from the bytes.
    headers: { 'Content-Type': file.contentType, 'X-Content-Type-Options': 'nosniff' },
  })
}
