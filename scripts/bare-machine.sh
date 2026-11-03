#!/usr/bin/env bash
# Item 15 (v0.1.6 c13): what a bare Linux machine lacks for P9, found by installing on one. CI only (test.yaml, bare
# input) or by hand on a machine with Docker; never touches the P9 that runs here. Every step prints what it found.
#   bash scripts/bare-machine.sh boot       a privileged Ubuntu 24.04 container running systemd: user p9 (NOPASSWD sudo,
#                                           linger), git (the user cloned P9) and nothing P9 needs; this clone copied in
#   bash scripts/bare-machine.sh discover   install.sh --headless; each MISSING line's packages installed, then again
#   bash scripts/bare-machine.sh install headless|desktop   after boot: the fixed install.sh, its admin question answered yes
#   bash scripts/bare-machine.sh tmux DIR   static tmux from the pinned source on pinned Alpine, run on bare Ubuntu, into DIR
#   bash scripts/bare-machine.sh appimage FILE   what the AppImage's runtime needs to mount it on bare Ubuntu, round by round
set -euo pipefail
cd "$(dirname -- "$0")/.."
UBUNTU=ubuntu:24.04@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c
ALPINE=alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
TMUX_VERSION=3.8 TMUX_SHA256=e79c699c7e949dccd0a4a125e17b8d1261e311b16979dbc8eb34542f3966d82e
# What builds the static tmux and goes into it (threat model row 60), each pinned. Alpine's mirror keeps only the newest
# build of a package, so once Alpine updates one of these the build stops naming it: bump that pin on purpose, and the
# SHA-256 values in apps/server/deps.mjs if the binary changes.
ALPINE_PACKAGES="build-base=0.5-r3 gcc=14.2.0-r6 binutils=2.44-r3 musl-dev=1.2.5-r13 make=4.4.1-r3 libevent-dev=2.1.13-r0
 libevent-static=2.1.13-r0 ncurses-dev=6.5_p20250503-r0 ncurses-static=6.5_p20250503-r0 bison=3.8.2-r2 pkgconf=2.4.3-r0"
NAME=${BARE_NAME:-p9-bare}
# The Ubuntu package that holds a library, for this machine's architecture: apt-file in a throwaway container, so
# apt-file and perl never reach the bare machine. Where several packages hold it, the one Ubuntu Desktop ships (the
# arm64 run picked a Xilinx vendor package for libgbm.so.1 where the desktop has libgbm1).
apt_file() {
  docker image inspect p9-bare-apt-file >/dev/null 2>&1 \
    || printf 'FROM %s\nRUN apt-get update && apt-get install -y apt-file && apt-file update\n' "$UBUNTU" | docker build -q -t p9-bare-apt-file - >/dev/null
  local all ours
  all=$(docker run --rm p9-bare-apt-file apt-file search -l -x "^/(usr/)?lib/$(docker exec "$NAME" uname -m)-linux-gnu/$1\$")
  # No "| head -1" on a pipe here: under pipefail a writer cut off early exits 141 and set -e stops the script.
  ours=$(grep -xFf /tmp/p9-bare-desktop.txt <<< "$all" || true)
  ours=${ours:-$all}
  echo "${ours%%$'\n'*}"
}
# The newest Ubuntu Desktop 24.04 manifest for this machine's architecture, one package per line, into /tmp/p9-bare-desktop.txt:
# amd64 is on releases.ubuntu.com, arm64 on cdimage.
desktop_manifest() {
  arch=$(docker exec "$NAME" dpkg --print-architecture)
  site=$([ "$arch" = amd64 ] && echo https://releases.ubuntu.com/noble || echo https://cdimage.ubuntu.com/releases/noble/release)
  manifest=$(curl -fsSL "$site/" | grep -o "ubuntu-24\.04[.0-9]*-desktop-$arch\.manifest" | sort -uV | tail -1 || true)
  { [ -n "$manifest" ] && curl -fsSL "$site/$manifest" | cut -f1 | sed 's/:.*//' | sort -u; } > /tmp/p9-bare-desktop.txt || true
  echo "BARE_DESKTOP_MANIFEST $manifest ($(wc -l < /tmp/p9-bare-desktop.txt) packages)"
}
as_p9() { docker exec -u p9 -w /srv/p9/p9 -e XDG_RUNTIME_DIR=/run/user/1000 -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus "$NAME" bash -lc "$1"; }
# The daemon, as the desktop and the wizard see it.
daemon_check() {
  node='$(ls ~/.local/share/p9/node-*/bin/node | head -1)'
  as_p9 "$node --input-type=module -e \"import { daemonRequest } from './scripts/teh.mjs'; const s = process.env.XDG_RUNTIME_DIR + '/p9-foundation';
    for (const p of ['/health', '/setup']) { const r = await daemonRequest(s, 'GET', p).catch((e) => ({ status: 0, body: String(e) })); console.log('BARE_DAEMON', p, r.status, JSON.stringify(r.body)); }\"" || true
}
# The wizard's last steps, called as its buttons call them: Install for both agents (a launcher each in P9's bin folder),
# each launcher's --version, then Sign in until the CLI hands back its sign-in page. No account here, so it stops there
# (Stop, as Cancel does); only the page's address without its query is printed.
signin_check() {
  docker exec -i -u p9 -w /srv/p9/p9 -e XDG_RUNTIME_DIR=/run/user/1000 "$NAME" bash -lc '$(ls ~/.local/share/p9/node-*/bin/node | head -1) --input-type=module -' <<'EOF' || true
import { daemonRequest } from './scripts/teh.mjs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
const s = process.env.XDG_RUNTIME_DIR + '/p9-foundation';
const call = (method, route, body) => daemonRequest(s, method, route, body).catch((e) => ({ status: 0, body: String(e) }));
const installed = await call('POST', '/setup/agents', { claude: true, codex: true });
console.log('BARE_WIZARD_INSTALL', installed.status, JSON.stringify(installed.body));
for (const agent of ['claude', 'codex']) {
  let version;
  try { version = execFileSync(os.homedir() + '/.local/share/p9/bin/' + agent, ['--version'], { encoding: 'utf8', timeout: 60000 }).trim(); }
  catch (e) { version = 'FAILED ' + String(e.stderr || e.message).slice(0, 300); }
  console.log('BARE_WIZARD_CLI', agent, version);
  const started = await call('POST', '/setup/login', { agent });
  let state;
  for (let i = 0; i < 60 && started.status < 300; i++) {
    state = (await call('GET', '/setup/login')).body?.[agent];
    if (state?.url || state?.exit !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const page = state?.url ? new URL(state.url) : null;
  console.log('BARE_WIZARD_SIGNIN', agent, started.status, page ? 'page ' + page.origin + page.pathname : 'none ' + JSON.stringify(state ?? started.body));
  await call('POST', '/setup/login/stop', { agent });
}
EOF
}

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
  # The host's securityfs, as a real Ubuntu has it: without it apparmor_parser cannot load install.sh's rule (CI run
  # 40611561200: "unable to find a suitable fs"), and Electron's sandbox stays blocked. CI only, like install desktop:
  # it lets the container load profiles into the host's kernel.
  sec=(); [ "${GITHUB_ACTIONS:-}" = true ] && sec=(-v /sys/kernel/security:/sys/kernel/security)
  docker run -d --name "$NAME" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "${sec[@]}" p9-bare >/dev/null
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
  desktop_manifest
  for round in 1 2 3 4 5 6 7 8; do
    if as_p9 'bash scripts/install.sh --headless' > /tmp/p9-bare-install.log 2>&1; then status=0; else status=$?; fi
    cat /tmp/p9-bare-install.log
    [ "$status" = 0 ] && { echo "BARE_INSTALLED round $round"; installed=1; break; }
    line=$(grep -m1 '^MISSING' /tmp/p9-bare-install.log || true)
    lib=$(grep -m1 -o 'error while loading shared libraries: [^:]*' /tmp/p9-bare-install.log | sed 's/.*: //' || true)
    # Item 15's install.sh asks instead (no answer here, so it stops): its "- <id>: <why>" lines, as Ubuntu packages.
    asked=$(grep -oE '^- [a-z0-9]+:' /tmp/p9-bare-install.log | sed 's/^- //; s/:$//; s/^ssh$/openssh-client/' | grep -vx sandbox | tr '\n' ' ' || true)
    if [ -n "$line" ]; then
      tools=${line#*MISSING: }; tools=${tools%%.*}
      for t in $tools; do needed+=("${pkg[$t]:-$t}"); done
      echo "BARE_MISSING round $round: $tools"
    elif [ -n "${asked// /}" ]; then
      for p in $asked; do needed+=("$p"); done
      echo "BARE_MISSING round $round: $asked(asked by install.sh)"
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
  daemon_check
  as_p9 'journalctl --user -u p9-foundation --no-pager | tail -20' || true
  # The desktop install (no --headless) also runs Electron: its own download, then what it cannot load, round by round
  # (a library's own libraries show only once it is there), each with its package and whether Ubuntu Desktop has it.
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
install)
  # Step B: the fixed install.sh on a fresh bare machine, run the way a user runs it, answering yes to its admin
  # question (the question and its reasons are printed). Before it, only what the machine it stands for already has:
  # wget (Ubuntu Desktop and Server ship it; the container does not); desktop: also AppArmor and the libraries Electron
  # loads, every one on Ubuntu Desktop's manifest (discover).
  mode=${2:?headless or desktop}
  if [ "$mode" = desktop ]; then
    # The AppArmor rule install.sh adds goes into the kernel, which a container shares with its host: CI's throwaway runner only.
    [ "${GITHUB_ACTIONS:-}" = true ] || { echo "bare-machine.sh install desktop runs in CI only: it loads an AppArmor profile into this machine's kernel"; exit 2; }
    have="wget apparmor libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libgbm1 libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxkbcommon0 libxrandr2"
    flag=
  else have=wget flag=--headless; fi
  docker exec "$NAME" bash -c "DEBIAN_FRONTEND=noninteractive apt-get install -y $have" | tail -1
  if as_p9 "yes | bash scripts/install.sh $flag" > /tmp/p9-bare-install.log 2>&1; then status=0; else status=$?; fi
  cat /tmp/p9-bare-install.log
  echo "BARE_INSTALL_EXIT $status"
  grep -A8 '^P9 needs th' /tmp/p9-bare-install.log | sed 's/^/BARE_ASKED /' || true
  docker exec "$NAME" dpkg-query -W -f '${Package}\n' | sort | comm -13 /tmp/p9-bare-before.txt - | tr '\n' ' ' | sed 's/^/BARE_ADDED_PACKAGES /'; echo
  daemon_check
  signed=$(signin_check); echo "$signed"
  [ "$(grep -c '^BARE_WIZARD_SIGNIN .* page ' <<< "$signed")" = 2 ] || status=1
  if [ "$mode" = desktop ]; then
    echo "BARE_USERNS_RESTRICTED $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)"
    # With the rule loaded Electron prints its version; the SUID-sandbox FATAL means the rule did not take.
    started=$(as_p9 'node_modules/electron/dist/electron --version 2>&1 | tail -1' || true)
    echo "BARE_ELECTRON_STARTS $started"
    # Why, if it did not: the file the kernel runs, the attach line in the rule, and the kernel's loaded profiles.
    echo "BARE_ELECTRON_REAL $(as_p9 'readlink -f node_modules/electron/dist/electron' || true)"
    docker exec "$NAME" grep -h '^profile' /etc/apparmor.d/p9-electron | sed 's/^/BARE_RULE /' || true
    docker exec "$NAME" grep p9-electron /sys/kernel/security/apparmor/profiles | sed 's/^/BARE_KERNEL_PROFILE /' || true
    [[ "$started" =~ ^v[0-9] ]] || status=1
  fi
  [ "$status" = 0 ]
  ;;
tmux)
  out=$(realpath -m -- "${2:?output folder}"); mkdir -p -- "$out"
  curl -fsSLo "$out/tmux-$TMUX_VERSION.tar.gz" "https://github.com/tmux/tmux/releases/download/$TMUX_VERSION/tmux-$TMUX_VERSION.tar.gz"
  echo "$TMUX_SHA256  $out/tmux-$TMUX_VERSION.tar.gz" | sha256sum -c -
  docker run --rm -v "$out:/w" -w /w "$ALPINE" sh -euc "apk add --no-cache $(echo $ALPINE_PACKAGES) >/dev/null
    mkdir /b && tar -xzf tmux-$TMUX_VERSION.tar.gz -C /b && cd /b/tmux-$TMUX_VERSION && ./configure --enable-static --prefix=/usr >/dev/null && make -j4 >/dev/null
    strip tmux && cp tmux /w/tmux && apk info -v | sort > /w/tmux.versions && chown $(id -u):$(id -g) /w/tmux /w/tmux.versions"
  rm -f -- "$out/tmux-$TMUX_VERSION.tar.gz"
  # The test P9's terminals need: a session with a shell, a typed command and its output, on bare Ubuntu.
  docker run --rm -v "$out/tmux:/usr/local/bin/tmux:ro" -e TERM=xterm-256color "$UBUNTU" bash -euc 'tmux -V
    tmux -S /tmp/s new-session -d -x 80 -y 24 "bash --norc"; sleep 0.5; tmux -S /tmp/s send-keys "echo ok-\$((40+2))" Enter; sleep 0.5
    tmux -S /tmp/s capture-pane -p | grep -q ok-42 && echo BARE_TMUX_RUNS'
  (cd "$out" && sha256sum tmux | tee tmux.sha256 && file tmux && cat tmux.versions)
  ;;
appimage)
  # What an AppImage download needs before P9 can ask for anything: its runtime mounts the image with FUSE. A bare Ubuntu
  # 24.04 (privileged for /dev/fuse, which a desktop has), the default user mounting it as a user does: each round's
  # failure names a package, which is installed, then again. Each is checked against Ubuntu Desktop's manifest.
  image=$(realpath -- "${2:?AppImage file}"); NAME=$NAME-appimage
  [ -f "$image" ] || { echo "no AppImage at $image"; exit 2; } # docker -v would make a root-owned folder there
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --privileged -v "$image:/p9.AppImage:ro" "$UBUNTU" sleep infinity >/dev/null
  desktop_manifest
  docker exec "$NAME" apt-get update -q >/dev/null
  status=1
  for round in 1 2 3 4; do
    said=$(docker exec -u ubuntu "$NAME" sh -c '/p9.AppImage --appimage-mount > /tmp/mount.log 2>&1 & sleep 8
      grep -q " /tmp/.mount_" /proc/mounts && echo MOUNTED; head -c 600 /tmp/mount.log; kill $! 2>/dev/null; true')
    grep -q '^MOUNTED' <<< "$said" && { echo "BARE_APPIMAGE_MOUNTS round $round"; status=0; break; }
    sed 's/^/BARE_APPIMAGE_SAYS /' <<< "$said"
    if grep -q 'libfuse\.so\.2' <<< "$said"; then p=libfuse2t64
    elif grep -qi 'fusermount' <<< "$said"; then p=fuse3
    else echo "BARE_APPIMAGE_FAILED round $round (the cause is above)"; break; fi
    echo "BARE_APPIMAGE_NEEDS round $round: $p $(grep -qx "$p" /tmp/p9-bare-desktop.txt && echo on-ubuntu-desktop || echo NOT-on-ubuntu-desktop)"
    docker exec "$NAME" bash -c "DEBIAN_FRONTEND=noninteractive apt-get install -y $p" | tail -1
  done
  docker rm -f "$NAME" >/dev/null
  exit $status
  ;;
*) echo "usage: bash scripts/bare-machine.sh boot | discover | install headless|desktop | tmux DIR | appimage FILE"; exit 2 ;;
esac
