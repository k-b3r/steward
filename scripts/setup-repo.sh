#!/usr/bin/env bash
# Clones the repo an instance works on, marks it as steward's, and pins that instance's git identity.
# usage: scripts/setup-repo.sh <instance> <owner/name> [dest]
#   scripts/setup-repo.sh personal k-b3r/scratch-repo
# Needs the gh account that can read the repo; it never stores the token anywhere.
set -euo pipefail

instance="${1:?instance name, e.g. personal}"
repo="${2:?repository, e.g. k-b3r/scratch-repo}"
name="${3:-$(basename "$repo")}"
dest="${4:-$HOME/steward/repos/$instance/$name}"

if ! [[ "$instance" =~ ^[a-z][a-z0-9-]{0,30}$ ]]; then
  echo "instance must match ^[a-z][a-z0-9-]{0,30}$" >&2; exit 1
fi
if [[ -e "$dest" ]]; then
  echo "already exists: $dest"
else
  mkdir -p "$(dirname "$dest")"
  git clone "https://github.com/$repo.git" "$dest"
fi

# The marker: local git config (never committed) and a file inside .git, so a moved clone still
# says which instance owns it. Neither shows up in `git status`.
git -C "$dest" config --local steward.instance "$instance"
git -C "$dest" config --local steward.role "worktree-source"
git -C "$dest" config --local steward.repo "$repo"
printf '{"instance":"%s","repo":"%s","role":"worktree-source"}\n' "$instance" "$repo" > "$dest/.git/steward.json"

# Identity is per clone, so two instances never share a commit author and no `gh auth switch` is
# needed at run time. Set the values this instance should push as, then prove they are local-only.
printf 'instance %s -> %s\n' "$instance" "$dest"
printf '  steward.instance: %s\n' "$(git -C "$dest" config --local steward.instance)"
printf '  author now:       %s <%s>\n' "$(git -C "$dest" config user.name || echo UNSET)" "$(git -C "$dest" config user.email || echo UNSET)"
printf 'Next: set REPO_PATH=%s in ~/.config/steward/%s.env\n' "$dest" "$instance"
