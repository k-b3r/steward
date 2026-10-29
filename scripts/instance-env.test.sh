#!/usr/bin/env bash
# Tests for scripts/instance-env.sh. Run: bash scripts/instance-env.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/instance-env.sh"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0; n=0
check() { n=$((n + 1)); if [[ "$2" == "$3" ]]; then echo "ok $n - $1"; else echo "not ok $n - $1 (got '$2', want '$3')"; fail=1; fi; }

err="$tmp/stderr"
root="$tmp/instances"
# run: the script under a clean environment, with any extra VAR=value assignments first, and its
# stderr kept out of the captured stdout.
run() { env -u STEWARD_ENV_FILE -u STEWARD_INSTANCE STEWARD_INSTANCES_DIR="$root" "$@" bash "$script"; }

check "the script is executable" "$([[ -x "$script" ]] && echo yes || echo no)" "yes"

mkdir -p "$root/alpha" "$root/beta"
printf 'A=1\n' >"$root/alpha/.env"
printf 'B=2\n' >"$root/beta/.env"
printf 'EXPLICIT=1\n' >"$tmp/explicit.env"

out="$(run STEWARD_ENV_FILE="$tmp/explicit.env" 2>"$err")"; rc=$?
check "explicit STEWARD_ENV_FILE: exit 0" "$rc" "0"
check "explicit STEWARD_ENV_FILE wins over the instances" "$out" "$tmp/explicit.env"
check "explicit STEWARD_ENV_FILE: stderr is empty" "$(cat "$err")" ""

out="$(run STEWARD_INSTANCE=beta 2>"$err")"; rc=$?
check "STEWARD_INSTANCE picks its folder" "$out" "$root/beta/.env"
check "STEWARD_INSTANCE: exit 0, stderr empty" "$rc:$([[ -s "$err" ]] && echo err || echo clean)" "0:clean"

for bad in Beta beta_x -beta a.b 'beta/../alpha' "$(printf 'a%.0s' {1..32})"; do
  out="$(run STEWARD_INSTANCE="$bad" 2>"$err")"; rc=$?
  check "invalid instance name '$bad' is rejected" "$rc" "1"
  check "invalid instance name '$bad': stdout is empty" "$out" ""
  check "invalid instance name '$bad': the message gives the rule" "$(grep -c 'a-z0-9' "$err")" "1"
done

out="$(run 2>"$err")"; rc=$?
check "several instances found: fails" "$rc" "1"
check "several instances found: stdout is empty" "$out" ""
check "several instances found: the message names alpha" "$(grep -c alpha "$err")" "1"
check "several instances found: the message names beta" "$(grep -c beta "$err")" "1"
check "several instances found: the message says to set STEWARD_INSTANCE" "$(grep -c STEWARD_INSTANCE "$err")" "1"
check "an empty STEWARD_INSTANCE counts as unset" "$(run STEWARD_INSTANCE= 2>/dev/null; echo "[$?]")" "[1]"

mkdir -p "$root/personal-2"
printf 'P=1\n' >"$root/personal-2/.env"
out="$(run STEWARD_INSTANCE=personal-2 2>"$err")"; rc=$?
check "lowercase letters, digits and dashes are valid" "$out" "$root/personal-2/.env"
check "lowercase letters, digits and dashes: exit 0" "$rc" "0"

# Only folders that hold a .env are instances; folders and plain files that do not are ignored.
rm -rf "$root/beta" "$root/personal-2"
mkdir -p "$root/noenv"
: >"$root/stray-file"
out="$(run 2>"$err")"; rc=$?
check "a single instance is auto-picked" "$out" "$root/alpha/.env"
check "a single instance is auto-picked: exit 0" "$rc" "0"
check "a folder without .env is not an instance, and nothing goes to stderr" "$(cat "$err")" ""

mkdir -p "$root/gamma"
out="$(run STEWARD_INSTANCE=gamma 2>"$err")"; rc=$?
check "a named instance without .env fails" "$rc" "1"
check "a named instance without .env: stdout is empty" "$out" ""
check "a named instance without .env: the message names the file" "$(grep -cF "$root/gamma/.env" "$err")" "1"

out="$(run STEWARD_INSTANCE=ghost 2>"$err")"; rc=$?
check "a named instance that does not exist fails" "$rc" "1"
check "a named instance that does not exist: stdout is empty" "$out" ""

out="$(run STEWARD_ENV_FILE="$tmp/nope.env" 2>"$err")"; rc=$?
check "an explicit STEWARD_ENV_FILE that does not exist fails" "$rc" "1"
check "an explicit STEWARD_ENV_FILE that does not exist: stdout is empty" "$out" ""

if [[ "$(id -u)" != "0" ]]; then
  printf 'L=1\n' >"$tmp/locked.env"; chmod 000 "$tmp/locked.env"
  out="$(run STEWARD_ENV_FILE="$tmp/locked.env" 2>"$err")"; rc=$?
  check "an unreadable explicit STEWARD_ENV_FILE fails" "$rc" "1"
  chmod 600 "$tmp/locked.env"
fi

emptydir="$tmp/empty"; mkdir -p "$emptydir"
out="$(env -u STEWARD_ENV_FILE -u STEWARD_INSTANCE STEWARD_INSTANCES_DIR="$emptydir" bash "$script" 2>"$err")"; rc=$?
check "no instance found: fails" "$rc" "1"
check "no instance found: stdout is empty" "$out" ""
check "no instance found: the message says what to set" \
  "$(grep -cF "no instance found under $emptydir; set STEWARD_INSTANCE or STEWARD_ENV_FILE" "$err")" "1"

out="$(env -u STEWARD_ENV_FILE -u STEWARD_INSTANCE STEWARD_INSTANCES_DIR="$tmp/nowhere" bash "$script" 2>"$err")"; rc=$?
check "a missing instances root fails the same way" "$rc" "1"
check "a missing instances root: the message names the root" "$(grep -cF "$tmp/nowhere" "$err")" "1"

check "success prints one line only" "$(run STEWARD_INSTANCE=alpha 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "$n checks, $([[ $fail -eq 0 ]] && echo 0 || echo some) failures"
exit $fail
