// Pure parsers for the staged diff's `--name-status` and `--numstat` output. Both expect `-z`, so a
// path with a space, a tab or a newline is one NUL-terminated field; a cut record throws.

import type { ChangedFile } from './validation-policy'

const NUL = '\0'
const RENAME_OR_COPY = /^([RC])\d*$/

export type NameStatusEntry = { path: string; oldPath?: string; status: 'A' | 'M' | 'D' | 'R' }
export type NumstatEntry = { added: number; deleted: number }

function records(output: string): string[] {
  const fields = output.split(NUL)
  // `-z` ends every record with a NUL, which leaves one empty field at the end.
  if (fields.at(-1) === '') fields.pop()
  return fields
}

function field(fields: readonly string[], index: number, context: string): string {
  const value = fields[index]
  if (value === undefined) throw new Error(`truncated git output: ${context} has no path`)
  return value
}

/**
 * Reads `git diff --cached -M --name-status -z` in git's order. A rename (`R100\0old\0new\0`) covers
 * both paths; a copy is an addition of the new path; any other code, `T` included, is a modification.
 */
export function parseDiffNameStatus(output: string): NameStatusEntry[] {
  const fields = records(output)
  const entries: NameStatusEntry[] = []
  let index = 0
  while (index < fields.length) {
    const code = field(fields, index, 'a status code')
    index += 1

    const twoPaths = RENAME_OR_COPY.exec(code)
    if (twoPaths !== null) {
      const oldPath = field(fields, index, code)
      const path = field(fields, index + 1, code)
      index += 2
      entries.push(twoPaths[1] === 'R' ? { status: 'R', path, oldPath } : { status: 'A', path })
      continue
    }

    const path = field(fields, index, code)
    index += 1
    entries.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', path })
  }
  return entries
}

function count(raw: string): number {
  // A binary file has no line counts (`-`); a malformed field is refused, never read as 0.
  if (raw === '-') return 0
  if (!/^\d+$/.test(raw)) throw new Error(`invalid line count in numstat output: ${JSON.stringify(raw)}`)
  return Number(raw)
}

/**
 * Reads `git diff --cached -M --numstat -z`, keyed by the new path. A record is
 * `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0old\0new\0`: the path is everything
 * after the first two tabs, so a tab inside one stays intact.
 */
export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const fields = records(output)
  const counts = new Map<string, NumstatEntry>()
  let index = 0
  while (index < fields.length) {
    const record = field(fields, index, 'a numstat record')
    index += 1

    const firstTab = record.indexOf('\t')
    const secondTab = record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) throw new Error(`numstat record has no counts: ${JSON.stringify(record)}`)

    const added = count(record.slice(0, firstTab))
    const deleted = count(record.slice(firstTab + 1, secondTab))
    const path = record.slice(secondTab + 1)
    if (path !== '') {
      counts.set(path, { added, deleted })
      continue
    }
    // An empty path means a rename or a copy: the old path follows, then the new one.
    const newPath = field(fields, index + 1, 'a rename')
    index += 2
    counts.set(newPath, { added, deleted })
  }
  return counts
}

/** Pairs the statuses with the counts by new path; a missing count is 0/0, never an inflated size. */
export function joinChangedFiles(
  nameStatus: readonly NameStatusEntry[],
  numstat: ReadonlyMap<string, NumstatEntry>,
): ChangedFile[] {
  return nameStatus.map((entry) => {
    const counts = numstat.get(entry.path)
    const file: ChangedFile = {
      path: entry.path,
      status: entry.status,
      added: counts?.added ?? 0,
      deleted: counts?.deleted ?? 0,
    }
    return entry.oldPath === undefined ? file : { ...file, oldPath: entry.oldPath }
  })
}
