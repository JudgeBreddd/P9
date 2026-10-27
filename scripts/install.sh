#!/usr/bin/env bash
# Installs P9 for this user from this clone: checks the tools, installs pnpm if missing, builds, and starts the
# daemon as a user service (the README's Linux steps in one command).
# Usage: bash scripts/install.sh [--headless] [workspace folder, default ~/work]
# --headless: a server with no screen. The daemon only, no Electron download; desktops and phones connect to it.
set -euo pipefail
headless=
if [ "${1:-}" = --headless ]; then headless=1; shift; fi
workspace=$(realpath -m -- "${1:-$HOME/work}")
cd "$(dirname -- "$0")/.."

missing=()
for t in git tmux systemctl systemd-run curl sha256sum tar; do command -v "$t" >/dev/null || missing+=("$t"); done
if [ ${#missing[@]} -gt 0 ]; then
  echo "MISSING: ${missing[*]}. Install them with your package manager (for example: sudo apt install ${missing[*]}), then run this again."
  exit 1
fi
: "${XDG_RUNTIME_DIR:?not set: run this from a normal desktop or ssh login}"
if [ -e "$HOME/.config/systemd/user/p9-foundation.service" ]; then
  # An install from before the editor server was part of it gets it now (issue #14); one on the pinned release is left alone.
  node=$(command -v node || ls "$HOME"/.local/share/p9/node-v26.10.0-linux-*/bin/node 2>/dev/null | head -1 || true)
  [ -n "$node" ] && "$node" scripts/install-editor.mjs || echo "Dev Focus's editor server was not installed; Dev Focus offers Install the editor server."
  echo "P9 is already installed. To update: git pull && pnpm install --frozen-lockfile && pnpm build && systemctl --user restart p9-foundation"
  exit 0
fi
path_added=()
# Without Node v26.10.0 on PATH, P9 gets its own copy from nodejs.org, checked against the pinned SHA-256 from
# nodejs.org/dist/v26.10.0/SHASUMS256.txt (the same list package-windows.mjs pins its Windows zip from).
if [ "$(node --version 2>/dev/null || true)" != "v26.10.0" ]; then
  case "$(uname -m)" in
    x86_64) arch=x64 sum=cb5c9ce9c80d7b8821e3a258543c71b939138cf17c74d5cc44bbe85d6dbc5ad8 ;;
    aarch64 | arm64) arch=arm64 sum=423a41bff8e2a2fa15e702fefe2919ef95823b2378744daccb8439302534b44f ;;
    *) echo "P9 needs Node v26.10.0 and has no download for $(uname -m). Install it yourself, then run this again."; exit 1 ;;
  esac
  share="$HOME/.local/share/p9" name="node-v26.10.0-linux-$arch"
  if [ ! -x "$share/$name/bin/node" ]; then
    echo "Downloading Node v26.10.0 for P9 into $share/$name"
    mkdir -p -- "$share"
    tmp=$(mktemp -d "$share/.download-XXXXXX")
    curl -fsSL -o "$tmp/node.tar.gz" "https://nodejs.org/dist/v26.10.0/$name.tar.gz"
    if ! echo "$sum  $tmp/node.tar.gz" | sha256sum -c --quiet; then
      rm -f -- "$tmp/node.tar.gz"; rmdir -- "$tmp"
      echo "The Node download does not match its pinned checksum; nothing was installed."
      exit 1
    fi
    tar -xzf "$tmp/node.tar.gz" -C "$tmp"
    mv -- "$tmp/$name" "$share/$name"
    rm -f -- "$tmp/node.tar.gz"; rmdir -- "$tmp"
  fi
  export PATH="$share/$name/bin:$PATH"; path_added+=("$share/$name/bin")
fi

if ! command -v pnpm >/dev/null; then
  # A system Node installs global packages to /usr, which needs root; fall back to ~/.local.
  npm install -g pnpm@10.34.6 || npm install -g pnpm@10.34.6 --prefix "$HOME/.local"
  command -v pnpm >/dev/null || { export PATH="$HOME/.local/bin:$PATH"; path_added+=("$HOME/.local/bin"); }
fi
# --ignore-scripts skips package.json's postinstall, the one step that downloads Electron.
if [ -n "$headless" ]; then pnpm install --frozen-lockfile --ignore-scripts; else pnpm install --frozen-lockfile; fi
pnpm build
mkdir -p -- "$workspace"
node scripts/install-service.mjs "$workspace"
# Dev Focus's editor server (pinned and checked, threat model row 52). Headless too: a desktop in Server mode runs Dev Focus
# on the server's editor server. If it fails, Dev Focus offers the same install as a button.
node scripts/install-editor.mjs || echo "Dev Focus's editor server was not installed; Dev Focus offers Install the editor server."
if [ ${#path_added[@]} -gt 0 ]; then
  new_path=$(IFS=:; echo "${path_added[*]}")
  echo "Add this line to ~/.bashrc so node and pnpm are found next time:  export PATH=\"$new_path:\$PATH\""
fi
if [ -n "$headless" ]; then
  echo "P9 runs on this server. Connect from a desktop's Settings > Server, or pair a phone with: node scripts/teh.mjs devices"
elif [ ${#path_added[@]} -gt 0 ]; then
  echo "Open P9:  export PATH=\"$new_path:\$PATH\" && cd $PWD && pnpm desktop --state \"\$XDG_RUNTIME_DIR/p9-foundation\""
else
  echo "Open P9:  cd $PWD && pnpm desktop --state \"\$XDG_RUNTIME_DIR/p9-foundation\""
fi
