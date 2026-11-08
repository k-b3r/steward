// Pure: the branch a job works on is its ticket identifier under `agent/`, lowercased.

/** `INV-12` becomes `agent/inv-12`. A character git refuses in a branch name becomes `-`. */
export function branchName(identifier: string): string {
  return `agent/${identifier.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
}
