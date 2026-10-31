#!/usr/bin/env node
// Checks docs/flows/*.md against the code, so a flow document cannot drift silently.
// 1. A fenced block after a `Source: `path`` line must be a verbatim, contiguous copy of that file.
// 2. Every path written in backticks under src/ tests/ scripts/ deploy/ dashboard/ docs/ must exist.
// 3. A mermaid state diagram may only use job states that exist in src/types.ts.
// 4. A test title cited in the last cell of a table row must exist in some test file.
// usage: node scripts/check-flows.mjs [file.md ...]   (default: every file in docs/flows)
import { existsSync, readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const files = process.argv.length > 2 ? process.argv.slice(2) : globSync('docs/flows/*.md', { cwd: root }).sort()
const norm = (text) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const tests = [
  ...globSync('src/**/*.test.ts', { cwd: root }),
  ...globSync('tests/**/*.ts', { cwd: root }),
  ...globSync('dashboard/src/**/*.test.ts*', { cwd: root }),
  ...globSync('scripts/*.test.sh', { cwd: root }),
  ...globSync('deploy/*.test.sh', { cwd: root }),
]
const testsBlob = tests.map(read).join('\n')
const states = new Set([...read('src/types.ts').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]))

let problems = 0
const report = (file, line, message) => {
  console.log(`${file}:${line}: ${message}`)
  problems += 1
}

for (const file of files) {
  const lines = read(file).split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const source = lines[i].match(/^(\s*)Source:\s*`([^`]+)`/)
    if (source !== null) {
      const indent = source[1].length
      const path = source[2]
      let open = i + 1
      while (open < lines.length && lines[open].trim() === '') open += 1
      if (!lines[open]?.trim().startsWith('```')) {
        report(file, i + 1, 'a "Source:" line is not followed by a code block')
        continue
      }
      let close = open + 1
      const body = []
      while (close < lines.length && !lines[close].trim().startsWith('```')) {
        body.push(lines[close].slice(indent))
        close += 1
      }
      const snippet = norm(body.join('\n'))
      if (!existsSync(resolve(root, path))) {
        report(file, i + 1, `source file missing: ${path}`)
      } else if (!norm(read(path)).includes(snippet)) {
        report(file, open + 1, `snippet is not a verbatim excerpt of ${path}`)
      }
      i = close
    }
  }

  lines.forEach((line, index) => {
    for (const match of line.matchAll(/`((?:src|tests|scripts|deploy|dashboard|docs)\/[A-Za-z0-9_./@-]+)`/g)) {
      const path = match[1].replace(/[.,:;]+$/, '')
      if (!existsSync(resolve(root, path))) report(file, index + 1, `path does not exist: ${path}`)
    }
  })

  const text = lines.join('\n')
  for (const block of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) {
    if (!block[1].includes('stateDiagram')) continue
    for (const edge of block[1].matchAll(/([a-z_]+)\s*-->\s*([a-z_]+)/g)) {
      for (const state of [edge[1], edge[2]]) {
        if (!states.has(state) && state !== 'start' && state !== 'end') {
          report(file, 0, `mermaid uses unknown state "${state}"`)
        }
      }
    }
  }

  lines.forEach((line, index) => {
    if (!line.startsWith('|')) return
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
    if (cells.length < 3) return
    for (const match of cells.at(-1).matchAll(/`([^`]+)`/g)) {
      const title = match[1].replace(/^it\((['"])(.*)\1\)$/, '$2')
      if (/[<>=]|\.(ts|sh|md|json)\b|^(src|tests|scripts|deploy)\//.test(title)) continue
      if (title.split(' ').length < 3) continue
      const pattern = title
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('%s', '.+')
        .replaceAll('%j', '.+')
      if (!testsBlob.includes(title) && !new RegExp(pattern).test(testsBlob)) {
        report(file, index + 1, `cited test title not found: "${title}"`)
      }
    }
  })
}

console.log(problems === 0 ? `OK (${files.length} file(s))` : `${problems} problem(s)`)
process.exit(problems === 0 ? 0 : 1)
