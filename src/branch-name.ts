// Pure: the branch a job works on is its ticket identifier, with no prefix and no case change.

/** `INV-12` stays `INV-12`. A character git refuses in a branch name becomes `-`. */
export function branchName(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9-]/g, '-')
}
