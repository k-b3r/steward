import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { withCsp } from './csp'

// The API only accepts Host 127.0.0.1:<port> or localhost:<port>, so the proxy rewrites Host
// (changeOrigin). The browser Origin (http://localhost:5173) must be in ALLOWED_ORIGINS.
const API = process.env.STEWARD_API ?? 'http://127.0.0.1:3000'

export default defineConfig({
  // The dev server needs inline scripts for hot reload, so the policy goes into the build only.
  plugins: [react(), { name: 'steward-csp', apply: 'build', transformIndexHtml: { order: 'post', handler: withCsp } }],
  // No data: URIs for small assets, so font-src can stay 'self'.
  build: { assetsInlineLimit: 0 },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/v1': { target: API, changeOrigin: true } } },
})
