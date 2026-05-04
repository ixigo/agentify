#!/usr/bin/env bash
# fetch_pr.sh — Fetch PR metadata + actionable review threads from Azure DevOps
#
# Usage: ./fetch_pr.sh <pr_url_or_id> [--org ORG] [--project PROJECT] [--repo REPO]
#
# Outputs JSON to stdout with structure:
# {
#   "pr": { metadata },
#   "threads": [ actionable threads with comments ],
#   "stats": { "total_threads": N, "actionable": N, "system": N }
# }

set -euo pipefail

# --- Auth Resolution ---
resolve_auth() {
  # 1. Environment variable
  if [[ -n "${AZURE_DEVOPS_PAT:-}" ]]; then
    echo "$AZURE_DEVOPS_PAT"
    return 0
  fi

  # 2. Config file
  local config="$HOME/.ado-config.json"
  if [[ -f "$config" ]]; then
    local pat
    pat=$(jq -r '.pat // empty' "$config" 2>/dev/null)
    if [[ -n "$pat" ]]; then
      echo "$pat"
      return 0
    fi
  fi

  # 3. az CLI
  if command -v az &>/dev/null; then
    local token
    token=$(az account get-access-token --resource=499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv 2>/dev/null)
    if [[ -n "$token" ]]; then
      echo "BEARER:$token"
      return 0
    fi
  fi

  echo "ERROR: No Azure DevOps credentials found." >&2
  echo "Set AZURE_DEVOPS_PAT, create ~/.ado-config.json, or login via 'az login'." >&2
  return 1
}

# --- Build Auth Header ---
build_auth_header() {
  local cred="$1"
  if [[ "$cred" == BEARER:* ]]; then
    echo "Authorization: Bearer ${cred#BEARER:}"
  else
    local encoded
    encoded=$(echo -n ":$cred" | base64 | tr -d '\n')
    echo "Authorization: Basic $encoded"
  fi
}

# --- Parse PR URL ---
# Supports: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
# Also: just a numeric ID if --org, --project, --repo are provided
parse_pr_url() {
  local input="$1"

  if [[ "$input" =~ ^https://dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/]+)/pullrequest/([0-9]+) ]]; then
    PR_ORG="${BASH_REMATCH[1]}"
    PR_PROJECT="${BASH_REMATCH[2]}"
    PR_REPO="${BASH_REMATCH[3]}"
    PR_ID="${BASH_REMATCH[4]}"
  elif [[ "$input" =~ ^[0-9]+$ ]]; then
    PR_ID="$input"
    # org/project/repo must come from flags or config
  else
    echo "ERROR: Cannot parse PR reference: $input" >&2
    return 1
  fi
}

# --- Fetch with retry ---
ado_get() {
  local url="$1"
  local auth_header="$2"
  local retries=3
  local wait=2

  for ((i = 1; i <= retries; i++)); do
    local response http_code body
    response=$(curl -s -w "\n%{http_code}" \
      -H "$auth_header" \
      -H "Content-Type: application/json" \
      "$url")

    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')

    if [[ "$http_code" == "200" ]]; then
      echo "$body"
      return 0
    elif [[ "$http_code" == "429" ]]; then
      echo "Rate limited, waiting ${wait}s (attempt $i/$retries)..." >&2
      sleep "$wait"
      wait=$((wait * 2))
    else
      echo "ERROR: HTTP $http_code from $url" >&2
      echo "$body" >&2
      return 1
    fi
  done

  echo "ERROR: Failed after $retries retries" >&2
  return 1
}

# --- Main ---
main() {
  local pr_input=""
  PR_ORG="${ADO_ORG:-}"
  PR_PROJECT="${ADO_PROJECT:-}"
  PR_REPO="${ADO_REPO:-}"
  PR_ID=""

  # Parse args
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --org) PR_ORG="$2"; shift 2 ;;
      --project) PR_PROJECT="$2"; shift 2 ;;
      --repo) PR_REPO="$2"; shift 2 ;;
      *) pr_input="$1"; shift ;;
    esac
  done

  [[ -z "$pr_input" ]] && { echo "Usage: fetch_pr.sh <pr_url_or_id> [--org ORG] [--project PROJECT] [--repo REPO]" >&2; exit 1; }

  parse_pr_url "$pr_input"

  # Fill from config if missing
  if [[ -z "$PR_ORG" || -z "$PR_PROJECT" ]] && [[ -f "$HOME/.ado-config.json" ]]; then
    [[ -z "$PR_ORG" ]] && PR_ORG=$(jq -r '.organization // empty' "$HOME/.ado-config.json")
    [[ -z "$PR_PROJECT" ]] && PR_PROJECT=$(jq -r '.default_project // empty' "$HOME/.ado-config.json")
  fi

  # Validate
  for var in PR_ORG PR_PROJECT PR_ID; do
    [[ -z "${!var}" ]] && { echo "ERROR: $var is required but empty." >&2; exit 1; }
  done

  local cred auth_header
  cred=$(resolve_auth)
  auth_header=$(build_auth_header "$cred")

  local base="https://dev.azure.com/${PR_ORG}/${PR_PROJECT}/_apis/git"

  # If repo not known, fetch from PR details
  if [[ -z "$PR_REPO" ]]; then
    # We need repo — try fetching PR by searching across repos
    echo "ERROR: Repository is required. Provide --repo or use a full PR URL." >&2
    exit 1
  fi

  local pr_url="${base}/repositories/${PR_REPO}/pullRequests/${PR_ID}?api-version=7.1"
  local threads_url="${base}/repositories/${PR_REPO}/pullRequests/${PR_ID}/threads?api-version=7.1"

  echo "Fetching PR #${PR_ID} from ${PR_ORG}/${PR_PROJECT}/${PR_REPO}..." >&2

  local pr_data threads_data
  pr_data=$(ado_get "$pr_url" "$auth_header")
  threads_data=$(ado_get "$threads_url" "$auth_header")

  # Filter threads to actionable human comments
  local result
  result=$(echo "$threads_data" | jq --argjson pr "$pr_data" '{
    pr: {
      id: $pr.pullRequestId,
      title: $pr.title,
      description: ($pr.description // ""),
      sourceBranch: $pr.sourceRefName,
      targetBranch: $pr.targetRefName,
      status: $pr.status,
      createdBy: $pr.createdBy.displayName,
      reviewers: [.reviewers[]? | {name: .displayName, vote: .vote}]
    },
    threads: [
      .value[]
      | select(
          (.comments[0].commentType != "system")
          and (.properties.CodeReviewThreadType == null or .properties.CodeReviewThreadType.$value == null)
          and (.status != "closed" and .status != "wontFix" and .status != "byDesign")
        )
      | {
          threadId: .id,
          status: (.status // "active"),
          filePath: (.threadContext.filePath // null),
          lineRange: (
            if .threadContext then
              {
                start: (.threadContext.rightFileStart.line // null),
                end: (.threadContext.rightFileEnd.line // null)
              }
            else null end
          ),
          comments: [
            .comments[] | select(.commentType != "system") | {
              id: .id,
              author: .author.displayName,
              content: .content,
              parentCommentId: .parentCommentId,
              publishedDate: .publishedDate
            }
          ]
        }
      | select((.comments | length) > 0)
    ],
    stats: {
      total_threads: (.value | length),
      actionable: (
        [.value[]
         | select(
             (.comments[0].commentType != "system")
             and (.properties.CodeReviewThreadType == null or .properties.CodeReviewThreadType.$value == null)
             and (.status != "closed" and .status != "wontFix" and .status != "byDesign")
           )
        ] | length
      ),
      system: (
        [.value[] | select(.comments[0].commentType == "system")] | length
      )
    }
  }')

  echo "$result"
}

main "$@"
