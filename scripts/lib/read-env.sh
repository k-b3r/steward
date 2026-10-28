# Reads KEY=VALUE pairs from an env file without running it as shell code.
# A line such as KEY=$(rm -rf ~) is read as the literal text, never executed.
# usage: source scripts/lib/read-env.sh; read_env_value FILE KEY
read_env_value() {
  local file="$1" key="$2" line value found=1
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*${key}=(.*)$ ]]; then
      value="${BASH_REMATCH[1]}"
      # Strip one pair of matching surrounding quotes, as a dotenv file allows.
      if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
      found=0
      result="$value"
    fi
  done <"$file"
  [[ $found -eq 0 ]] && printf '%s' "$result"
  return $found
}
