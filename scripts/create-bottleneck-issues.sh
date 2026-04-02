#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRAFT_DIR="$ROOT_DIR/.github/issue-drafts"

create_issue() {
  local title="$1"
  local body_file="$2"
  if gh label list --limit 200 | awk '{print $1}' | grep -qx "feature"; then
    gh issue create --title "$title" --body-file "$body_file" --label "feature"
  else
    gh issue create --title "$title" --body-file "$body_file"
  fi
}

create_issue "[feature] Add multi-language semantic adapters (Python/Go/Java/.NET)" "$DRAFT_DIR/01-multi-language-semantic-adapters.md"
create_issue "[feature] Add explainable planning mode (agentify plan --explain)" "$DRAFT_DIR/02-explainable-planning-mode.md"
create_issue "[feature] Add semantic health diagnostics (agentify doctor --semantic)" "$DRAFT_DIR/03-semantic-health-diagnostics.md"
create_issue "[feature] Expand LSP-bridge query commands (def/refs/callers/impacts)" "$DRAFT_DIR/04-lsp-bridge-query-commands.md"
create_issue "[feature] Add agentify handoff bundle for cross-agent collaboration" "$DRAFT_DIR/05-agent-handoff-bundle.md"
create_issue "[feature] Add PR risk/regression prediction from dependency + semantic graph" "$DRAFT_DIR/06-pr-risk-regression-prediction.md"

echo "Created 6 bottleneck issues."
