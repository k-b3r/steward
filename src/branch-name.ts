// Pure: the branch a job works on is its ticket identifier, with no prefix and no case change.

/**
 * `INV-12` stays `INV-12`. A character git refuses in a branch name becomes `-`, and a leading
 * `-` run is dropped because git would read the branch name as an option.
 */
export function branchName(identifier: string): string {
  const name = identifier.replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+/, '')
  if (name === '') {
    throw new Error(`The ticket identifier ${JSON.stringify(identifier)} has no usable branch name`)
  }
  return name
}
