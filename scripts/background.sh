
# The body of ~/.local/share/p9/run/start (install.sh writes it after the lines that set r, node, checkout, workspace,
# recovery and PATH). Background mode, threat model row I1: on a machine where this user has no user service (linger
# refused, no systemd user session), P9's daemon runs as a plain background process of this user, as VS Code's server does.
#   sh start up       start the daemon unless one runs, then wait for it to answer (the desktop runs this at each connect)
#   sh start keep     turn on linger for this user's own account, then move P9 to its user service (Keep P9 running: Yes)
#   sh start keep admin   the same, with the admin password the person typed into the app as stdin's first line (row I2)
#   sh start deps [admin]  what deps.mjs says this machine lacks (tmux, ssh): its command, or with admin (the password as
#                     stdin's first line, as keep admin) that command run as admin (row 61 on a remote)
#   sh start release  P9's service off, and linger if P9 turned it on, then the background daemon (Keep P9 running: No)
# The file background marks background mode: remote.mjs READ runs "up" at each connect only while it is there.
# POSIX sh, as the desktop runs it with sh. It runs as this user only and never asks for a password; the functions of
# apps/desktop/tools.sh come before it in the start file.
set -eu
umask 077
# Only this user's own owner-only folder (row I1 (b)).
[ -d "$r" ] && [ -O "$r" ] && [ "$(stat -c %a "$r")" = 700 ] || { echo "P9_BACKGROUND unsafe-folder" >&2; exit 1; }
state="$r/p9-foundation" lock="$HOME/.local/state/p9-foundation/daemon.lock"
# A daemon holds this lock (apps/server/main.mjs) for exactly as long as it runs, the service's or this script's.
running() { [ -e "$lock" ] && ! flock -n "$lock" true; }

up() {
  running && return 0
  rm -f -- "$state/desktop.json" # left by a daemon that did not stop cleanly (a reboot); the desktop waits for the new one
  if [ -f "$r/daemon.log" ]; then tail -c 1048576 "$r/daemon.log" > "$r/daemon.log.new"; mv -f -- "$r/daemon.log.new" "$r/daemon.log"; fi
  cd "$HOME"
  # The service's ExecStart (install-service.mjs), plus the idle stop: 5 minutes after the last desktop, phone or turn.
  setsid "$node" "$checkout/apps/server/main.mjs" --workspace "$workspace" --state "$state" --recovery "$recovery" --idle-exit 300 \
    </dev/null >>"$r/daemon.log" 2>&1 &
  echo "$!" > "$r/daemon.pid"
  for _ in $(seq 60); do
    [ -e "$state/desktop.json" ] && return 0
    kill -0 "$!" 2>/dev/null || break
    sleep 0.5
  done
  echo "P9 did not start on this machine. The end of its log:" >&2
  tail -n 5 "$r/daemon.log" >&2
  return 1
}

unit="$HOME/.config/systemd/user/p9-foundation.service"
keep() {
  p9_pw=
  if [ "${1:-}" = admin ]; then IFS= read -r p9_pw || true; fi
  if [ ! -e "$r/background" ] && [ -e "$unit" ]; then echo "P9_KEEP ok"; return 0; fi
  # Linger for this user's own account: systemd's default (set-self-linger) needs no password; where a rule asks for
  # one, --no-ask-password fails at once and the app offers the admin password for this one command instead.
  if [ "$(loginctl show-user "$(id -u)" -p Linger --value 2>/dev/null)" != yes ]; then
    if loginctl --no-ask-password enable-linger 2>/dev/null; then :
    elif [ -n "$p9_pw" ]; then p9_admin "loginctl enable-linger $(id -un)" || { echo "P9_KEEP refused"; return 0; }
    else echo "P9_KEEP refused"; echo "P9_ADMIN command loginctl enable-linger $(id -un)"; return 0
    fi
    : > "$r/lingered"
  fi
  u="/run/user/$(id -u)"
  for _ in $(seq 20); do [ -d "$u" ] && break; sleep 0.5; done
  [ -d "$u" ] && [ -O "$u" ] || { echo "P9_KEEP no-runtime"; return 1; }
  # Only the daemon this script started: its pid file can be stale, so that process must still name this state folder.
  pid=$(cat "$r/daemon.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -qxF -- "$state"; then kill -TERM "$pid"; fi
  for _ in $(seq 30); do running || break; sleep 0.5; done
  if running; then echo "P9_KEEP busy"; return 1; fi
  cd "$checkout"
  if XDG_RUNTIME_DIR="$u" "$node" scripts/install-service.mjs "$workspace" >>"$r/daemon.log" 2>&1; then
    rm -f -- "$r/background" "$r/daemon.pid"
    echo "P9_KEEP ok"
  else
    echo "P9_KEEP failed"
    up
    return 1
  fi
}

release() {
  : > "$r/background"
  if [ -e "$unit" ]; then
    u="/run/user/$(id -u)"
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "$u" ] && [ -O "$u" ]; then export XDG_RUNTIME_DIR="$u"; fi
    systemctl --user disable --now p9-foundation.service >/dev/null 2>&1 || true
    rm -f -- "$unit"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  # Linger only if P9 turned it on: this user may want it for something else.
  if [ -e "$r/lingered" ]; then loginctl --no-ask-password disable-linger 2>/dev/null || true; rm -f -- "$r/lingered"; fi
  for _ in $(seq 30); do running || break; sleep 0.5; done
  up
  echo "P9_RELEASE ok"
}

# Row 61 on a remote: the command is this machine's own, computed here by deps.mjs and printed before it runs as admin.
deps() {
  p9_pw=
  if [ "${1:-}" = admin ]; then IFS= read -r p9_pw || true; fi
  c=$("$node" "$checkout/scripts/deps.mjs" --headless --command --root </dev/null) || { echo "P9_DEPS failed"; return 0; }
  if [ -z "$c" ]; then echo "P9_DEPS none"
  elif [ -z "$p9_pw" ]; then echo "P9_ADMIN command $c"
  else p9_admin "$c"; echo "P9_DEPS ok"
  fi
}

case "${1:-up}" in
  up) up ;;
  deps) deps "${2:-}" ;;
  keep) keep "${2:-}" ;;
  release) release ;;
  *) exit 2 ;;
esac
