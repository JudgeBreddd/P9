#!/bin/sh
# AU4: the p9-foundation unit runs this fixed copy in ~/.local/share/p9/launcher. It starts the daemon version that
# daemon/current names (teh.mjs stageDaemon copies each version to daemon/<version>), so an update or a rollback only
# rewrites current. The unit names the node and server it was installed with; current's replace them.
# AU5 (threat model row 40): --rollback <to> <from> <AppImage> <pid> is the app's, from a version that failed 2 starts
# (apps/desktop/rollback.mjs). It waits for that app to quit, copies the kept appimage/<to>.AppImage over the AppImage,
# sets daemon/current back, restarts the daemon, writes rollback.json and rollback.log beside this folder, and starts
# the AppImage again. An update writes its launcher as p9-launch.sh.next; the app renames it over this one after a
# healthy start, so the launcher that runs a rollback is always from a version that started.
set -eu
base=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")
version_ok() {
  case $1 in
    *[!0-9A-Za-z.-]* | *..* | '') return 1 ;;
    [0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "${1:-}" = --rollback ]; then
  [ $# -eq 5 ] || { echo "p9-launch: refused" >&2; exit 1; }
  to=$2 from=$3 image=$4 pid=$5
  say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$base/rollback.log"; }
  fail() { say "rollback failed: $*"; exit 1; }
  version_ok "$to" && version_ok "$from" && [ "$to" != "$from" ] || fail "refused: a version"
  case $image in /*.AppImage) ;; *) fail "refused: the AppImage" ;; esac
  [ -f "$image" ] || fail "refused: the AppImage"
  case $pid in '' | *[!0-9]* | 0) fail "refused: the process id" ;; esac
  kept="$base/appimage/$to.AppImage"
  [ -f "$kept" ] || fail "no kept AppImage for $to"
  say "P9 $from did not start twice; going back to $to"
  n=0
  while kill -0 "$pid" 2>/dev/null && [ $n -lt 60 ]; do sleep 1; n=$((n + 1)); done
  cp -- "$kept" "$image.p9-rollback" && chmod 755 "$image.p9-rollback" && mv -f -- "$image.p9-rollback" "$image" || fail "copying $kept"
  if [ -f "$base/daemon/$to/.complete" ]; then
    printf %s "$to" >"$base/daemon/current.tmp" && mv -f -- "$base/daemon/current.tmp" "$base/daemon/current"
    # Only a unit that runs this launcher (a source checkout's is left alone, as teh.mjs appImageService does).
    if grep -qF -- "$base/launcher/p9-launch.sh" "$HOME/.config/systemd/user/p9-foundation.service" 2>/dev/null; then
      systemctl --user restart p9-foundation.service || say "the daemon did not restart"
    fi
  fi
  printf '{"from":"%s","to":"%s","at":"%s","installer":"kept"}\n' "$from" "$to" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$base/rollback.json"
  say "P9 $to is back at $image; starting it"
  cd /
  env -u APPDIR -u APPIMAGE -u ARGV0 -u OWD setsid "$image" >/dev/null 2>&1 </dev/null &
  exit 0
fi

version=$(cat -- "$base/daemon/current")
version_ok "$version" || { echo "p9-launch: daemon/current is unreadable" >&2; exit 1; }
shift 2
exec "$base/daemon/$version/node" "$base/daemon/$version/apps/server/main.mjs" "$@"
