// Content-Security-Policy for the production build. The token lives in sessionStorage, so the
// page must not run injected script: scripts come from this origin only, with no inline or eval.
// Styles allow inline because the icon sprite and React's style props need it; CSS cannot run script.
// connect-src is the same origin because the API is reached through a same-origin proxy.
// A <meta> tag cannot set frame-ancestors; add that header wherever the built files are served.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const META = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`

/** Adds the policy as the first element of <head>. Throws if there is no <head>, so a build cannot ship without it. */
export function withCsp(html: string): string {
  if (html.includes('http-equiv="Content-Security-Policy"')) return html
  if (!html.includes('<head>')) throw new Error('index.html has no <head> to put the Content-Security-Policy in')
  return html.replace('<head>', `<head>\n    ${META}`)
}
