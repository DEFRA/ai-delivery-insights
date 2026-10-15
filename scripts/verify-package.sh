#!/usr/bin/env bash
# Verifies what would ship in the .vsix. Used by CI and the release workflow.
# Usage: scripts/verify-package.sh [path/to/file.vsix]
# Fails if anything outside the allow-list is packaged, if network APIs appear anywhere but lib/ado.js,
# if child_process appears anywhere but lib/gitlog.js, if code is evaluated dynamically,
# or if the package is larger than MAX_VSIX_KB (default 500).
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW='^(package\.json|README\.md|CHANGELOG\.md|LICENSE(\.txt|\.md)?|extension\.js|lib/.+|media/.+|dist/.+)$'
MAX_VSIX_KB="${MAX_VSIX_KB:-500}"

files="$(npx --no-install vsce ls --no-dependencies | sed 's#\\#/#g')"
bad="$(printf '%s\n' "$files" | grep -Ev "$ALLOW" || true)"
if [ -n "$bad" ]; then
  echo "::error::Files outside the packaging allow-list would ship:"
  printf '%s\n' "$bad"
  exit 1
fi
echo "Package contents OK ($(printf '%s\n' "$files" | wc -l | tr -d ' ') files)."

# Network, process and code-execution rules (docs/ai-delivery-insights/adr/0012-azure-devops-integration-opt-in.md):
#   - Only lib/ado.js may use the network (global fetch, to https://dev.azure.com only).
#   - Only lib/gitlog.js may start a process (git, read-only, no shell).
#   - Nothing may evaluate code.
# These checks are a tripwire for honest mistakes, not a security boundary: a determined author can build a call from pieces
# (for example require('child' + '_process')). The real protection is the review of those two files and the tests that count
# requests and processes (test/smoke-ado.js, test/test-gitlog.js).

# scan PATTERN ALLOWED_FILE TARGET...   prints offending lines and returns 1 if there are any outside ALLOWED_FILE.
# grep exits 0 for a match, 1 for none and 2 or more for an error (an unreadable file or a dangling link): an error must fail the
# check, never pass it, so the status is read instead of being treated as "nothing found".
scan() {
  local pattern="$1" allow="$2"; shift 2
  local out="" st=0
  out="$(grep -RnE "$pattern" "$@" --include='*.js' --include='*.ts' --exclude-dir=node_modules 2>&1)" || st=$?
  if [ "$st" -ge 2 ]; then
    echo "::error::A check could not read every shipped file, so it cannot vouch for them:"
    printf '%s\n' "$out"
    exit 1
  fi
  if [ -n "$allow" ]; then out="$(printf '%s\n' "$out" | grep -v "^$allow:" || true)"; fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; return 1; fi
  return 0
}

targets=""
for t in extension.js lib dist src media; do [ -e "$t" ] && targets="$targets $t"; done
if [ -n "$targets" ]; then
  NET="(\bfetch\(|XMLHttpRequest|WebSocket\(|EventSource\(|sendBeacon|require\(['\"](https?|net|tls|dgram|http2)['\"]\)|from ['\"](https?|net|tls|dgram|http2)['\"]|node:(https?|net|tls|dgram|http2))"
  # 1. Network APIs: nowhere except lib/ado.js (excluded by its full path, so a file of the same name elsewhere is still checked).
  # shellcheck disable=SC2086
  scan "$NET" "lib/ado.js" $targets || { echo "::error::Network API usage found outside lib/ado.js. Only lib/ado.js may use the network."; exit 1; }
  # 2. Inside lib/ado.js: global fetch only, never a lower-level network module.
  if [ -f lib/ado.js ]; then
    scan "require\(['\"](https?|net|tls|dgram|http2)['\"]\)|node:(https?|net|tls|dgram|http2)|XMLHttpRequest|WebSocket\(|EventSource\(|sendBeacon" "" lib/ado.js || { echo "::error::lib/ado.js must use the global fetch only."; exit 1; }
  fi
  # 3. Inside lib/ado.js: the only host in code is dev.azure.com (comment lines are ignored).
  if [ -f lib/ado.js ]; then
    hosts="$(grep -vE '^[[:space:]]*(\*|//|/\*)' lib/ado.js | grep -oE "https?://[A-Za-z0-9._-]+" | sort -u | grep -vxE 'https://dev\.azure\.com' || true)"
    if [ -n "$hosts" ]; then
      echo "::error::lib/ado.js names a host other than dev.azure.com:"
      printf '%s\n' "$hosts"
      exit 1
    fi
  fi
  echo "Network APIs only in lib/ado.js, and only for dev.azure.com."
  # 4. Processes: child_process only in lib/gitlog.js, and never through a shell.
  # shellcheck disable=SC2086
  scan "child_process|execSync|spawnSync|\bfork\(" "lib/gitlog.js" $targets || { echo "::error::Process APIs found outside lib/gitlog.js."; exit 1; }
  # shellcheck disable=SC2086
  scan "shell[[:space:]]*:[[:space:]]*(true|process)" "" $targets || { echo "::error::A process is started through a shell."; exit 1; }
  echo "child_process only in lib/gitlog.js, never through a shell."
  # 5. No dynamic code.
  # shellcheck disable=SC2086
  scan "(^|[^.[:alnum:]_])eval\(|new Function\(|importScripts\(" "" $targets || { echo "::error::Dynamic code evaluation found in shipped code."; exit 1; }
  echo "No dynamic code evaluation."
fi

if [ "${1:-}" != "" ]; then
  size_kb=$(( ($(wc -c < "$1") + 1023) / 1024 ))
  if [ "$size_kb" -gt "$MAX_VSIX_KB" ]; then
    echo "::error::$1 is ${size_kb} KB, over the ${MAX_VSIX_KB} KB budget."
    exit 1
  fi
  echo "Package size OK (${size_kb} KB, budget ${MAX_VSIX_KB} KB)."
fi
