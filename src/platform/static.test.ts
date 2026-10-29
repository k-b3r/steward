import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readStaticFile, resolveAssetPath, staticResponse } from './static'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'steward-static-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html>')
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'not for the browser')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveAssetPath', () => {
  it('maps the root to index.html', () => {
    expect(resolveAssetPath(root, '/')).toBe(join(root, 'index.html'))
  })

  it('maps a nested file', () => {
    expect(resolveAssetPath(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'))
  })

  it('refuses a path that climbs out of the root', () => {
    expect(resolveAssetPath(root, '/../secret.txt')).toBeNull()
    expect(resolveAssetPath(root, '/../../etc/passwd')).toBeNull()
    expect(resolveAssetPath(root, '/assets/../../secret.txt')).toBeNull()
  })

  it('refuses an encoded climb', () => {
    expect(resolveAssetPath(root, '/%2e%2e/secret.txt')).toBeNull()
    expect(resolveAssetPath(root, '/%2e%2e/secret')).toBeNull()
  })

  it('decodes a valid percent escape', () => {
    writeFileSync(join(root, 'a b.txt'), 'spaced')

    expect(resolveAssetPath(root, '/a%20b.txt')).toBe(join(root, 'a b.txt'))
  })

  it('refuses a malformed percent escape instead of throwing', () => {
    expect(resolveAssetPath(root, '/%zz')).toBeNull()
    expect(resolveAssetPath(root, '/%E0%A4%A')).toBeNull()
  })
})

describe('readStaticFile', () => {
  it('reads a file with its content type', () => {
    const file = readStaticFile(root, '/assets/app.js')

    expect(file?.contentType).toBe('text/javascript; charset=utf-8')
    expect(new TextDecoder().decode(file?.body ?? new ArrayBuffer(0))).toBe('console.log(1)')
  })

  it('serves the page for the root', () => {
    expect(readStaticFile(root, '/')?.contentType).toBe('text/html; charset=utf-8')
  })

  it('returns null for a missing file, a directory, and a traversal attempt', () => {
    expect(readStaticFile(root, '/missing.js')).toBeNull()
    expect(readStaticFile(root, '/assets')).toBeNull()
    expect(readStaticFile(root, '/../secret.txt')).toBeNull()
  })

  it('returns null for a malformed percent escape instead of throwing', () => {
    expect(readStaticFile(root, '/%zz')).toBeNull()
    expect(readStaticFile(root, '/%E0%A4%A')).toBeNull()
  })

  it('ignores a query string', () => {
    expect(new TextDecoder().decode(readStaticFile(root, '/assets/app.js?v=2')?.body ?? new ArrayBuffer(0))).toBe(
      'console.log(1)',
    )
  })
})

describe('staticResponse', () => {
  it('answers 200 with the content type and nosniff', async () => {
    const response = staticResponse(root, '/')

    expect(response?.status).toBe(200)
    expect(response?.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await response?.text()).toContain('<')
  })

  it('returns null for a missing file, so the caller answers 404', () => {
    expect(staticResponse(root, '/no-such-file.js')).toBeNull()
  })

  it('returns null for a traversal path and for a malformed escape', () => {
    expect(staticResponse(root, '/../secret.txt')).toBeNull()
    expect(staticResponse(root, '/%2e%2e/secret.txt')).toBeNull()
    expect(staticResponse(root, '/%zz')).toBeNull()
  })
})
