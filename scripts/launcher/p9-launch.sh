#!/bin/sh
# AU4: the p9-foundation unit runs this fixed copy in ~/.local/share/p9/launcher. It starts the daemon version that
# daemon/current names (teh.mjs stageDaemon copies each version to daemon/<version>), so an update or a rollback only
# rewrites current. The unit names the node and server it was installed with; current's replace them.
set -eu
base=$(dirname -- "$(dirname -- "$(readlink -f -- "$0")")")
version=$(cat -- "$base/daemon/current")
case $version in
  *[!0-9A-Za-z.-]* | *..* | '') echo "p9-launch: daemon/current is unreadable" >&2; exit 1 ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "p9-launch: daemon/current is unreadable" >&2; exit 1 ;;
esac
shift 2
exec "$base/daemon/$version/node" "$base/daemon/$version/apps/server/main.mjs" "$@"
