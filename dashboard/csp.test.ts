import { describe, expect, it } from 'vitest'

import { CONTENT_SECURITY_POLICY, withCsp } from './csp'

function directive(name: string): string[] {
  const found = CONTENT_SECURITY_POLICY.split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
  if (found === undefined) throw new Error(`directive ${name} is missing`)
  return found.split(/\s+/).slice(1)
}

const PAGE = '<!doctype html>\n<html>\n  <head>\n    <title>Steward</title>\n  </head>\n  <body></body>\n</html>\n'

describe('CONTENT_SECURITY_POLICY', () => {
  it('denies everything that is not listed', () => {
    expect(directive('default-src')).toEqual(["'none'"])
  })

  it('allows scripts only from the same origin, with no inline or eval', () => {
    expect(directive('script-src')).toEqual(["'self'"])
  })

  it('limits network calls to the same origin, where the API proxy lives', () => {
    expect(directive('connect-src')).toEqual(["'self'"])
  })

  it('blocks <base> rewriting and form posts', () => {
    expect(directive('base-uri')).toEqual(["'none'"])
    expect(directive('form-action')).toEqual(["'none'"])
  })

  it('never allows eval or inline script anywhere', () => {
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
    expect(directive('script-src')).not.toContain("'unsafe-inline'")
  })
})

describe('withCsp', () => {
  it('puts one policy meta tag first in <head>', () => {
    const html = withCsp(PAGE)

    expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1)
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'))
    expect(html).toContain(`content="${CONTENT_SECURITY_POLICY}"`)
  })

  it('is idempotent', () => {
    expect(withCsp(withCsp(PAGE))).toBe(withCsp(PAGE))
  })

  it('fails loudly when there is no <head>, so a build never ships without a policy', () => {
    expect(() => withCsp('<html><body></body></html>')).toThrow(/head/)
  })
})
