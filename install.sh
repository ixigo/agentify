#!/usr/bin/env bash
#
# Agentify installer — installs the CLI straight from GitHub (no npm registry
# release required).
#
#   curl -fsSL https://raw.githubusercontent.com/ixigo/agentify/main/install.sh | bash
#
# Options via environment variables:
#   AGENTIFY_REF=main        git branch, tag, or commit to install
#   AGENTIFY_REPO=ixigo/agentify   GitHub repo to install from
#
set -euo pipefail

REPO="${AGENTIFY_REPO:-ixigo/agentify}"
REF="${AGENTIFY_REF:-main}"

BOLD=$(printf '\033[1m')
DIM=$(printf '\033[2m')
GREEN=$(printf '\033[32m')
RED=$(printf '\033[31m')
RESET=$(printf '\033[0m')

info()  { printf "%s\n" "$1"; }
ok()    { printf "${GREEN}✔${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✖${RESET} %s\n" "$1" >&2; exit 1; }

info "${BOLD}Agentify installer${RESET} ${DIM}(${REPO}@${REF})${RESET}"
info ""

command -v git >/dev/null 2>&1 || fail "git is required. Install git and re-run."
command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required. Install it from https://nodejs.org and re-run."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20+ is required (found $(node --version))."
fi
ok "Node $(node --version), git $(git --version | awk '{print $3}')"

command -v npm >/dev/null 2>&1 || fail "npm is required (it ships with Node.js)."

info "Installing agentify from git+https://github.com/${REPO}.git#${REF} ..."
if ! npm install -g "git+https://github.com/${REPO}.git#${REF}" --loglevel=error; then
  info ""
  info "Global install failed. If this was a permissions error, either:"
  info "  - configure a user-writable npm prefix:  ${DIM}npm config set prefix ~/.local && export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
  info "  - or re-run with sudo:                   ${DIM}curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sudo bash${RESET}"
  fail "npm install -g failed"
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
