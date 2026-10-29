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
for t in git systemctl systemd-run sha256sum tar; do command -v "$t" >/dev/null || missing+=("$t"); done
# The Node download needs one of the two; Ubuntu Desktop ships wget and not curl (bare-machine.sh, v0.1.6).
command -v curl >/dev/null || command -v wget >/dev/null || missing+=(curl)
if [ ${#missing[@]} -gt 0 ]; then
  echo "MISSING: ${missing[*]}. Install them with your package manager (for example: sudo apt install ${missing[*]}), then run this again."
  exit 1
fi
# A non-interactive ssh session (a desktop's Install on a remote) can come without XDG_RUNTIME_DIR; systemd's own
# /run/user/<uid> stands in, as for remote.mjs READ and PROBE, and systemctl --user below finds the user bus through it.
# Only this user's own folder (systemd makes it 0700, owned by the user). None, or not this user's: no user manager
# runs, so P9's service has nothing to run under until linger is on.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  if [ -d "/run/user/$(id -u)" ] && [ -O "/run/user/$(id -u)" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; else
    echo "P9 runs as a service of this user, and this user has none running here. Run this on this machine: loginctl enable-linger $(id -un)   (it keeps the service running when nobody is logged in), then Install again."
    exit 1
  fi
fi

# Item 15 (row 61): the admin password only for what P9 cannot carry, and only after the reason is on the screen.
# $1: the command, shown in full before the question. No answer (a pipe that ends, a closed terminal) is a no.
admin_install() {
  echo "This needs your admin password. The command:"
  echo "  $1"
  local answer=
  read -r -p "Run it with sudo now? [y/N] " answer || true
  case "$answer" in [yY]*) bash -c "$1" ;; *) return 1 ;; esac
}
# What P9 needs from the system (tmux, ssh; on a desktop, the AppArmor rule for its window): scripts/deps.mjs lists
# each missing one with its reason and the one command for all of them. $@: deps.mjs's flags.
system_deps() {
  local reasons command status=0
  # 3: something P9 needs is missing. Anything else non-zero is the check itself failing, which never counts as "nothing missing".
  # --place: a missing tmux first comes from P9's own pinned build, with no admin password (row 60).
  reasons=$("$node" scripts/deps.mjs "$@" --place) || status=$?
  case $status in 0 | 3) ;; *) echo "P9's dependency check failed (the error is above)."; return 1 ;; esac
  [ -n "$reasons" ] || return 0
  echo "P9 needs these on this machine:"
  echo "$reasons"
  command=$("$node" scripts/deps.mjs "$@" --command) || { echo "P9's dependency check failed (the error is above)."; return 1; }
  [ -z "$command" ] || admin_install "$command" || true
  "$node" scripts/deps.mjs "$@" >/dev/null && return 0
  echo "P9 cannot run without the ones above. Install them, then run this again."
  return 1
}

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
    url="https://nodejs.org/dist/v26.10.0/$name.tar.gz"
    if command -v curl >/dev/null; then curl -fsSL -o "$tmp/node.tar.gz" "$url"; else wget -q -O "$tmp/node.tar.gz" "$url"; fi
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
# Node itself needs libatomic1, which a minimal Ubuntu (a server image, a container) lacks; the desktop has it.
# Asked here, in the shell, because scripts/deps.mjs cannot run until Node does.
if ! node_error=$(node --version 2>&1 >/dev/null); then
  case "$node_error" in
    *libatomic.so.1*)
      echo "P9 needs this on this machine:"
      echo "- libatomic1: Node, which P9 runs on, cannot start without this system library."
      if command -v apt-get >/dev/null; then command="sudo apt-get update; sudo apt-get install -y libatomic1"
      elif command -v dnf >/dev/null; then command="sudo dnf install -y libatomic"
      elif command -v zypper >/dev/null; then command="sudo zypper install -y libatomic1"
      else command=; fi
      if [ -z "$command" ] || ! admin_install "$command" || ! node --version >/dev/null 2>&1; then
        echo "P9 cannot run without it. Install libatomic with your package manager, then run this again."; exit 1
      fi ;;
    *) echo "Node does not start: $node_error"; exit 1 ;;
  esac
fi
node=$(command -v node)
if [ -e "$HOME/.config/systemd/user/p9-foundation.service" ]; then
  # An update checks the system again: a new version can need something the old one did not. Node is in place by now
  # (above), so the check never skips. An install from before the editor server was part of it gets it now (issue #14);
  # one on the pinned release is left alone.
  system_deps --update ${headless:+--headless} || exit 1
  "$node" scripts/install-editor.mjs || echo "Dev Focus's editor server was not installed; Dev Focus offers Install the editor server."
  echo "P9 is already installed. To update: git pull && pnpm install --frozen-lockfile && pnpm build && systemctl --user restart p9-foundation"
  exit 0
fi
system_deps ${headless:+--headless} || exit 1

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
