#!/usr/bin/env bash
#
# End-to-end local smoke test of agentify as a CLI against a throwaway repo.
#
# Usage:
#   ./test-local.sh
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
RESET='\033[0m'
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); printf "${GREEN}  PASS${RESET} %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); printf "${RED}  FAIL${RESET} %s\n" "$1"; }

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
AG="node ${REPO_ROOT}/src/cli.js"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

cd "$WORKDIR"
git init -q
mkdir -p src
cat > src/a.js <<'JS'
import { helper } from "./b.js";
export function main() { return helper(); }
JS
cat > src/b.js <<'JS'
export function helper() { return 42; }
JS
git add -A && git commit -qm init

check "install"        $AG install --json
test -f CLAUDE.md && pass "CLAUDE.md written" || fail "CLAUDE.md written"
test -f .claude/settings.json && pass "hooks written" || fail "hooks written"

echo '{"session_id":"smoke","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"src/a.js"}}' \
  | $AG ctx track --hook && pass "ctx track --hook" || fail "ctx track --hook"
check "ctx note"       $AG ctx note "smoke note" --json
check "ctx load"       $AG ctx load --json
check "ctx status"     $AG ctx status --json
check "ctx handoff"    $AG ctx handoff "smoke task" --json
check "scan"           $AG scan --json
check "check"          $AG check --json
check "up"             $AG up --json
check "query search"   $AG query search --term helper --json
check "query def"      $AG query def --symbol helper --json
check "query impacts"  $AG query impacts --file src/b.js --json
check "risk"           $AG risk --json
check "status"         $AG status --json
check "skill list"     $AG skill list --json
check "doctor"         $AG doctor --json
check "clean dry-run"  $AG clean --dry-run --json
check "install codex"  $AG install --provider codex --json
test -f AGENTS.md && pass "AGENTS.md written" || fail "AGENTS.md written"
check "uninstall"      $AG uninstall --json
test ! -s AGENTS.md || ! grep -q "agentify:begin" AGENTS.md && pass "AGENTS.md cleaned" || fail "AGENTS.md cleaned"

echo
echo "PASS=$PASS FAIL=$FAIL"
test "$FAIL" -eq 0
