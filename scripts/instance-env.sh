#!/usr/bin/env bash
# Prints the env file of the instance the dev scripts run as, and nothing else.
# Order: $STEWARD_ENV_FILE, then $STEWARD_INSTANCES_DIR/$STEWARD_INSTANCE/.env, then the only
# instance folder under the instances dir that holds a .env. Errors go to stderr only; stdout
# carries only the path, so callers can write --env-file="$(scripts/instance-env.sh)".
set -euo pipefail

env_file="${STEWARD_ENV_FILE:-}"
if [[ -z "$env_file" ]]; then
  root="${STEWARD_INSTANCES_DIR:-${HOME:?HOME is not set}/steward-instances}"
  instance="${STEWARD_INSTANCE:-}"
  if [[ -n "$instance" ]]; then
    # Same rule as scripts/setup-repo.sh, so the name cannot walk out of the instances root.
    if ! [[ "$instance" =~ ^[a-z][a-z0-9-]{0,30}$ ]]; then
      echo "STEWARD_INSTANCE must match ^[a-z][a-z0-9-]{0,30}$ (got '$instance')" >&2
      exit 1
    fi
    env_file="$root/$instance/.env"
  else
    found=()
    for dir in "$root"/*/; do
      [[ -d "$dir" && -f "$dir/.env" ]] || continue
      found+=("${dir%/}")
    done
    if [[ ${#found[@]} -eq 0 ]]; then
      echo "no instance found under $root; set STEWARD_INSTANCE or STEWARD_ENV_FILE" >&2
      exit 1
    fi
    if [[ ${#found[@]} -gt 1 ]]; then
      names=()
      for dir in "${found[@]}"; do names+=("$(basename "$dir")"); done
      echo "several instances found under $root: ${names[*]}; set STEWARD_INSTANCE to pick one" >&2
      exit 1
    fi
    env_file="${found[0]}/.env"
  fi
fi

if [[ ! -f "$env_file" || ! -r "$env_file" ]]; then
  echo "cannot read the instance env file $env_file; set STEWARD_INSTANCE or STEWARD_ENV_FILE" >&2
  exit 1
fi

printf '%s\n' "$env_file"
