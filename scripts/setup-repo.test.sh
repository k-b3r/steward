#!/usr/bin/env bash
# Tests for scripts/lib/read-env.sh and the default paths of scripts/setup-repo.sh.
# Run: bash scripts/setup-repo.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/read-env.sh
source "$here/lib/read-env.sh"
# shellcheck source=lib/json.sh
source "$here/lib/json.sh"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0; n=0
check() { n=$((n + 1)); if [[ "$2" == "$3" ]]; then echo "ok $n - $1"; else echo "not ok $n - $1 (got '$2', want '$3')"; fail=1; fi; }

cat >"$tmp/a.env" <<EOT
# a comment
GH_ACCOUNT=octo
GIT_USER_NAME="Octo Cat"
GIT_USER_EMAIL='octo@example.test'
EMPTY=
SPACED =nope
GH_ACCOUNT=later-wins
EOT

check "plain value" "$(read_env_value "$tmp/a.env" GIT_USER_NAME)" "Octo Cat"
check "single quotes are stripped" "$(read_env_value "$tmp/a.env" GIT_USER_EMAIL)" "octo@example.test"
check "the last assignment wins, like sourcing would" "$(read_env_value "$tmp/a.env" GH_ACCOUNT)" "later-wins"
check "an empty value is found and empty" "$(read_env_value "$tmp/a.env" EMPTY; echo "[$?]")" "[0]"
read_env_value "$tmp/a.env" MISSING >/dev/null; check "a missing key returns failure" "$?" "1"
read_env_value "$tmp/none.env" GH_ACCOUNT >/dev/null; check "a missing file returns failure" "$?" "1"
check "a key must start the line" "$(read_env_value "$tmp/a.env" NAME; echo "[$?]")" "[1]"

# The point of the library: nothing in the file is ever executed.
marker="$tmp/pwned"
cat >"$tmp/evil.env" <<EOT
GIT_USER_NAME=\$(touch $marker)
GIT_USER_EMAIL=\`touch $marker\`
GH_ACCOUNT=ok; touch $marker
EOT
name="$(read_env_value "$tmp/evil.env" GIT_USER_NAME)"
check "command substitution is kept as text" "$name" "\$(touch $marker)"
read_env_value "$tmp/evil.env" GIT_USER_EMAIL >/dev/null
read_env_value "$tmp/evil.env" GH_ACCOUNT >/dev/null
check "nothing in the file ran" "$([[ -e "$marker" ]] && echo ran || echo clean)" "clean"

# json_escape must make any value safe inside a JSON string.
check "json: plain text is unchanged" "$(json_escape 'k-b3r/steward')" "k-b3r/steward"
check "json: a double quote is escaped" "$(json_escape 'a"b')" 'a\"b'
check "json: a backslash is escaped" "$(json_escape 'a\b')" 'a\\b'
doc="$(printf '{"repo":"%s"}' "$(json_escape 'we"ird\name')")"
if command -v python3 >/dev/null; then
  check "json: the document parses and round-trips" "$(printf '%s' "$doc" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repo"])')" 'we"ird\name'
fi

# setup-repo.sh's defaults: the env file and the clone dest both live under ~/steward-instances/<instance>.
# The dest already exists, so the script only marks it, and a fake git keeps this offline.
fake_home="$tmp/home"
mkdir -p "$fake_home/steward-instances/personal/repo/.git" "$tmp/bin"
cat >"$fake_home/steward-instances/personal/.env" <<EOT
GH_ACCOUNT=octo
GIT_USER_NAME="Octo Cat"
GIT_USER_EMAIL='octo@example.test'
EOT
printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/git"; chmod +x "$tmp/bin/git"
setup_out="$(env -u GH_ACCOUNT -u GIT_USER_NAME -u GIT_USER_EMAIL -u STEWARD_ENV_FILE \
  HOME="$fake_home" PATH="$tmp/bin:$PATH" "$here/setup-repo.sh" personal octo/repo 2>&1)"
check "the default dest is ~/steward-instances/<instance>/repo" \
  "$(printf '%s\n' "$setup_out" | grep -Fxc "instance personal -> $fake_home/steward-instances/personal/repo")" "1"
check "the Next line names the instance env file" \
  "$(printf '%s\n' "$setup_out" | grep -Fxc "Next: set REPO_PATH=$fake_home/steward-instances/personal/repo in ~/steward-instances/personal/.env")" "1"

echo "$n checks, $([[ $fail -eq 0 ]] && echo 0 || echo some) failures"
exit $fail
