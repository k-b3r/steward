#!/usr/bin/env bash
# Tests for deploy/render.sh. Renders into a temp dir and checks placeholders,
# bind addresses and the overwrite guard. Creates nothing outside the temp dir.
set -uo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
render="$script_dir/render.sh"
failures=0
checks=0

fail() {
  printf 'not ok %d - %s\n' "$checks" "$1" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'ok %d - %s\n' "$checks" "$1"
}

check() {
  checks=$((checks + 1))
  local description="$1"
  shift
  if "$@"; then
    pass "$description"
  else
    fail "$description"
  fi
}

tmp_root="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp_root"
}
trap cleanup EXIT

out="$tmp_root/personal"

# Happy path: personal, port base 15432.
checks=$((checks + 1))
if "$render" personal 15432 "$out" >"$tmp_root/render.log" 2>&1; then
  pass "renders personal:15432"
else
  fail "renders personal:15432"
  cat "$tmp_root/render.log" >&2
fi

expected_files=(
  "steward-personal.network"
  "steward-personal-postgres.volume"
  "steward-personal-redis-queue.volume"
  "steward-personal-postgres.container"
  "steward-personal-redis-queue.container"
  "steward-personal-redis-slots.container"
)
for name in "${expected_files[@]}"; do
  check "writes $name" test -f "$out/$name"
done

checks=$((checks + 1))
if find "$out" -type f -name '.*' | grep -q .; then
  fail "leaves no temp files behind"
else
  pass "leaves no temp files behind"
fi

checks=$((checks + 1))
if grep -R -n -E '@(INSTANCE|PG_PORT|PG_DB|REDIS_QUEUE_PORT|REDIS_SLOTS_PORT)@' "$out"; then
  fail "no template placeholders left"
else
  pass "no template placeholders left"
fi

checks=$((checks + 1))
if grep -R -n '@' "$out"; then
  fail "no @ left anywhere in the rendered files"
else
  pass "no @ left anywhere in the rendered files"
fi

check "postgres publishes on 127.0.0.1:15432" grep -q 'PublishPort=127.0.0.1:15432:5432' "$out/steward-personal-postgres.container"
check "queue redis publishes on 127.0.0.1:15433" grep -q 'PublishPort=127.0.0.1:15433:6379' "$out/steward-personal-redis-queue.container"
check "slots redis publishes on 127.0.0.1:15434" grep -q 'PublishPort=127.0.0.1:15434:6379' "$out/steward-personal-redis-slots.container"

checks=$((checks + 1))
published=$(grep -R -h '^PublishPort=' "$out" | wc -l)
not_local=$(grep -R -h '^PublishPort=' "$out" | grep -v -c '^PublishPort=127\.0\.0\.1:')
if [ "$published" -eq 3 ] && [ "$not_local" -eq 0 ]; then
  pass "all three published ports bind 127.0.0.1"
else
  fail "all three published ports bind 127.0.0.1 (found $published, off-local $not_local)"
fi

check "network name matches instanceNames()" grep -q '^NetworkName=steward-personal-net$' "$out/steward-personal.network"
check "database name matches instanceNames()" grep -q '^Environment=POSTGRES_DB=steward_personal$' "$out/steward-personal-postgres.container"
check "postgres password comes from a Podman secret" grep -q 'Secret=steward-personal-postgres-password,type=env,target=POSTGRES_PASSWORD' "$out/steward-personal-postgres.container"
check "redis password comes from a Podman secret" grep -q 'Secret=steward-personal-redis-password,type=env,target=REDIS_PASSWORD' "$out/steward-personal-redis-queue.container"
check "queue redis persists with appendonly" grep -q -- '--appendonly yes' "$out/steward-personal-redis-queue.container"
check "slots redis disables persistence" grep -q -- '--appendonly no --save' "$out/steward-personal-redis-slots.container"
check "containers restart always" grep -q '^Restart=always$' "$out/steward-personal-postgres.container"
check "containers want default.target" grep -q '^WantedBy=default.target$' "$out/steward-personal-postgres.container"

# A second render must not overwrite existing files.
checks=$((checks + 1))
if "$render" personal 15432 "$out" >"$tmp_root/refuse.log" 2>&1; then
  fail "refuses to overwrite without --force"
else
  pass "refuses to overwrite without --force"
fi

checks=$((checks + 1))
if grep -q 'refusing to overwrite' "$tmp_root/refuse.log"; then
  pass "overwrite refusal names the guard"
else
  fail "overwrite refusal names the guard"
fi

# --force replaces, and a different port base changes the rendered ports.
checks=$((checks + 1))
if "$render" personal 16000 "$out" --force >"$tmp_root/force.log" 2>&1; then
  pass "overwrites with --force"
else
  fail "overwrites with --force"
  cat "$tmp_root/force.log" >&2
fi
check "--force re-renders the new port base" grep -q 'PublishPort=127.0.0.1:16000:5432' "$out/steward-personal-postgres.container"

# Hyphens in an instance name become underscores in the database name.
hyphen_out="$tmp_root/work-demo"
checks=$((checks + 1))
if "$render" work-demo 20000 "$hyphen_out" >"$tmp_root/hyphen.log" 2>&1; then
  pass "renders an instance name with hyphens"
else
  fail "renders an instance name with hyphens"
  cat "$tmp_root/hyphen.log" >&2
fi
check "hyphen instance keeps the hyphen in the unit file name" test -f "$hyphen_out/steward-work-demo-postgres.container"
check "hyphen instance uses underscores in the database name" grep -q '^Environment=POSTGRES_DB=steward_work_demo$' "$hyphen_out/steward-work-demo-postgres.container"

# Invalid input is rejected and writes nothing.
long_instance="p$(printf 'a%.0s' {1..31})"
for bad_instance in 'Personal' '1personal' 'personal_' "$long_instance"; do
  checks=$((checks + 1))
  if "$render" "$bad_instance" 15432 "$tmp_root/rejected-$RANDOM" >/dev/null 2>&1; then
    fail "rejects instance '$bad_instance'"
  else
    pass "rejects instance '$bad_instance'"
  fi
done

for bad_port in 80 1023 65531 70000 15k 18446744073709552656; do
  checks=$((checks + 1))
  if "$render" personal "$bad_port" "$tmp_root/rejected-port-$RANDOM" >/dev/null 2>&1; then
    fail "rejects port base '$bad_port'"
  else
    pass "rejects port base '$bad_port'"
  fi
done

check "accepts the lowest port base" test -f "$("$render" personal 1024 "$tmp_root/low" >/dev/null 2>&1; echo "$tmp_root/low/steward-personal-postgres.container")"
check "accepts the highest port base" test -f "$("$render" personal 65530 "$tmp_root/high" >/dev/null 2>&1; echo "$tmp_root/high/steward-personal-redis-slots.container")"
check "highest port base publishes the slots redis below 65535" grep -q 'PublishPort=127.0.0.1:65532:6379' "$tmp_root/high/steward-personal-redis-slots.container"

touch "$tmp_root/a-file"
checks=$((checks + 1))
if "$render" personal 15432 "$tmp_root/a-file" >/dev/null 2>&1; then
  fail "rejects an output path that is a file"
else
  pass "rejects an output path that is a file"
fi

checks=$((checks + 1))
if "$render" personal 15432 >/dev/null 2>&1; then
  fail "rejects a missing argument"
else
  pass "rejects a missing argument"
fi

checks=$((checks + 1))
if "$render" personal 15432 "$tmp_root/missing-parent/out" >/dev/null 2>&1; then
  fail "rejects a missing parent directory"
else
  pass "rejects a missing parent directory"
fi

spaced="$tmp_root/dir with space"
checks=$((checks + 1))
if "$render" personal 15432 "$spaced" >/dev/null 2>&1 && [ -f "$spaced/steward-personal.network" ]; then
  pass "handles an output path with spaces"
else
  fail "handles an output path with spaces"
fi

printf '%d checks, %d failures\n' "$checks" "$failures"
[ "$failures" -eq 0 ]
