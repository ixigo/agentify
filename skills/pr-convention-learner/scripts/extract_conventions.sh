#!/usr/bin/env bash
# extract_conventions.sh — Merge PR review insights into per-repo conventions file
#
# Usage: ./extract_conventions.sh <resolved_comments.json> <conventions_dir>
#
# resolved_comments.json: Output from the resolve step (array of {category, rule, why, bad, good, source_pr})
# conventions_dir: Directory where conventions.md lives (created if missing)
#
# This script handles the file I/O. The actual analysis (categorizing comments into
# conventions) should be done by Claude before calling this script.

set -euo pipefail

COMMENTS_FILE="${1:?Usage: extract_conventions.sh <resolved_comments.json> <conventions_dir>}"
CONVENTIONS_DIR="${2:?Usage: extract_conventions.sh <resolved_comments.json> <conventions_dir>}"
CONVENTIONS_FILE="${CONVENTIONS_DIR}/conventions.md"
TODAY=$(date +%Y-%m-%d)

mkdir -p "$CONVENTIONS_DIR"

# Initialize if missing
if [[ ! -f "$CONVENTIONS_FILE" ]]; then
  cat > "$CONVENTIONS_FILE" <<'EOF'
# Code Conventions

_Auto-generated from PR review feedback. Do not delete entries manually — they accumulate confidence over time._

---

EOF
  echo "Created new conventions file: $CONVENTIONS_FILE" >&2
fi

# Read new conventions from JSON and append/merge
# Expected JSON format:
# [
#   {
#     "category": "naming",
#     "title": "Use camelCase for ViewModel state fields",
#     "rule": "ViewModel state properties should use camelCase, not snake_case",
#     "why": "Consistent with Kotlin/Compose conventions and team style guide",
#     "bad": "val user_name: String",
#     "good": "val userName: String",
#     "confidence": "medium",
#     "source_pr": "PR-1234"
#   }
# ]

new_count=$(jq 'length' "$COMMENTS_FILE")

if [[ "$new_count" -eq 0 ]]; then
  echo "No new conventions to add." >&2
  exit 0
fi

added=0
updated=0

while IFS= read -r convention; do
  title=$(echo "$convention" | jq -r '.title')
  category=$(echo "$convention" | jq -r '.category')
  rule=$(echo "$convention" | jq -r '.rule')
  why=$(echo "$convention" | jq -r '.why')
  bad=$(echo "$convention" | jq -r '.bad // ""')
  good=$(echo "$convention" | jq -r '.good // ""')
  confidence=$(echo "$convention" | jq -r '.confidence // "low"')
  source_pr=$(echo "$convention" | jq -r '.source_pr // "unknown"')

  # Check if this convention title already exists (fuzzy match on title)
  if grep -Fqi "### $title" "$CONVENTIONS_FILE" 2>/dev/null; then
    # Update: bump confidence and add source PR
    # Append source PR if not already listed
    if ! grep -F -A8 "### $title" "$CONVENTIONS_FILE" | grep -Fq "$source_pr"; then
      TITLE="$title" SOURCE_PR="$source_pr" TODAY="$TODAY" perl -0pi -e '
        my $title = quotemeta($ENV{"TITLE"});
        my $source = $ENV{"SOURCE_PR"};
        my $today = $ENV{"TODAY"};
        s/(### $title\n(?:(?!\n### ).)*?- \*\*Source PRs\*\*: [^\n]*)/$1, $source/s;
        s/(### $title\n(?:(?!\n### ).)*?- \*\*Last seen\*\*: )[^\n]*/$1$today/s;
      ' "$CONVENTIONS_FILE"
      echo "  Updated: $title (added $source_pr)" >&2
      updated=$((updated + 1))
    fi
  else
    # Append new convention under its category
    # Check if category section exists
    if ! grep -qi "## $category" "$CONVENTIONS_FILE"; then
      category_label=$(printf '%s' "$category" | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
      echo "" >> "$CONVENTIONS_FILE"
      echo "## ${category_label}" >> "$CONVENTIONS_FILE"
      echo "" >> "$CONVENTIONS_FILE"
    fi

    # Append the convention entry
    cat >> "$CONVENTIONS_FILE" <<ENTRY

### ${title}
- **Rule**: ${rule}
- **Why**: ${why}
- **Example (bad)**: \`${bad}\`
- **Example (good)**: \`${good}\`
- **Confidence**: ${confidence}
- **Source PRs**: ${source_pr}
- **Last seen**: ${TODAY}

ENTRY
    echo "  Added: $title [$category]" >&2
    added=$((added + 1))
  fi
done < <(jq -c '.[]' "$COMMENTS_FILE")

echo "Done. Added: $added, Updated: $updated" >&2
echo "Conventions file: $CONVENTIONS_FILE"
