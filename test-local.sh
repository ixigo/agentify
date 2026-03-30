#!/usr/bin/env bash
#
# End-to-end local test of agentify as an npm-linked CLI.
# Tests every command against a throwaway git repo, including
# the codex provider exec wrapper.
#
# Usage:
#   chmod +x test-local.sh
#   ./test-local.sh
#
# Prerequisites:
#   - Node.js >= 20
#   - codex CLI installed and authenticated (for provider/exec tests)
#   - git
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() { ((PASS++)); printf "${GREEN}  PASS${RESET} %s\n" "$1"; }
fail() { ((FAIL++)); printf "${RED}  FAIL${RESET} %s\n" "$1"; }
skip() { ((SKIP++)); printf "${DIM}  SKIP${RESET} %s\n" "$1"; }
section() { printf "\n${CYAN}--- %s ---${RESET}\n" "$1"; }

HAS_CODEX=false
if command -v codex &>/dev/null; then HAS_CODEX=true; fi

# ── Link agentify globally ──────────────────────────────────────────

section "Setup: link globally"
AGENTIFY_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$AGENTIFY_ROOT"
pnpm link --global 2>&1 | tail -1 || npm link --force 2>&1 | tail -1
if command -v agentify &>/dev/null; then
  pass "agentify is on PATH after npm link"
else
  fail "agentify not found on PATH"
  echo "Cannot continue without agentify on PATH."
  exit 1
fi

# ── Create a throwaway test repo ─────────────────────────────────────

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"; cd "$AGENTIFY_ROOT" && pnpm uninstall -g agentify 2>/dev/null || npm unlink -g agentify 2>/dev/null || true' EXIT

cd "$WORKDIR"
git init -q
git config user.name "Test"
git config user.email "test@test.com"

mkdir -p src/auth src/api test
cat > package.json <<'PKG'
{
  "name": "test-repo",
  "version": "1.0.0",
  "scripts": { "test": "node --test" }
}
PKG
cat > src/auth/index.ts <<'TS'
export function login(user: string, password: string): boolean {
  return user === "admin" && password === "secret";
}
TS
cat > src/api/server.ts <<'TS'
import { login } from "../auth/index.js";
export function handleRequest(req: any) {
  return login(req.user, req.pass);
}
TS
cat > test/sample.test.js <<'JS'
import test from "node:test";
import assert from "node:assert/strict";
test("always passes", () => { assert.equal(1, 1); });
JS

git add -A && git commit -q -m "initial"
echo ""
printf "${DIM}  Test repo: %s${RESET}\n" "$WORKDIR"

# ── 1. Help ──────────────────────────────────────────────────────────

section "1. Help & Version"

OUTPUT=$(agentify --help 2>&1)
if echo "$OUTPUT" | grep -q "COMMANDS"; then
  pass "agentify --help shows styled commands"
else
  fail "agentify --help missing COMMANDS section"
fi

if echo "$OUTPUT" | grep -q "v0.2.0"; then
  pass "banner shows version v0.2.0"
else
  fail "banner missing version"
fi

# ── 2. Doctor ────────────────────────────────────────────────────────

section "2. Doctor"

OUTPUT=$(agentify doctor --root "$WORKDIR" 2>&1)
if echo "$OUTPUT" | grep -q "Capability tier"; then
  pass "doctor shows capability tier"
else
  fail "doctor missing tier output"
fi
if echo "$OUTPUT" | grep -q "Node.js"; then
  pass "doctor shows Node.js version"
else
  fail "doctor missing Node.js info"
fi
if echo "$OUTPUT" | grep -q "Tool"; then
  pass "doctor shows tool table"
else
  fail "doctor missing tool table"
fi

# ── 3. Init ──────────────────────────────────────────────────────────

section "3. Init"

agentify init --root "$WORKDIR" 2>&1
if [ -f "$WORKDIR/AGENTS.md" ]; then
  pass "init created AGENTS.md"
else
  fail "init missing AGENTS.md"
fi
if [ -d "$WORKDIR/.agents" ]; then
  pass "init created .agents/ directory"
else
  fail "init missing .agents/"
fi

# ── 4. Scan ──────────────────────────────────────────────────────────

section "4. Scan"

OUTPUT=$(agentify scan --root "$WORKDIR" --provider local 2>&1)
if [ -f "$WORKDIR/.agents/index.json" ]; then
  pass "scan created .agents/index.json"
else
  fail "scan missing index.json"
fi
if [ -f "$WORKDIR/.agents/graphs/deps.json" ]; then
  pass "scan created deps.json"
else
  fail "scan missing deps.json"
fi
if [ -f "$WORKDIR/docs/repo-map.md" ]; then
  pass "scan created docs/repo-map.md"
else
  fail "scan missing repo-map.md"
fi

# ── 5. Doc ───────────────────────────────────────────────────────────

section "5. Doc"

OUTPUT=$(agentify doc --root "$WORKDIR" --provider local 2>&1)
if [ -f "$WORKDIR/AGENTIFY.md" ]; then
  pass "doc created AGENTIFY.md"
else
  fail "doc missing AGENTIFY.md"
fi
if ls "$WORKDIR"/docs/modules/*.md &>/dev/null; then
  pass "doc created module docs"
else
  fail "doc missing module docs"
fi
if ls "$WORKDIR"/.agents/runs/*.json &>/dev/null; then
  pass "doc created run report"
else
  fail "doc missing run report"
fi

# ── 6. Validate ──────────────────────────────────────────────────────

section "6. Validate"

OUTPUT=$(agentify validate --root "$WORKDIR" 2>&1) || true
if echo "$OUTPUT" | grep -qi "validat"; then
  pass "validate produces output"
else
  fail "validate produced no output"
fi

# ── 7. Update (full pipeline) ────────────────────────────────────────

section "7. Update (scan + doc + validate + test)"

git -C "$WORKDIR" add -A && git -C "$WORKDIR" commit -q -m "add agentify artifacts" || true
OUTPUT=$(agentify update --root "$WORKDIR" --provider local 2>&1) || true
if echo "$OUTPUT" | grep -q "Run Complete"; then
  pass "update shows Run Complete summary box"
else
  fail "update missing summary box"
fi
if [ -f "$WORKDIR/agentify-report.html" ]; then
  pass "update created agentify-report.html"
else
  fail "update missing HTML report"
fi
if [ -f "$WORKDIR/output.txt" ]; then
  pass "update created output.txt"
else
  fail "update missing output.txt"
fi

# ── 8. Ghost Mode ────────────────────────────────────────────────────

section "8. Ghost Mode"

git -C "$WORKDIR" add -A && git -C "$WORKDIR" commit -q -m "pre-ghost" || true
agentify scan --root "$WORKDIR" --ghost --provider local 2>&1 >/dev/null || true
agentify doc --root "$WORKDIR" --ghost --provider local 2>&1 >/dev/null || true
if [ -d "$WORKDIR/.current_session" ]; then
  pass "ghost mode created .current_session/"
else
  fail "ghost mode missing .current_session/"
fi

# ── 9. JSON Mode ─────────────────────────────────────────────────────

section "9. JSON Mode"

JSON_OUT=$(agentify scan --root "$WORKDIR" --provider local --json 2>/dev/null)
if echo "$JSON_OUT" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{JSON.parse(d);process.exit(0)})" 2>/dev/null; then
  pass "--json outputs valid JSON on stdout"
else
  fail "--json did not produce valid JSON"
fi

# ── 10. Query ─────────────────────────────────────────────────────────

section "10. Query"

OWNER=$(agentify query owner --file src/auth/index.ts --root "$WORKDIR" 2>/dev/null)
if echo "$OWNER" | grep -q "module_id"; then
  pass "query owner returns module info"
else
  fail "query owner failed"
fi

FIRST_MOD=$(node -e "const d=JSON.parse(require('fs').readFileSync('$WORKDIR/.agents/index.json','utf8')); console.log(d.modules[0]?.id || '')")
if [ -n "$FIRST_MOD" ]; then
  DEPS=$(agentify query deps --module "$FIRST_MOD" --root "$WORKDIR" 2>/dev/null)
  if echo "$DEPS" | grep -q "module_id"; then
    pass "query deps returns dependency info"
  else
    fail "query deps failed"
  fi
else
  skip "query deps -- no module found"
fi

HEAD=$(git -C "$WORKDIR" rev-parse HEAD~1 2>/dev/null || echo "")
if [ -n "$HEAD" ]; then
  CHANGED=$(agentify query changed --since "$HEAD" --root "$WORKDIR" 2>/dev/null)
  if echo "$CHANGED" | grep -q "affected_modules"; then
    pass "query changed returns affected modules"
  else
    fail "query changed failed"
  fi
else
  skip "query changed -- not enough commits"
fi

# ── 11. Sessions ──────────────────────────────────────────────────────

section "11. Sessions"

FORK_OUT=$(agentify session fork --tool codex --name "test-session" --root "$WORKDIR" 2>&1)
if echo "$FORK_OUT" | grep -qi "sess_\|fork"; then
  pass "session fork created a session"
else
  fail "session fork failed"
fi

LIST_OUT=$(agentify session list --root "$WORKDIR" 2>&1)
# strip ANSI codes for matching
LIST_PLAIN=$(echo "$LIST_OUT" | sed 's/\x1b\[[0-9;]*m//g')
if echo "$LIST_PLAIN" | grep -qi "sess_\|test-session\|No sessions"; then
  pass "session list shows sessions"
else
  fail "session list failed"
fi

SESS_ID=$(node -e "
const fs = require('fs'), path = require('path');
const dir = path.join('$WORKDIR', '.agents', 'session');
try {
  const entries = fs.readdirSync(dir).filter(e => e.startsWith('sess_'));
  console.log(entries[0] || '');
} catch { console.log(''); }
")
if [ -n "$SESS_ID" ]; then
  RESUME=$(agentify session resume --session "$SESS_ID" --root "$WORKDIR" 2>&1)
  if echo "$RESUME" | grep -qi "session\|HEAD\|checklist"; then
    pass "session resume returns bootstrap context"
  else
    fail "session resume failed"
  fi
else
  skip "session resume -- no session ID found"
fi

# ── 12. Hooks ─────────────────────────────────────────────────────────

section "12. Git Hooks"

HOOKS_OUT=$(agentify hooks install --root "$WORKDIR" 2>&1)
if echo "$HOOKS_OUT" | grep -qi "install\|hook"; then
  pass "hooks install succeeded"
else
  fail "hooks install failed"
fi

STATUS_OUT=$(agentify hooks status --root "$WORKDIR" 2>&1)
if echo "$STATUS_OUT" | grep -qi "pre\|post\|commit\|merge"; then
  pass "hooks status shows hook info"
else
  fail "hooks status failed"
fi

REMOVE_OUT=$(agentify hooks remove --root "$WORKDIR" 2>&1)
if echo "$REMOVE_OUT" | grep -qi "remove\|hook\|No"; then
  pass "hooks remove succeeded"
else
  fail "hooks remove failed"
fi

# ── 13. Cache ─────────────────────────────────────────────────────────

section "13. Cache"

CACHE_OUT=$(agentify cache status --root "$WORKDIR" 2>&1)
if echo "$CACHE_OUT" | grep -qi "blob\|entries\|0"; then
  pass "cache status shows info"
else
  fail "cache status failed"
fi

GC_OUT=$(agentify cache gc --root "$WORKDIR" 2>&1)
if echo "$GC_OUT" | grep -qi "garbage\|collect\|0"; then
  pass "cache gc completed"
else
  fail "cache gc failed"
fi

# ── 14. Dry Run ───────────────────────────────────────────────────────

section "14. Dry Run"

rm -rf "$WORKDIR/.agents-dry" 2>/dev/null || true
DRYDIR="$(mktemp -d)"
cp -r "$WORKDIR"/.agents "$DRYDIR/" 2>/dev/null || true
BEFORE=$(find "$WORKDIR/.agents" -type f 2>/dev/null | wc -l | tr -d ' ')
DRY_OUT=$(agentify scan --root "$WORKDIR" --provider local --dry-run 2>&1)
AFTER=$(find "$WORKDIR/.agents" -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$BEFORE" = "$AFTER" ]; then
  pass "--dry-run did not change artifact count"
else
  fail "--dry-run modified artifacts ($BEFORE -> $AFTER)"
fi
rm -rf "$DRYDIR"

# ── 15. Exec Wrapper ─────────────────────────────────────────────────

section "15. Exec Wrapper"

git -C "$WORKDIR" add -A && git -C "$WORKDIR" commit -q -m "pre-exec" || true
EXEC_OUT=$(agentify exec --skip-refresh --root "$WORKDIR" -- echo "hello from exec" 2>&1) || true
if echo "$EXEC_OUT" | grep -q "hello from exec"; then
  pass "exec wrapper ran the child command"
else
  fail "exec wrapper did not run child command"
fi

EXEC_OUT2=$(agentify exec --root "$WORKDIR" -- echo "with refresh" 2>&1) || true
if echo "$EXEC_OUT2" | grep -q "with refresh"; then
  pass "exec wrapper with auto-refresh ran"
else
  fail "exec wrapper with refresh failed"
fi

# ── 16. Exec with Codex ──────────────────────────────────────────────

section "16. Exec with Codex Provider"

if $HAS_CODEX; then
  git -C "$WORKDIR" add -A && git -C "$WORKDIR" commit -q -m "pre-codex" || true
  CODEX_OUT=$(agentify doc --root "$WORKDIR" --provider codex 2>&1) || true
  if echo "$CODEX_OUT" | grep -qi "doc:\|module\|completed"; then
    pass "doc --provider codex produced output"
  else
    fail "doc --provider codex failed"
  fi
else
  skip "codex CLI not installed"
fi

# ── Summary ───────────────────────────────────────────────────────────

section "Results"
printf "\n"
printf "  ${GREEN}Passed:  %d${RESET}\n" "$PASS"
printf "  ${RED}Failed:  %d${RESET}\n" "$FAIL"
printf "  ${DIM}Skipped: %d${RESET}\n" "$SKIP"
TOTAL=$((PASS + FAIL))
printf "  Total:   %d\n\n" "$TOTAL"

if [ "$FAIL" -gt 0 ]; then
  printf "${RED}  Some tests failed.${RESET}\n\n"
  exit 1
else
  printf "${GREEN}  All tests passed!${RESET}\n\n"
  exit 0
fi
