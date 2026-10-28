#!/usr/bin/env bash
# Render the Quadlet templates in deploy/quadlet for one steward instance.
#
# Usage: deploy/render.sh <instance> <port-base> <output-dir> [--force]
#
# Ports: Postgres <port-base>, Redis queue <port-base>+1, Redis slots <port-base>+2.
# Every port is published on 127.0.0.1 only. The output dir is the only place
# this script writes; copy its files to ~/.config/containers/systemd/ yourself.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/render.sh <instance> <port-base> <output-dir> [--force]

  instance    lowercase, matches /^[a-z][a-z0-9-]{0,30}$/ (e.g. personal)
  port-base   integer 1024..65530; Postgres uses it, the two Redis units use +1 and +2
  output-dir  directory to write the rendered files into (created if missing;
              its parent directory must already exist)
  --force     overwrite files that already exist in output-dir

Examples:
  deploy/render.sh personal 15432 ./deploy/rendered/personal
  deploy/render.sh personal 15432 ./deploy/rendered/personal --force
EOF
}

die() {
  printf 'render.sh: %s\n' "$1" >&2
  exit 1
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
template_dir="$script_dir/quadlet"

force=0
positional=()
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      usage >&2
      die "unknown option: $arg"
      ;;
    *) positional+=("$arg") ;;
  esac
done

if [ "${#positional[@]}" -ne 3 ]; then
  usage >&2
  die "expected 3 arguments, got ${#positional[@]}"
fi

instance="${positional[0]}"
port_base_raw="${positional[1]}"
output_dir="${positional[2]}"

# Same rule as the config schema in src/platform/config.ts.
if [[ ! $instance =~ ^[a-z][a-z0-9-]{0,30}$ ]]; then
  die "instance must match /^[a-z][a-z0-9-]{0,30}$/, got: $instance"
fi

if [[ ! $port_base_raw =~ ^[0-9]{1,5}$ ]]; then
  die "port-base must be an integer, got: $port_base_raw"
fi

port_base=$((10#$port_base_raw))
if ((port_base < 1024 || port_base > 65530)); then
  die "port-base must be in 1024..65530, got: $port_base"
fi

pg_port=$port_base
redis_queue_port=$((port_base + 1))
redis_slots_port=$((port_base + 2))
# Must match instanceNames().dbName in src/platform/config.ts: hyphens become underscores.
pg_db="steward_${instance//-/_}"

if ! compgen -G "$template_dir/*.container" >/dev/null; then
  die "no templates found in $template_dir"
fi

if [ -e "$output_dir" ] && [ ! -d "$output_dir" ]; then
  die "output path exists and is not a directory: $output_dir"
fi

if [ ! -d "$output_dir" ]; then
  parent_dir="$(dirname -- "$output_dir")"
  if [ ! -d "$parent_dir" ]; then
    die "output dir parent does not exist: $parent_dir"
  fi
  mkdir -- "$output_dir" || die "cannot create output dir: $output_dir"
fi

output_abs="$(cd -- "$output_dir" && pwd -P)"

shopt -s nullglob
templates=("$template_dir"/*.container "$template_dir"/*.network "$template_dir"/*.volume)
rendered_names=()
destinations=()

for template in "${templates[@]}"; do
  name="$(basename -- "$template")"
  name="${name//@INSTANCE@/$instance}"
  case "$name" in
    */*) die "refusing to write outside the output dir: $name" ;;
  esac
  destination="$output_abs/$name"
  if [ -e "$destination" ] && [ "$force" -ne 1 ]; then
    die "refusing to overwrite $destination (pass --force to replace it)"
  fi
  rendered_names+=("$name")
  destinations+=("$destination")
done

umask 022
tmp_files=()
cleanup() {
  if [ "${#tmp_files[@]}" -gt 0 ]; then
    rm -f -- "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

for index in "${!templates[@]}"; do
  template="${templates[$index]}"
  destination="${destinations[$index]}"
  tmp="$output_abs/.render.$$.$index.tmp"
  tmp_files+=("$tmp")
  sed \
    -e "s|@INSTANCE@|$instance|g" \
    -e "s|@PG_PORT@|$pg_port|g" \
    -e "s|@REDIS_QUEUE_PORT@|$redis_queue_port|g" \
    -e "s|@REDIS_SLOTS_PORT@|$redis_slots_port|g" \
    -e "s|@PG_DB@|$pg_db|g" \
    -- "$template" >"$tmp"
  mv -f -- "$tmp" "$destination"
done

trap - EXIT

printf 'Rendered %d files for instance %s into %s\n' "${#rendered_names[@]}" "$instance" "$output_abs"
printf '  Postgres     127.0.0.1:%s\n' "$pg_port"
printf '  Redis queue  127.0.0.1:%s\n' "$redis_queue_port"
printf '  Redis slots  127.0.0.1:%s\n' "$redis_slots_port"
printf '  Database     %s\n' "$pg_db"
printf '  Secret names steward-%s-postgres-password, steward-%s-redis-password\n' "$instance" "$instance"
printf 'Next: copy the files to ~/.config/containers/systemd/ and follow README.md.\n'
