#!/usr/bin/env bash
# Item 15 (v0.1.6 c13): what a bare Linux machine lacks for P9, found by installing on one. CI only (test.yaml, bare
# input) or by hand on a machine with Docker; never touches the P9 that runs here. Every step prints what it found.
#   bash scripts/bare-machine.sh boot       a privileged Ubuntu 24.04 container running systemd: user p9 (NOPASSWD sudo,
#                                           linger), git (the user cloned P9) and nothing P9 needs; this clone copied in
#   bash scripts/bare-machine.sh discover   install.sh --headless; each MISSING line's packages installed, then again
#   bash scripts/bare-machine.sh tmux DIR   static tmux from the pinned source on pinned Alpine, run on bare Ubuntu, into DIR
set -euo pipefail
cd "$(dirname -- "$0")/.."
UBUNTU=ubuntu:24.04@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c
ALPINE=alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
TMUX_VERSION=3.8 TMUX_SHA256=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
NAME=${BARE_NAME:-p9-bare}
# The Ubuntu package that holds a library, for this machine's architecture: apt-file in a throwaway container, so
# apt-file and perl never reach the bare machine.
apt_file() {
  docker image inspect p9-bare-apt-file >/dev/null 2>&1 \
    || printf 'FROM %s\nRUN apt-get update && apt-get install -y apt-file && apt-file update\n' "$UBUNTU" | docker build -q -t p9-bare-apt-file - >/dev/null
  docker run --rm p9-bare-apt-file apt-file search -l -x "^/(usr/)?lib/$(docker exec "$NAME" uname -m)-linux-gnu/$1\$" | head -1
}
as_p9() { docker exec -u p9 -w /srv/p9/p9 -e XDG_RUNTIME_DIR=/run/user/1000 -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus "$NAME" bash -lc "$1"; }

case "${1:-}" in
boot)
  docker build -q -t p9-bare - <<EOF
FROM $UBUNTU
RUN apt-get update && apt-get install -y systemd systemd-sysv dbus-user-session sudo ca-certificates git \
 && (userdel -r ubuntu || true) && useradd -m -d /srv/p9 -u 1000 -s /bin/bash p9 \
 && echo 'p9 ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/p9 && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/p9
CMD ["/sbin/init"]
EOF
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock p9-bare >/dev/null
  for i in $(seq 1 100); do docker exec "$NAME" test -S /run/user/1000/bus 2>/dev/null && break; sleep 0.3; done
  docker exec "$NAME" test -S /run/user/1000/bus || { docker logs "$NAME" | tail -40; echo "BARE_NOT_BOOTED"; exit 1; }
  git ls-files -z | tar --null -T - -cf - | docker exec -i "$NAME" bash -c 'mkdir -p /srv/p9/p9 && tar -xf - -C /srv/p9/p9 && chown -R p9:p9 /srv/p9/p9'
  as_p9 'git init -q && git add -A && git -c user.name=bare -c user.email=bare@localhost commit -qm clone'
  echo "BARE_BOOTED $(docker exec "$NAME" uname -m) $(as_p9 'systemctl --user is-system-running || true')"
  docker exec "$NAME" dpkg-query -W -f '${Package}\n' | sort > /tmp/p9-bare-before.txt
  ;;
discover)
  # install.sh stops at its first MISSING line; each round installs exactly what that line names (the package that holds
  # each tool on Ubuntu), so the list printed at the end is everything, in the order a user would meet it.
  declare -A pkg=([git]=git [tmux]=tmux [systemctl]=systemd [systemd-run]=systemd [curl]=curl [wget]=wget [sha256sum]=coreutils [tar]=tar)
  needed=()
  for round in 1 2 3 4 5 6 7 8; do
    if as_p9 'bash scripts/install.sh --headless' > /tmp/p9-bare-install.log 2>&1; then status=0; else status=$?; fi
    cat /tmp/p9-bare-install.log
    [ "$status" = 0 ] && { echo "BARE_INSTALLED round $round"; installed=1; break; }
    line=$(grep -m1 '^MISSING' /tmp/p9-bare-install.log || true)
    lib=$(grep -m1 -o 'error while loading shared libraries: [^:]*' /tmp/p9-bare-install.log | sed 's/.*: //' || true)
    if [ -n "$line" ]; then
      tools=${line#*MISSING: }; tools=${tools%%.*}
      for t in $tools; do needed+=("${pkg[$t]:-$t}"); done
      echo "BARE_MISSING round $round: $tools"
    elif [ -n "$lib" ]; then
      # A program that will not start for want of a library: the package that holds it, from Ubuntu's own file lists.
      found=$(apt_file "$lib")
      [ -n "$found" ] || { echo "BARE_INSTALL_FAILED round $round ($lib: no Ubuntu package holds it)"; break; }
      needed+=("$found"); echo "BARE_MISSING round $round: $lib (package $found)"
    else echo "BARE_INSTALL_FAILED round $round (exit $status: the cause is above)"; break; fi
    docker exec "$NAME" bash -c "DEBIAN_FRONTEND=noninteractive apt-get install -y $(printf '%s ' "${needed[@]}")" | tail -2
  done
  echo "BARE_NEEDED ${needed[*]:-none}"
  docker exec "$NAME" dpkg-query -W -f '${Package}\n' | sort | comm -13 /tmp/p9-bare-before.txt - | tr '\n' ' ' | sed 's/^/BARE_ADDED_PACKAGES /'; echo
  # Libraries the installed programs load that this machine lacks (node, and every native module pnpm installed).
  # (A module's musl build is never loaded on glibc.)
  as_p9 'for f in ~/.local/share/p9/node-*/bin/node $(find node_modules -name "*.node" ! -name "*musl*" 2>/dev/null); do ldd "$f" 2>/dev/null | grep "not found" | sed "s|^|BARE_LIB_MISSING $f: |"; done; true'
  # The daemon, as the desktop and the wizard see it.
  node='$(ls ~/.local/share/p9/node-*/bin/node | head -1)'
  as_p9 "$node --input-type=module -e \"import { daemonRequest } from './scripts/teh.mjs'; const s = process.env.XDG_RUNTIME_DIR + '/p9-foundation';
    for (const p of ['/health', '/setup']) { const r = await daemonRequest(s, 'GET', p).catch((e) => ({ status: 0, body: String(e) })); console.log('BARE_DAEMON', p, r.status, JSON.stringify(r.body)); }\"" || true
  as_p9 'journalctl --user -u p9-foundation --no-pager | tail -20' || true
  # The desktop install (no --headless) also runs Electron: its own download, then what it cannot load, round by round
  # (a library's own libraries show only once it is there), each with its package and whether Ubuntu Desktop has it.
  arch=$(docker exec "$NAME" dpkg --print-architecture)
  # Ubuntu Desktop for amd64 is on releases.ubuntu.com, for arm64 on cdimage; the newest 24.04 point release.
  site=$([ "$arch" = amd64 ] && echo https://releases.ubuntu.com/noble || echo https://cdimage.ubuntu.com/releases/noble/release)
  manifest=$(curl -fsSL "$site/" | grep -o "ubuntu-24\.04[.0-9]*-desktop-$arch\.manifest" | sort -uV | tail -1 || true)
  { [ -n "$manifest" ] && curl -fsSL "$site/$manifest" | cut -f1 | sed 's/:.*//' | sort -u; } > /tmp/p9-bare-desktop.txt || true
  echo "BARE_DESKTOP_MANIFEST $manifest ($(wc -l < /tmp/p9-bare-desktop.txt) packages)"
  as_p9 '$(ls ~/.local/share/p9/node-*/bin/node | head -1) node_modules/electron/install.js' || echo "BARE_ELECTRON_DOWNLOAD_FAILED"
  for round in 1 2 3 4 5 6; do
    libs=$(as_p9 'ldd node_modules/electron/dist/electron 2>/dev/null' | awk '/not found/ { print $1 }' | sort -u)
    [ -n "$libs" ] || { as_p9 'node_modules/electron/dist/electron --version 2>&1 | tail -1' | sed 's/^/BARE_ELECTRON_STARTS /'; break; }
    add=()
    for l in $libs; do p=$(apt_file "$l"); add+=("$p"); echo "BARE_DESKTOP_NEEDS $l $p $(grep -qx "$p" /tmp/p9-bare-desktop.txt && echo on-ubuntu-desktop || echo NOT-on-ubuntu-desktop)"; done
    docker exec "$NAME" bash -c "DEBIAN_FRONTEND=noninteractive apt-get install -y $(printf '%s ' "${add[@]}")" | tail -1
  done
  # Chromium's sandbox needs unprivileged user namespaces; Ubuntu 23.10 and newer refuse them to a program without an
  # AppArmor profile (a host setting, which a container shares).
  echo "BARE_USERNS_RESTRICTED $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
  # The packages discovery installed, against the same manifest.
  for p in "${needed[@]}"; do echo "BARE_NEEDED_ON_DESKTOP $p $(grep -qx "$p" /tmp/p9-bare-desktop.txt && echo on-ubuntu-desktop || echo NOT-on-ubuntu-desktop)"; done
  [ -n "${installed:-}" ] || exit 1
  ;;
tmux)
  out=$(realpath -m -- "${2:?output folder}"); mkdir -p -- "$out"
  curl -fsSLo "$out/tmux-$TMUX_VERSION.tar.gz" "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz"
  echo "$TMUX_SHA256  $out/tmux-$TMUX_VERSION.tar.gz" | sha256sum -c -
  docker run --rm -v "$out:/w" -w /w "$ALPINE" sh -euc "apk add --no-cache build-base libevent-dev libevent-static ncurses-dev ncurses-static bison pkgconf >/dev/null
    mkdir /b && tar -xzf tmux-$TMUX_VERSION.tar.gz -C /b && cd /b/tmux-$TMUX_VERSION && ./configure --enable-static --prefix=/usr >/dev/null && make -j4 >/dev/null
    strip tmux && cp tmux /w/tmux && chown $(id -u):$(id -g) /w/tmux && apk list --installed libevent-static ncurses-static musl > /w/tmux.versions"
  rm -f -- "$out/tmux-$TMUX_VERSION.tar.gz"
  # The test P9's terminals need: a session with a shell, a typed command and its output, on bare Ubuntu.
  docker run --rm -v "$out/tmux:/usr/local/bin/tmux:ro" -e TERM=xterm-256color "$UBUNTU" bash -euc 'tmux -V
    tmux -S /tmp/s new-session -d -x 80 -y 24 "bash --norc"; sleep 0.5; tmux -S /tmp/s send-keys "echo ok-\$((40+2))" Enter; sleep 0.5
    tmux -S /tmp/s capture-pane -p | grep -q ok-42 && echo BARE_TMUX_RUNS'
  (cd "$out" && sha256sum tmux | tee tmux.sha256 && file tmux && cat tmux.versions)
  ;;
*) echo "usage: bash scripts/bare-machine.sh boot | discover | tmux DIR"; exit 2 ;;
esac
