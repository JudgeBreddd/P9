#!/usr/bin/env bash
# Installs P9 for this user from this clone: checks the tools, installs pnpm if missing, builds, and starts the
# daemon as a user service (the README's Linux steps in one command).
# Usage: bash scripts/install.sh [--headless [--background]] [workspace folder, default ~/work]
# --headless: a server with no screen. The daemon only, no Electron download; desktops and phones connect to it.
# --background: the desktop's "No" to Keep P9 running there (threat model row I1): no linger and no service; P9 runs as a
# background process while a desktop is connected, the way VS Code's server runs. Without it, a server keeps P9 running.
# --admin-stdin (row I2): the admin password the person typed into the desktop's install window is stdin's first line.
# Without it, --headless stops where an admin is needed: P9_ADMIN need and P9_ADMIN command lines, exit 5.
set -euo pipefail
headless= background= admin_stdin= p9_pw=
while case "${1:-}" in --headless) headless=1 ;; --background) background=1 ;; --admin-stdin) admin_stdin=1 ;; *) false ;; esac; do shift; done
[ -z "$background$admin_stdin" ] || [ -n "$headless" ] || { echo "--background and --admin-stdin go with --headless."; exit 1; }
# Before anything else can read stdin; never echoed (no set -x anywhere here).
if [ -n "$admin_stdin" ]; then IFS= read -r p9_pw || true; exec </dev/null; fi
# Shared with the desktop's remote install script and the start script: p9_tools, p9_install_command, p9_admin.
. "$(dirname -- "$0")/../apps/desktop/tools.sh"
q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
# need "name: reason": one thing P9 needs here. The desktop reads P9_ADMIN need; a person at a terminal reads "- ".
need() { if [ -n "$headless" ]; then echo "P9_ADMIN need $1"; else echo "- $1"; fi; }
# admin_run COMMAND (no sudo in it; empty: no package manager P9 knows): as admin, after the reasons are on the screen.
# The desktop's password (--admin-stdin), or for the desktop with none yet, stop and ask it (exit 5); at a terminal, ask.
admin_run() {
  [ -n "$1" ] || return 1
  if [ -n "$admin_stdin" ]; then p9_admin "$1"
  elif [ -n "$headless" ]; then echo "P9_ADMIN command $1"; exit 5
  else admin_install "sudo sh -c $(q "$1")"
  fi
}
run_dir="$HOME/.local/share/p9/run"
workspace=$(realpath -m -- "${1:-$HOME/work}")
cd "$(dirname -- "$0")/.."

# The tools from before Node exists (apps/desktop/tools.sh), each with its reason; then the one command for all of them.
p9_tools
if [ -n "$P9_TOOLS_NEED" ]; then
  echo "P9 needs these on this machine:"
  printf '%s' "$P9_TOOLS_NEED" | while IFS= read -r line; do need "$line"; done
  admin_run "$(p9_install_command "$P9_TOOLS_PACKAGES")" || true
  p9_tools
  [ -z "$P9_TOOLS_NEED" ] || { echo "P9 cannot install without them. Install them with this machine's package manager, then run this again."; exit 1; }
fi
# A non-interactive ssh session (a desktop's Install on a remote) can come without XDG_RUNTIME_DIR; systemd's own
# /run/user/<uid> stands in, as for remote.mjs READ and PROBE, and systemctl --user below finds the user bus through it.
# Only this user's own folder (systemd makes it 0700, owned by the user). None, or not this user's: no user manager
# runs, so P9's service has nothing to run under until linger is on.
# A server (--headless, which a desktop's Install on a remote runs) keeps P9 running when nobody is logged in: linger for
# this user's own account. systemd's polkit default for that (set-self-linger) needs no password; where a rule asks for
# one, --no-ask-password fails at once instead of waiting for an answer nobody can give.
lingered=
if [ -n "$headless" ] && [ -z "$background" ] && command -v loginctl >/dev/null && [ "$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null)" != yes ]; then
  if loginctl --no-ask-password enable-linger 2>/dev/null; then lingered=1; echo "P9 keeps running on this machine when nobody is logged in (linger is on for this user)."; fi
fi
# A server with no user manager even so (linger refused, no systemd user session) still gets P9, as a background process of
# this user, the way VS Code's server runs (threat model row I1): scripts/background.sh. It stops when nobody uses it, a
# desktop's next connect starts it again, and the app's Keep it running moves it to the service once linger is on.
if [ -z "$background" ] && [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  # Linger starts the user manager, which makes the folder a moment later.
  if [ -n "$lingered" ]; then for _ in $(seq 20); do [ -d "/run/user/$(id -u)" ] && break; sleep 0.5; done; fi
  if [ -d "/run/user/$(id -u)" ] && [ -O "/run/user/$(id -u)" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  elif [ -n "$headless" ]; then background=1
  else
    echo "P9 runs as a service of this user, and this user has none running here. Run this on this machine: loginctl enable-linger $(id -un)   (it keeps the service running when nobody is logged in), then Install again."
    exit 1
  fi
fi
# Linux keeps a Unix socket's path in 107 bytes (the daemon refuses a longer one too); a long home folder path leaves none.
socket_length=$(printf %s "$run_dir/p9-foundation/daemon.sock" | wc -c)
if [ -n "$background" ] && [ "$socket_length" -gt 107 ]; then
  echo "P9_INSTALL socket-path-too-long"
  echo "P9 cannot run for this user here: Linux allows 107 characters for the path of P9's connection file, and in this user's home folder it is $socket_length."
  exit 1
fi
# Row I1: ~/.local/share/p9/run/start, the one script that starts, keeps or releases P9 on a server: these values, then
# scripts/background.sh. Written for every server install, so the desktop can switch modes later; the file background
# marks background mode (remote.mjs READ starts the daemon only then), lingered marks linger P9 turned on.
# Each value single-quoted (a ' as '\''), so sh, dash too, reads a path with spaces or quotes as it was.
write_start() {
  (umask 077 && mkdir -p -- "$run_dir")
  chmod 700 -- "$run_dir"
  [ -O "$run_dir" ] || { echo "P9 cannot use $run_dir: that folder is not this user's."; exit 1; }
  {
    echo '#!/bin/sh'
    echo "# Written by P9's install.sh: sh start [up | keep | release | deps] (scripts/background.sh)."
    echo "r=$(q "$run_dir") node=$(q "$node") checkout=$(q "$PWD")"
    echo "workspace=$(q "$workspace") recovery=$(q "$HOME/.local/state/p9-foundation/conflicts")"
    echo "PATH=$(q "$PATH"); export PATH"
    cat apps/desktop/tools.sh scripts/background.sh
  } > "$run_dir/start.new"
  chmod 700 -- "$run_dir/start.new"
  mv -f -- "$run_dir/start.new" "$run_dir/start"
  if [ -n "$background" ]; then : > "$run_dir/background"; else rm -f -- "$run_dir/background"; fi
  if [ -n "$lingered" ]; then : > "$run_dir/lingered"; fi
}

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
  printf '%s\n' "$reasons" | while IFS= read -r line; do need "${line#- }"; done
  # --root: the command with no sudo in it, as admin_run runs it.
  command=$("$node" scripts/deps.mjs "$@" --command --root) || { echo "P9's dependency check failed (the error is above)."; return 1; }
  admin_run "$command" || true
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
      need "libatomic1: Node, which P9 runs on, cannot start without this system library."
      if command -v dnf >/dev/null && ! command -v apt-get >/dev/null; then command=$(p9_install_command " libatomic"); else command=$(p9_install_command " libatomic1"); fi
      if ! admin_run "$command" || ! node --version >/dev/null 2>&1; then
        echo "P9 cannot run without it. Install libatomic with your package manager, then run this again."; exit 1
      fi ;;
    *) echo "Node does not start: $node_error"; exit 1 ;;
  esac
fi
node=$(command -v node)
if [ -e "$HOME/.config/systemd/user/p9-foundation.service" ] || { [ -n "$background" ] && [ -e "$run_dir/background" ]; }; then
  # An update checks the system again: a new version can need something the old one did not. Node is in place by now
  # (above), so the check never skips. An install from before the editor server was part of it gets it now (issue #14);
  # one on the pinned release is left alone.
  system_deps --update ${headless:+--headless} || exit 1
  "$node" scripts/install-editor.mjs || echo "Dev Focus's editor server was not installed; Dev Focus offers Install the editor server."
  if [ -n "$background" ]; then write_start; echo "P9 is already installed here; a desktop's connect starts it."; exit 0; fi
  if [ -n "$headless" ]; then write_start; fi
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
if [ -n "$headless" ]; then write_start; fi
if [ -n "$background" ]; then sh "$run_dir/start" up; else node scripts/install-service.mjs "$workspace"; fi
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
