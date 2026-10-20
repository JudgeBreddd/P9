#!/usr/bin/env bash
# Installs P9 for this user from this clone: checks the tools, installs pnpm if missing, builds, and starts the
# daemon as a user service (the README's Linux steps in one command).
# Usage: bash scripts/install.sh [workspace folder, default ~/work]
set -euo pipefail
workspace=$(realpath -m -- "${1:-$HOME/work}")
cd "$(dirname -- "$0")/.."

missing=()
for t in git npm tmux systemctl systemd-run curl sha256sum tar; do command -v "$t" >/dev/null || missing+=("$t"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "MISSING: ${missing[*]}. Install them with your package manager (for example: sudo apt install ${missing[*]}), then run this again."
  exit 1
fi
node_version=$(node --version 2>/dev/null || true)
if [ "$node_version" != "v26.10.0" ]; then
  echo "P9 needs Node v26.10.0, found '${node_version:-none}'. Install it (nodejs.org, or: fnm install 26.10.0), then run this again."
  exit 1
fi
: "${XDG_RUNTIME_DIR:?not set: run this from a normal desktop or ssh login}"
if [ -e "$HOME/.config/systemd/user/p9-foundation.service" ]; then
  echo "P9 is already installed. To update: git pull && pnpm install --frozen-lockfile && pnpm build && systemctl --user restart p9-foundation"
  exit 0
fi

if ! command -v pnpm >/dev/null; then
  # A system Node installs global packages to /usr, which needs root; fall back to ~/.local.
  npm install -g pnpm@10.34.6 || npm install -g pnpm@10.34.6 --prefix "$HOME/.local"
  command -v pnpm >/dev/null || { export PATH="$HOME/.local/bin:$PATH"; echo "NOTE: add ~/.local/bin to your PATH so pnpm is found next time."; }
fi
pnpm install --frozen-lockfile
pnpm build
mkdir -p -- "$workspace"
node scripts/install-service.mjs "$workspace"
echo "Open P9:  cd $PWD && pnpm desktop --state \"\$XDG_RUNTIME_DIR/p9-foundation\""
