// Git exports GIT_DIR and related variables to hooks (the pre-push hook runs this suite).
// They would send the `git -C <temp repo>` calls in these tests to this repository instead.
const GIT_LOCATION_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
]

for (const name of GIT_LOCATION_VARIABLES) {
  delete process.env[name]
}
