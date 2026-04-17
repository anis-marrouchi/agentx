#!/usr/bin/env bash
# AgentX one-line installer.
#
# Usage (typical):
#   curl -fsSL https://raw.githubusercontent.com/anis-marrouchi/agentx/master/install.sh | bash
#
# What it does:
#   1. Checks for Node.js >= 20 (installs via nvm if missing and nvm is present).
#   2. Installs agentix-cli globally via npm.
#   3. Runs `agentx setup` — opens the web wizard in the browser.
#
# Environment:
#   AGENTX_VERSION   - optional npm dist-tag or exact version (default: latest)
#   AGENTX_SKIP_SETUP - set to "1" to install without launching the wizard
set -euo pipefail

AGENTX_VERSION="${AGENTX_VERSION:-latest}"
AGENTX_SKIP_SETUP="${AGENTX_SKIP_SETUP:-0}"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
info()  { printf "  %s\n" "$*"; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m!\033[0m %s\n" "$*"; }
err()   { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; }

echo
bold "AgentX — the AI operations layer for your team"
echo

# 1. Node check
need_node_install=0
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed."
  need_node_install=1
else
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "${node_major}" -lt 20 ]]; then
    warn "Node.js ${node_major} is too old — AgentX needs >= 20."
    need_node_install=1
  else
    ok "Node.js $(node -v) detected"
  fi
fi

if [[ "${need_node_install}" -eq 1 ]]; then
  if command -v nvm >/dev/null 2>&1 || [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    info "Found nvm — installing Node 20…"
    # shellcheck disable=SC1090,SC1091
    [[ -s "${HOME}/.nvm/nvm.sh" ]] && . "${HOME}/.nvm/nvm.sh"
    nvm install 20 >/dev/null
    nvm use 20 >/dev/null
    ok "Node $(node -v) now active"
  else
    err "Install Node.js 20+ first (https://nodejs.org or https://github.com/nvm-sh/nvm), then rerun this script."
    exit 1
  fi
fi

# 2. npm install -g
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found in PATH. Install Node.js the usual way and rerun."
  exit 1
fi

info "Installing agentix-cli@${AGENTX_VERSION} globally via npm…"
if ! npm install -g "agentix-cli@${AGENTX_VERSION}" >/dev/null 2>&1; then
  warn "Global install failed — retrying with verbose output so you can see why:"
  npm install -g "agentix-cli@${AGENTX_VERSION}" || {
    err "npm install failed. On some systems you may need 'sudo npm install -g ...'"
    exit 1
  }
fi
ok "agentix-cli installed: $(agentx --version 2>/dev/null || echo 'ready')"

# 3. Launch wizard (unless skipped)
if [[ "${AGENTX_SKIP_SETUP}" == "1" ]]; then
  echo
  bold "Done."
  info "Run  agentx setup  when you're ready to configure your first agent."
  echo
  exit 0
fi

echo
bold "Launching the setup wizard…"
info "This opens http://127.0.0.1:4202/setup in your browser."
info "If nothing opens, visit that URL manually."
echo

exec agentx setup
