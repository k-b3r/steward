#!/usr/bin/env bash
# Clones the repo an instance works on, marks it as steward's, and pins that instance's git identity.
# usage: scripts/setup-repo.sh <instance> <owner/name> [dest]
#   scripts/setup-repo.sh personal k-b3r/scratch-repo
# Reads GH_ACCOUNT, GIT_USER_NAME and GIT_USER_EMAIL from the environment, or else from
# ~/.config/steward/<instance>.env (the file is parsed, never run as shell code). Clones with that
# account's token and never stores the token anywhere.
set -euo pipefail

instance="${1:?instance name, e.g. personal}"
repo="${2:?repository, e.g. k-b3r/scratch-repo}"
name="${3:-$(basename "$repo")}"
dest="${4:-$HOME/steward/repos/$instance/$name}"

if ! [[ "$instance" =~ ^[a-z][a-z0-9-]{0,30}$ ]]; then
  echo "instance must match ^[a-z][a-z0-9-]{0,30}$" >&2; exit 1
fi

# Identity comes from the instance env file, the same values the container will be given.
# shellcheck source=lib/read-env.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/read-env.sh"
# shellcheck source=lib/json.sh
source "$(cd "$(dirname "$0")" && pwd)/lib/json.sh"
env_file="${STEWARD_ENV_FILE:-$HOME/.config/steward/$instance.env}"
for key in GH_ACCOUNT GIT_USER_NAME GIT_USER_EMAIL; do
  if [[ -z "${!key:-}" ]] && value="$(read_env_value "$env_file" "$key")"; then
    printf -v "$key" '%s' "$value"
  fi
done
: "${GH_ACCOUNT:?GH_ACCOUNT is not set (expected in $env_file)}"
: "${GIT_USER_NAME:?GIT_USER_NAME is not set (expected in $env_file)}"
: "${GIT_USER_EMAIL:?GIT_USER_EMAIL is not set (expected in $env_file)}"
if [[ -e "$dest" ]]; then
  echo "already exists: $dest"
else
  mkdir -p "$(dirname "$dest")"
  # git ignores GH_TOKEN on its own: it has to ask gh for the token, so the configured account
  # is the one used even when another account is active.
  GH_TOKEN="$(gh auth token --user "$GH_ACCOUNT")" \
    git -c credential.helper='!gh auth git-credential' clone "https://github.com/$repo.git" "$dest"
fi

# The marker: local git config (never committed) and a file inside .git, so a moved clone still
# says which instance owns it. Neither shows up in `git status`.
git -C "$dest" config --local steward.instance "$instance"
git -C "$dest" config --local steward.role "worktree-source"
git -C "$dest" config --local steward.repo "$repo"
printf '{"instance":"%s","repo":"%s","role":"worktree-source","account":"%s"}\n' \
  "$(json_escape "$instance")" "$(json_escape "$repo")" "$(json_escape "$GH_ACCOUNT")" >"$dest/.git/steward.json"

# The clone authors as the instance says, so the orchestrator's commits and the agent's agree.
git -C "$dest" config --local user.name "$GIT_USER_NAME"
git -C "$dest" config --local user.email "$GIT_USER_EMAIL"
git -C "$dest" config --local steward.account "$GH_ACCOUNT"

# Identity is per clone, so two instances never share a commit author and no `gh auth switch` is
# needed at run time. Set the values this instance should push as, then prove they are local-only.
printf 'instance %s -> %s\n' "$instance" "$dest"
printf '  steward.instance: %s\n' "$(git -C "$dest" config --local steward.instance)"
printf '  steward.account:  %s\n' "$(git -C "$dest" config --local steward.account)"
printf '  author now:       %s <%s>\n' "$(git -C "$dest" config user.name || echo UNSET)" "$(git -C "$dest" config user.email || echo UNSET)"
printf 'Next: set REPO_PATH=%s in ~/.config/steward/%s.env\n' "$dest" "$instance"
