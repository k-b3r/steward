# Makes a value safe to put inside a JSON string: backslash and double quote are escaped.
# Control characters are not expected in an account name or repository path; a newline is
# turned into \n so the document stays valid anyway.
# usage: source scripts/lib/json.sh; printf '{"repo":"%s"}' "$(json_escape "$repo")"
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}
