#!/usr/bin/env bash
# AgentX one-line installer.
#
# Usage (typical):
#   curl -fsSL https://raw.githubusercontent.com/anis-marrouchi/agentx/main/install.sh | bash
#
# What it does:
#   1. Checks for Node.js 22.19 up to 26. When it is missing or too old:
#      with nvm, installs Node 22 through nvm and makes it the default;
#      without nvm, downloads the official Node 22 from nodejs.org into
#      ~/.agentx/node (checksum checked) and adds it to your shell's PATH.
#   2. Installs agentix-cli globally via npm.
#   3. Runs `agentx start` — creates a config with one agent (if the folder
#      has none), starts the daemon and the dashboard in the background, and
#      opens that agent's chat in the browser. Safe to run again.
#
# Environment:
#   AGENTX_VERSION   - optional npm dist-tag or exact version (default: latest)
#   AGENTX_SKIP_SETUP - set to "1" to install without starting anything
#   AGENTX_INSTALL_NODE - set to "0" to stop instead of downloading Node
#                         when neither a supported Node nor nvm is present
set -euo pipefail

AGENTX_VERSION="${AGENTX_VERSION:-latest}"
AGENTX_SKIP_SETUP="${AGENTX_SKIP_SETUP:-0}"
AGENTX_INSTALL_NODE="${AGENTX_INSTALL_NODE:-1}"
AGENTX_NODE_DIR="${HOME}/.agentx/node"
NEED_NODE_LINE="Install Node.js 22 (https://nodejs.org/en/download), then run this script again."

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
info()  { printf "  %s\n" "$*"; }
ok()    { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[33m!\033[0m %s\n" "$*"; }
err()   { printf "  \033[31m✗\033[0m %s\n" "$*" >&2; }

echo
bold "AgentX — the AI operations layer for your team"
echo

# The official Node 22 build for this machine, from nodejs.org, into
# ~/.agentx/node. No nvm, no sudo. Stops with one line when it cannot.
install_node() {
  local os arch base sums file sum got tmp
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) err "This system is not supported by the installer. ${NEED_NODE_LINE}"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) err "No Node.js download for $(uname -m). ${NEED_NODE_LINE}"; exit 1 ;;
  esac
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    err "Downloading Node.js needs curl and tar. ${NEED_NODE_LINE}"; exit 1
  fi
  base="https://nodejs.org/dist/latest-v22.x"
  info "Downloading Node 22 from nodejs.org into ${AGENTX_NODE_DIR}…"
  sums="$(curl -fsSL "${base}/SHASUMS256.txt")" || { err "Could not reach nodejs.org. ${NEED_NODE_LINE}"; exit 1; }
  file="$(printf '%s\n' "${sums}" | awk -v f="-${os}-${arch}.tar.gz" 'index($2, f) && $2 ~ /^node-v22\./ {print $2; exit}')"
  sum="$(printf '%s\n' "${sums}" | awk -v f="${file}" '$2 == f {print $1; exit}')"
  [[ -n "${file}" && -n "${sum}" ]] || { err "No Node 22 download for ${os}-${arch}. ${NEED_NODE_LINE}"; exit 1; }
  tmp="$(mktemp -d)"
  curl -fsSL "${base}/${file}" -o "${tmp}/${file}" || { rm -rf "${tmp}"; err "Node.js download failed. ${NEED_NODE_LINE}"; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "${tmp}/${file}" | awk '{print $1}')"
  else got="$(shasum -a 256 "${tmp}/${file}" | awk '{print $1}')"; fi
  [[ "${got}" == "${sum}" ]] || { rm -rf "${tmp}"; err "The Node.js download did not match its checksum. ${NEED_NODE_LINE}"; exit 1; }
  rm -rf "${AGENTX_NODE_DIR}"
  mkdir -p "${AGENTX_NODE_DIR}"
  tar -xzf "${tmp}/${file}" -C "${AGENTX_NODE_DIR}" --strip-components=1
  rm -rf "${tmp}"
  export PATH="${AGENTX_NODE_DIR}/bin:${PATH}"
  ok "Node $(node -v) installed in ${AGENTX_NODE_DIR}"

  # Keep it on PATH for new terminals, so `agentx` works there too.
  # Linux bash also gets ~/.profile: login shells (ssh, some terminals) read
  # it instead of ~/.bashrc, which returns early when not interactive.
  local rc rcs line
  case "${SHELL:-}" in
    */zsh) rcs=("${HOME}/.zshrc") ;;
    */bash) [[ "$(uname -s)" == "Darwin" ]] && rcs=("${HOME}/.bash_profile") || rcs=("${HOME}/.bashrc" "${HOME}/.profile") ;;
    *) rcs=("${HOME}/.profile") ;;
  esac
  line='export PATH="$HOME/.agentx/node/bin:$PATH"  # added by the AgentX installer'
  for rc in "${rcs[@]}"; do
    if ! grep -qsF '.agentx/node/bin' "${rc}"; then
      printf '\n%s\n' "${line}" >> "${rc}"
      ok "Added ~/.agentx/node/bin to PATH in ${rc}"
    fi
  done
}

# 1. Node check
# A Node this script installed on an earlier run, in a terminal that has
# not picked up the PATH line yet.
installed_node=0
if [[ -x "${AGENTX_NODE_DIR}/bin/node" ]]; then
  export PATH="${AGENTX_NODE_DIR}/bin:${PATH}"
fi
need_node_install=0
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js is not installed."
  need_node_install=1
else
  node_ok="$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); (a>22||(a===22&&b>=19))&&a<27?1:0')"
  if [[ "${node_ok}" != "1" ]]; then
    warn "Node.js $(node -v) is not supported — AgentX needs 22.19 or newer, up to 26."
    need_node_install=1
  else
    ok "Node.js $(node -v) detected"
  fi
fi

if [[ "${need_node_install}" -eq 1 ]]; then
  if command -v nvm >/dev/null 2>&1 || [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    info "Found nvm — installing Node 22…"
    # shellcheck disable=SC1090,SC1091
    [[ -s "${HOME}/.nvm/nvm.sh" ]] && . "${HOME}/.nvm/nvm.sh"
    nvm install 22 >/dev/null
    nvm use 22 >/dev/null
    # Keep Node 22 for new shells too; `nvm use` only lasts for this script.
    nvm alias default 22 >/dev/null
    ok "Node $(node -v) now active"
  elif [[ "${AGENTX_INSTALL_NODE}" == "1" ]]; then
    install_node
    installed_node=1
  else
    err "${NEED_NODE_LINE}"
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

# 3. Start (unless skipped)
if [[ "${AGENTX_SKIP_SETUP}" == "1" ]]; then
  echo
  bold "Done."
  info "Run  agentx start  when you're ready: it starts your first agent and opens its chat."
  [[ "${installed_node}" -eq 1 ]] && info "Open a new terminal first, so it finds the Node.js and agentx this script installed."
  echo
  exit 0
fi

echo
bold "Starting your first agent…"
info "The config, the daemon and the dashboard go in this folder: $(pwd)"
echo

exec agentx start
