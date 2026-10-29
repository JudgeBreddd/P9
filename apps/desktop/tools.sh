# What P9's install needs from the system before Node exists, and the admin step for it (threat model row I2). POSIX sh:
# install.sh sources it, the desktop's remote install script runs it before it unpacks anything (tar and gzip come first),
# and ~/.local/share/p9/run/start carries it for Keep it running. It sits in apps/desktop because a packaged app ships that.

# p9_tools: sets P9_TOOLS_NEED (one "name: reason" line per missing tool) and P9_TOOLS_PACKAGES (" pkg pkg").
p9_tools() {
  P9_TOOLS_NEED= P9_TOOLS_PACKAGES=
  for p9_t in git systemctl systemd-run sha256sum tar gzip flock setsid curl; do
    case $p9_t in
      curl) { command -v curl || command -v wget; } >/dev/null 2>&1 && continue ;; # Ubuntu Desktop has wget and not curl
      *) command -v "$p9_t" >/dev/null 2>&1 && continue ;;
    esac
    case $p9_t in
      git) p9_p=git p9_w="P9's source and its updates come with git." ;;
      systemctl | systemd-run) p9_p=systemd p9_w="P9 runs as this user's service, and runs each agent command inside its own limits." ;;
      sha256sum) p9_p=coreutils p9_w="P9 checks each download against its pinned checksum." ;;
      tar | gzip) p9_p=$p9_t p9_w="P9's source and Node arrive as a compressed archive." ;;
      flock | setsid) p9_p=util-linux p9_w="P9 starts its background process with it, and checks whether one runs." ;;
      curl) p9_p=curl p9_w="P9 downloads Node with it." ;;
    esac
    P9_TOOLS_NEED="$P9_TOOLS_NEED$p9_t: $p9_w
"
    case " $P9_TOOLS_PACKAGES " in *" $p9_p "*) ;; *) P9_TOOLS_PACKAGES="$P9_TOOLS_PACKAGES $p9_p" ;; esac
  done
}

# p9_install_command " pkg pkg": the package manager's command, with no sudo in it (p9_admin runs it as admin). Empty when
# this machine has none P9 knows.
p9_install_command() {
  if command -v apt-get >/dev/null 2>&1; then echo "apt-get update; apt-get install -y$1"
  elif command -v dnf >/dev/null 2>&1; then echo "dnf install -y$1"
  elif command -v zypper >/dev/null 2>&1; then echo "zypper install -y$1"
  fi
}

# The admin password the person typed into the app: read from stdin (IFS= read -r p9_pw, the first line), never an
# argument or the environment. printf is a shell builtin, so the password is in no process's command line; sudo prints
# no prompt (-p ''), and nothing here prints it. Checked once: P9_ADMIN wrong-password (exit 6) or not-allowed (exit 7).
p9_sudo_check() {
  [ -z "${p9_sudo_ok:-}" ] || return 0
  command -v sudo >/dev/null 2>&1 || { echo "P9_ADMIN not-allowed"; exit 7; }
  if p9_e=$(printf '%s\n' "$p9_pw" | LC_ALL=C sudo -S -k -p '' -v 2>&1); then p9_sudo_ok=1; return 0; fi
  case $p9_e in *sudoers* | *"may not run sudo"* | *"not allowed to"*) echo "P9_ADMIN not-allowed"; exit 7 ;; esac
  echo "P9_ADMIN wrong-password"; exit 6
}
# p9_admin COMMAND: runs COMMAND as admin, the same string the app showed (it has no sudo in it), after printing it. COMMAND
# is its own argument to sh, and its stdin is closed, so the password line sudo reads never reaches the command.
p9_admin() {
  p9_sudo_check
  echo "P9_ADMIN running $1"
  printf '%s\n' "$p9_pw" | sudo -S -p '' -- sh -c 'exec </dev/null; eval "$1"' p9-admin "$1"
}
