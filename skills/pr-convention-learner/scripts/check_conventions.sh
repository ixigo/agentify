#!/usr/bin/env bash
# check_conventions.sh — Pre-PR convention violation checker
#
# Usage: ./check_conventions.sh <conventions_file> [target_branch] [--files file1 file2 ...]
#
# If --files is not provided, uses `git diff` against target_branch (default: main).
# Outputs JSON array of violations for Claude to format and present.
#
# Note: This script gathers the diff data and convention rules.
# The actual violation detection (semantic matching of rules against code)
# is done by Claude using this data as context.

set -euo pipefail

CONVENTIONS_FILE="${1:?Usage: check_conventions.sh <conventions_file> [target_branch] [--files ...]}"
shift

TARGET_BRANCH="main"
FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --files)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do
        FILES+=("$1")
        shift
      done
      ;;
    *)
      TARGET_BRANCH="$1"
      shift
      ;;
  esac
done

# Validate conventions file exists
if [[ ! -f "$CONVENTIONS_FILE" ]]; then
  echo '{"error": "Conventions file not found", "path": "'"$CONVENTIONS_FILE"'"}' 
  exit 1
fi

# Get changed files
if [[ ${#FILES[@]} -gt 0 ]]; then
  changed_files=("${FILES[@]}")
else
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    echo '{"error": "Not inside a git repository and no --files specified"}' 
    exit 1
  fi

  mapfile -t changed_files < <(git diff --name-only "${TARGET_BRANCH}..." 2>/dev/null || git diff --name-only HEAD)
fi

if [[ ${#changed_files[@]} -eq 0 ]]; then
  echo '{"files": [], "conventions": "", "message": "No changed files found"}'
  exit 0
fi

# Build output JSON with diff content per file
file_diffs="["
first=true
for f in "${changed_files[@]}"; do
  [[ ! -f "$f" ]] && continue

  diff_content=""
  if git rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
    diff_content=$(git diff "${TARGET_BRANCH}..." -- "$f" 2>/dev/null || git diff HEAD -- "$f" 2>/dev/null || cat "$f")
  else
    diff_content=$(cat "$f")
  fi

  # Get file extension for convention filtering
  ext="${f##*.}"

  if [[ "$first" == "true" ]]; then
    first=false
  else
    file_diffs+=","
  fi

  file_diffs+=$(jq -n \
    --arg path "$f" \
    --arg ext "$ext" \
    --arg diff "$diff_content" \
    '{path: $path, extension: $ext, diff: $diff}')
done
file_diffs+="]"

# Read conventions
conventions_content=$(cat "$CONVENTIONS_FILE")

# Output everything Claude needs to do the semantic check
jq -n \
  --argjson files "$file_diffs" \
  --arg conventions "$conventions_content" \
  --arg target_branch "$TARGET_BRANCH" \
  '{
    target_branch: $target_branch,
    file_count: ($files | length),
    files: $files,
    conventions: $conventions,
    instructions: "Analyze each file diff against the conventions. For each violation, report: file, line, convention violated, severity (must-fix for high confidence, consider for low), and a suggested fix."
  }'
