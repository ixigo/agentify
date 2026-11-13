#!/usr/bin/env bash
#
# Agentify installer — installs the CLI straight from GitHub (no npm registry
# release required).
#
#   curl -fsSL https://raw.githubusercontent.com/ixigo/agentify/main/install.sh | bash
#
# By default this installs the latest published release tag (the highest
# vX.Y.Z), resolved with `git ls-remote` — no GitHub token or `gh` required. If
# no release tag exists yet, or resolution fails, it falls back to `main` and
# says so.
#
# Options via environment variables:
#   AGENTIFY_REF=<branch|tag|sha>  pin an explicit ref (overrides tag resolution)
#   AGENTIFY_REPO=ixigo/agentify   GitHub repo to install from
#
set -euo pipefail

REPO="${AGENTIFY_REPO:-ixigo/agentify}"
REF="${AGENTIFY_REF:-}"
REPO_URL="https://github.com/${REPO}.git"

BOLD=$(printf '\033[1m')
DIM=$(printf '\033[2m')
GREEN=$(printf '\033[32m')
RED=$(printf '\033[31m')
RESET=$(printf '\033[0m')

info()  { printf "%s\n" "$1"; }
ok()    { printf "${GREEN}✔${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✖${RESET} %s\n" "$1" >&2; exit 1; }

# Print the highest vX.Y.Z release tag for a repo, or nothing. Peeled annotated
# refs (`^{}`) and non-release tags are filtered out, and the sort is numeric
# per component so v0.10.0 ranks above v0.9.0.
resolve_latest_tag() {
  git ls-remote --tags --refs "$1" 2>/dev/null \
    | awk -F/ '{print $NF}' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sed 's/^v//' \
    | sort -t. -k1,1n -k2,2n -k3,3n \
    | tail -n1 \
    | sed 's/^/v/'
}

info "${BOLD}Agentify installer${RESET} ${DIM}(${REPO})${RESET}"
info ""

command -v git >/dev/null 2>&1 || fail "git is required. Install git and re-run."
command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required. Install it from https://nodejs.org and re-run."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js 22+ is required (found $(node --version))."
fi
ok "Node $(node --version), git $(git --version | awk '{print $3}')"

command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)."

if [ -n "$REF" ]; then
  info "Using pinned ref ${BOLD}${REF}${RESET} (AGENTIFY_REF)."
else
  REF="$(resolve_latest_tag "$REPO_URL" || true)"
  if [ -n "$REF" ]; then
    info "Latest release is ${BOLD}${REF}${RESET}."
  else
    REF="main"
    info "No release tag found; falling back to ${BOLD}main${RESET}."
  fi
fi

info "Installing agentify from git+${REPO_URL}#${REF} ..."
if ! npm install -g "git+${REPO_URL}#${REF}" --loglevel=error; then
  info ""
  info "Global install failed. If this was a permissions error, either:"
  info "  - configure a user-writable npm prefix:  ${DIM}npm config set prefix ~/.local && export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
  info "  - or re-run with sudo:                   ${DIM}curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sudo bash${RESET}"
  fail "npm install -g failed"
fi

# Record the installed ref next to the package so `agentify --version` can tell
# a release build from a tracking build. npm/pnpm strip git metadata from the
# installed package.json unreliably, so this file is the dependable signal.
# Best-effort: a read-only global prefix just leaves it absent.
PKG_DIR="$(npm root -g 2>/dev/null)/agentify"
if [ -d "$PKG_DIR" ]; then
  COMMIT="$(git ls-remote "$REPO_URL" "$REF" "${REF}^{}" 2>/dev/null | awk 'END{print $1}')"
  printf '{"ref":"%s","commit":"%s","repo":"%s"}\n' "$REF" "$COMMIT" "$REPO" \
    > "$PKG_DIR/.agentify-build-info.json" 2>/dev/null || true
fi

if ! command -v agentify >/dev/null 2>&1; then
  fail "agentify installed but is not on PATH. Check 'npm bin -g' is in your PATH, then run: agentify --version"
fi

ok "Installed $(agentify --version)"
info ""
info "${BOLD}Next steps${RESET}"
info "  cd /path/to/your/repo"
info "  agentify install                  ${DIM}# wire up Claude Code (CLAUDE.md + hooks)${RESET}"
info "  agentify install --provider codex ${DIM}# or Codex (AGENTS.md guidance)${RESET}"
info "  agentify install --provider all   ${DIM}# or both${RESET}"
info "  agentify scan                     ${DIM}# optional: structural index for query/risk${RESET}"
info "  agentify status                   ${DIM}# verify${RESET}"
