# P9 — Event Horizon

A desktop app that runs your Claude and Codex agents, an editor and your own scripts in one window, on your
own machine, and keeps the agents working after you close it.

![P9 — Event Horizon](docs/brand/hero-1536x1024.jpg)

One workspace. Every agent. Your focus.

## Why it's worth it

- **Your agents keep working when you close the window, and your phone can follow them.** A small daemon
  runs as your own user (a systemd user service on Linux, a Scheduled Task on Windows) and owns the chats
  and tmux terminals; the window is only a view onto it. The optional phone view goes over Tailscale and
  joins only after you approve a 6-digit code on the computer.
- **Claude and Codex side by side, with your existing logins.** P9 starts each provider's Agent Client
  Protocol adapter and shows its approvals, models and Stop in one chat UI. It never stores your provider login.
- **Move work to your own server without losing the chat.** Send to server copies a chat, between turns,
  over your own ssh, and Send files copies the project folder the same way, asking before it replaces
  anything. From 0.1.6 on, connecting from a newer P9 updates the server's P9; a server still on 0.1.5
  needs one update by hand (see Update).
- **See what an agent makes, not just a description of it.** A fenced block the agent marks as an
  artifact (HTML, SVG, Mermaid, React, Markdown or code) opens in a sealed frame beside the chat with no
  network access; you comment on it and the comments go back as one message.
- **No save silently overwrites a change on disk, and you choose the limits.** Every save carries the
  hash of the text it started from; if the file changed since, P9 refuses and keeps your text as a recovery
  draft. Settings has one switch each for the agent lock, File protection and the Full access warnings.

## Is it for you?

**It fits when** you run Claude Code and/or Codex most of the day on a Linux desktop (or Windows), want
long agent runs to survive a closed window, and like one place for chats, an editor and your own scripts.

**Skip it when** you are on macOS (not supported in v1), want a hosted or team tool (P9 is one user on one
machine), need a sandbox for your agents (the workspace bounds P9's own file routes only; agents, terminals
and buttons run as you), or need a signed, audited installer (v1 is an unsigned beta for testers).

**You need:** Linux with a graphical session and systemd user services (or Windows, per-user install, no
admin), and a Claude and/or Codex account. P9 ships both CLIs and its setup wizard signs you in. Full
list, including what the install script asks your package manager for: [Requirements](#requirements).

**Real cost:** P9 itself is free under PolyForm Shield (see [Licenses](#licenses)); you pay for your own
Claude or Codex plan. Linux installs from source (`pnpm install` and `pnpm build`, Node 26.10.0 fetched if
missing); install time was not measured. Server mode, Send to server and Send files need a second machine
you can reach with `ssh` without a password prompt, with P9 running on it.

## Install

The repository is public: downloading and updating need no GitHub account.

**Windows**

1. Open [the releases page](https://github.com/JudgeBreddd/p9/releases) and download
   `p9-event-horizon-<version>-windows-x64.exe` from the newest release, or `...-windows-arm64.exe` on an ARM
   laptop (Snapdragon; Settings > System > About says "ARM-based processor").
2. Double-click it. The installer is unsigned, so SmartScreen says "Windows protected your PC": click
   **More info**, then **Run anyway**, and click through the installer. Checking the download first is
   recommended (next section).
3. Open P9 from the Start menu. Details: [Install on Windows](#install-on-windows). From then on it updates
   itself: [Update, roll back, uninstall](#update-roll-back-uninstall).

**Linux AppImage** (x64)

Install `tmux` and `libfuse2t64` (an AppImage mounts itself with FUSE, and Ubuntu Desktop 24.04 does not
ship that library): `sudo apt install tmux libfuse2t64`. Download
`p9-event-horizon-<version>-linux-x64.AppImage` from the same page, then `chmod +x` it and run it. On its
first start it copies its daemon to `~/.local/share/p9/daemon`, installs the Dev Focus editor server it
carries into `~/.local/share/p9/codium-server` (checked against a pinned SHA-256), and installs the
`p9-foundation` user service with `~/P9` as the workspace; without tmux it installs nothing and says
`tmux-required`. If it already finds a `p9-foundation` service from a source install, it leaves that alone. On
Ubuntu 23.10 and newer, AppArmor can stop an AppImage's sandbox from starting: allow it with an AppArmor
profile for the file, never with `--no-sandbox`. Like the Windows app, it updates itself.

**Linux**

Install the GitHub CLI (`gh`): for example `sudo apt install gh`, `sudo dnf install gh` or
`sudo pacman -S github-cli`. Then paste:

```sh
gh auth status >/dev/null 2>&1 || gh auth login -h github.com -p https --web && gh auth setup-git && gh repo clone JudgeBreddd/p9 ~/p9 && bash ~/p9/scripts/install.sh
```

It signs you in to GitHub if needed, clones P9 to `~/p9`, checks the other tools, builds, installs the Dev
Focus editor server, starts the daemon and prints the command that opens P9. Without Node 26.10.0 it
downloads P9's own copy from nodejs.org into `~/.local/share/p9` (checked against a pinned SHA-256; your
system Node is left alone) and prints the PATH line to add to `~/.bashrc`. Without `tmux` it downloads
P9's pinned static tmux 3.8 into P9's own folder (SHA-256 checked, no admin password) and asks your package
manager for it only if that fails. For what only your package manager can supply (`curl`, `libatomic1`, the
AppArmor rule for P9's window) it shows the reason first, then the command, then asks y/N; it never runs
`sudo` unasked. If the clone worked but a later step failed, fix what it printed and run
`bash ~/p9/scripts/install.sh`. P9's workspace is `~/work`; for another folder, run
`bash ~/p9/scripts/install.sh <folder>` instead of the last part. Step by step:
[Install on Linux](#install-on-linux-per-user-from-source).

**When it worked:** the Linux script ends with `Open P9:` and the command to paste; the window opens on your
workspace. If something looks wrong, `pnpm teh doctor --state "$XDG_RUNTIME_DIR/p9-foundation"` exits 0 when
the daemon answers ([Check the daemon](#install-on-linux-per-user-from-source)).

## What you get / how it works

One window, three focus modes:

- **Chat Focus**: Claude and Codex chats over the Agent Client Protocol, with approvals, history and Stop.
- **Dev Focus**: a VS Code–style editor (VSCodium's remote server) whose saves go through P9's guarded save.
- **Mission Control**: your scripts as buttons, your apps and pages, and a "waiting on you" queue.

```text
window (Electron) ──┐                       ┌─ agent chats (Claude / Codex ACP adapters)
                    ├─ Unix socket ─ daemon ┼─ P9 tmux terminals
phone (optional) ───┘  (Tailscale +         ├─ Mission Control button runs
                        passkey)            └─ guarded saves into your workspace
```

A small daemon runs as your own user and owns the work: closing the window leaves chats and P9 terminals
running. An optional phone view reaches the same daemon through Tailscale, signed in with a passkey.
Read [SECURITY.md](SECURITY.md) before you use it: it says what P9 protects and what it does not.
What each part of the app does is in [docs/guide.md](docs/guide.md).

## Windows installer: unsigned in v1, check the checksum

v1 packages are **not code-signed**, and Windows SmartScreen will warn. Every release lists a `SHA256SUMS-x64`
and a `SHA256SUMS-arm64` file beside the installers. Check it before you run anything. What it proves: the file you have is the
file that was uploaded, not damaged or swapped in transit. What it does not prove: who built it. The
checksum is downloaded from the same place as the installer, so anyone able to replace one can replace
both. v1 has no signed releases, so nothing here proves authorship. Building from source lets you read
what you run: clone, check out a commit you have reviewed (`git checkout <commit>`), then build.

```sh
sha256sum -c SHA256SUMS-x64 --ignore-missing      # Linux / Git Bash (SHA256SUMS-arm64 for the ARM64 one)
```

```powershell
(Get-FileHash .\p9-event-horizon-<version>-windows-x64.exe -Algorithm SHA256).Hash   # compare with SHA256SUMS-x64
```

A mismatch means do not run it.

## Requirements

- **Linux** (v1 is built and tested on Arch-based CachyOS) with a graphical session, systemd user services,
  `tmux` (P9 downloads its own pinned build if none is found), util-linux `flock`, and Chromium sandbox
  support (user namespaces). The AppImage also needs `libfuse2t64`.
- **git**, **Node 26.10.0** and **pnpm 10.34.6** (the install steps add pnpm with npm; Node 25 and later no
  longer ship corepack).
- For chat: a Claude and/or Codex account. P9 ships both CLIs and puts a launcher for each in its own
  `bin` folder (no download, no admin password); the setup wizard's *Claude, Codex or both?* step installs
  the ones you pick, and its next step signs you in. P9 starts their ACP adapters; it never stores your
  provider login.
- For Dev Focus: VSCodium's remote server, release 1.121.03429 exactly. P9 refuses any other build (it
  checks the commit in its `product.json`). `scripts/install.sh` installs it, the AppImage carries it, and
  when it is missing Dev Focus says so and offers an **Install the editor server** button. Without it the
  other focus modes still work. To install it by hand:

  ```sh
  curl -fLO https://github.com/VSCodium/vscodium/releases/download/1.121.03429/vscodium-reh-linux-x64-1.121.03429.tar.gz
  echo "9b27e6957f7cca9b52686eb9866db131e75d37d180ea5ba0f6cdf44b799f75d9  vscodium-reh-linux-x64-1.121.03429.tar.gz" | sha256sum -c
  mkdir -p ~/.local/share/p9/codium-server
  tar -xzf vscodium-reh-linux-x64-1.121.03429.tar.gz -C ~/.local/share/p9/codium-server
  ```

  `~/.local/share/p9/codium-server/bin/codium-server` must exist afterwards. `P9_EDITOR_HOST` points P9 at a
  different folder.
- For Server mode, Send to server and Send files: an `ssh` client, a `Host` entry for the server in
  `~/.ssh/config`, and P9 running on the server. The install script asks for the ssh client only if it is
  missing.
- Optional, per feature: `konsole` for registry buttons marked `"terminal": true`, `xdg-open` for apps and
  pages that open a URL, and VS Code at `/usr/bin/code` for "Open in VS Code". Everything else works
  without them.
- Windows: per-user installer only, no admin. Linux is the main platform in v1; see `SECURITY.md` for
  the Windows differences.

## Install on Linux (per user, from source)

Check the tools first. Every line should print a path; install whatever is missing with your package
manager (Node 26.10.0 from nodejs.org or your version manager; npm ships with Node):

```sh
node --version   # must print v26.10.0
for t in git npm tmux systemctl systemd-run curl sha256sum tar; do command -v $t || echo "MISSING $t"; done
echo "${XDG_RUNTIME_DIR:?not set: log in to a normal desktop or ssh session}"
```

Then install (`scripts/install.sh` runs these same steps). Replace `~/work` with the folder you want P9 to
manage (it is created if missing):

```sh
git clone https://github.com/JudgeBreddd/p9.git ~/p9 && cd ~/p9
command -v pnpm || npm install -g pnpm@10.34.6
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/work
node scripts/install-service.mjs "$HOME/work"
```

If `npm install -g` fails with `EACCES` (a system Node installs to `/usr`), run
`npm install -g pnpm@10.34.6 --prefix ~/.local` instead; `~/.local/bin` must be on your `PATH`.

`pnpm build` builds the window and Dev Focus. The last step writes `~/.config/systemd/user/p9-foundation.service`
and starts it now and at every login, then waits up to 15 s for the daemon to answer. It prints
`P9_SERVICE_INSTALLED` only when it does. It refuses to overwrite a unit that already exists; if the
daemon fails to start or answer, the installer removes the unit again, so you can fix the cause and
rerun it. The unit records the path of the Node that ran the installer: after changing or removing that
Node, uninstall and install again.

**The workspace is not a sandbox.** It bounds P9's own file routes (open, save, the Mission Control
folders). Terminals, agents, editor extensions and registry buttons run as you and can reach anything
your account can.

**The clone is the installed app.** The service runs the daemon straight from this folder, so keep it
where it is. Moving or deleting it stops P9; to move it, uninstall, move, and install again.

Open the app:

```sh
pnpm desktop --state "$XDG_RUNTIME_DIR/p9-foundation"
```

Without `--state` the window opens an offline preview with sample data, which is useful for looking around
and nothing else.

Check the daemon:

```sh
systemctl --user status p9-foundation
pnpm teh doctor --state "$XDG_RUNTIME_DIR/p9-foundation"
```

`teh doctor` exits 0 when the daemon answers. It prints a redacted bundle (no file contents, keys or
paths) that you can attach to a bug report.

### Mission Control settings

Mission Control reads `~/.config/p9/settings.json`, with workspace-relative paths to your main project
file (`primary`), the button registry (`registry`) and the waiting-on-you folder (`waiting`). It is read
when the daemon starts. A minimal setup, with the workspace at `~/work` as above (bash):

```bash
mkdir -p ~/.config/p9 ~/work/waiting && touch ~/work/README.md
cat > ~/.config/p9/settings.json <<'EOF'
{ "primary": "README.md", "registry": "p9-registry.json", "waiting": "waiting" }
EOF
cat > ~/work/p9-registry.json <<'EOF'
{
  "scripts": [{ "id": "disk", "title": "Disk use", "cmd": ["df", "-h"] }],
  "apps": [{ "id": "files", "title": "Files", "cmd": ["xdg-open", "."] }],
  "pages": [{ "id": "docs", "title": "Docs", "url": "https://github.com/JudgeBreddd/p9" }]
}
EOF
systemctl --user restart p9-foundation
```

Each `cmd` is an argv list run without a shell. **The registry is executable configuration:** clicking a
button runs that command as you. Read it before you use it. P9's own routes never write it, but any
program running as your user (an agent, a terminal, an extension) can edit the file, so treat changes to
it like changes to a script. Optional `scripts_root` (absolute) is where button
scripts run from; it defaults to the workspace and may point outside it. Settings, registry and space
changes show in Mission within one refresh, with no restart. Optional `page_schemes` (a list such as
`["obsidian", "ms-settings"]`) lets registry pages use those link types; P9 shows the full link and asks first,
and `javascript:`, `file:` and `data:` are never allowed. Button arguments may be any text except control
characters; for batch (.cmd/.bat) and ssh targets only, shell characters are refused and the message names
the character. An argument entry with `choices: [...]` shows a dropdown and the server accepts only those
values; `choices: "plans"` fills the dropdown with every `plan.md` under the scripts root (re-read at most once a
minute). A button run is bounded: at most
4 at once, 1 MiB of output kept, 15 minutes, and it is tracked in memory only (a daemon restart or update stops
it; after a crash the next start does). Without the file, Mission Control says
`settings-missing` and the other focus modes work normally. The setup wizard's Mission step can write it: in a
folder that already has files it pre-fills the paths it finds (a workspace-hub with its registry, a root
`AGENTS.md`, a `needs-you` or `waiting` folder), lets you change them, lists exactly what it will create, and
creates only the settings file plus whatever is missing; only an empty folder gets the whole starter set. P9 never writes the registry.

Optional keys, each off when left out:

- `space`: a workspace-relative JSON file of your own Mission sections, each a `title` with optional `text`,
  `buttons` (registry script records, run the same way) and `logs` (`id`, `title`, workspace-relative `path`;
  shows the end of that file). P9 never saves it.
- `hub`: the workspace-relative folder of a workspace-hub checkout. Turns on the hub sections (notifications,
  Wiki inbox, weekly audit, logs, incidents, work in flight, last solo run); they expect the ICM workspace
  layout the hub was built for. The Wiki inbox also needs `MC_VAULT` set to your vault in the service's
  environment. Left out, those sections say how to turn them on; on Windows, or with no heartbeats folder, the
  scheduled-job notices say the jobs are not checked instead of reporting them missing.
- `server_host`: an ssh host name whose logs and incidents the hub sections also list, over
  `ssh -o BatchMode=yes` (a key login must already work). No default, so nothing is ever ssh'd unasked.

## Install on Windows

Run `p9-event-horizon-<version>-windows-x64.exe` (download and SmartScreen steps in [Install](#install); check
its checksum first, above). It installs for your
user only and registers a per-user Scheduled Task, `P9 Foundation`, for the daemon; it runs on battery too.
On the first install its workspace is a new, empty `%USERPROFILE%\P9`, and an update keeps the folder the task
already has. To use another folder, run `resources\daemon\scripts\install-windows.ps1 -Workspace
<folder>` from the install folder in PowerShell (it replaces the task). Without `%APPDATA%\P9\settings.json` the daemon still starts and Mission Control says
`settings-missing`. The task runs a small launcher from `%LOCALAPPDATA%\P9\launcher`, which starts the daemon
copy in `%LOCALAPPDATA%\P9\daemon\<version>` (the newest two are kept). Uninstalling stops and removes the task,
the launcher and those copies; the rest of your state in `%LOCALAPPDATA%\P9` stays. Building the installer needs Windows:
`pnpm package:win` there writes the installer for that machine's architecture and its `SHA256SUMS-<arch>` to
`dist/windows/`.

## Everyday use

- **Persistent by default.** Closing the window, or quitting the UI, keeps agent sessions and P9 tmux
  terminals running. Session controls (the red button) switch to "dies with the app" or run **Stop All**,
  which blocks new starts, then stops and verifies every agent chat, every registry script and every P9
  tmux terminal. It does not stop: the Dev Focus editor (it ends when the window closes), apps and pages
  you launched, and registry buttons marked `"terminal": true` (they open their own Konsole window).
- **What stops what:**

  | Event | Agent chats | P9 terminals | Button runs | Dev Focus editor |
  |---|---|---|---|---|
  | Close the window | keep running | keep running | keep running | stops |
  | Stop on one chat | that chat stops | — | — | — |
  | Stop All | stop | stop | stop | keeps running |
  | Daemon restart or crash | the turn in progress is cut off; reopen to resume | keep running, reattached | stop (after a crash, at the next start) | keeps running |
  | Logout (no linger) or reboot | stop; resumable | stop | stop | stops |
  | Uninstall | Stop All first | Stop All first | Stop All first | stops with the window |

  A turn in progress when a chat stops is cut off; the reply so far stays in the history.
- **Dies with the app is best effort.** On quit, P9 asks the daemon to run Stop All and then quits. If the
  daemon is not answering or a stop fails, work can remain; run Stop All again, or check with
  `systemctl --user list-units 'p9-*'`.
- **Guarded save.** Every save carries the hash of the text it started from. If the file changed on disk
  since then, P9 refuses to overwrite it, shows the conflict, and keeps your text as a recovery draft
  under `~/.local/state/p9-foundation/conflicts/`. v1 has no screen for drafts. Each is a
  `.p9-conflict-<id>` JSON file; to see the file it belongs to and get your text back:

  ```sh
  cd ~/.local/state/p9-foundation/conflicts && ls -a
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));console.error(d.path);process.stdout.write(d.content)' .p9-conflict-<id> > recovered.txt
  ```

  Delete a draft once you have what you need.
- **Artifacts.** When an agent answers with a fenced block whose first line reads
  `<type> artifact [panel|pinned|full] [title]` (`type` is `markdown`, `html`, `svg`, `mermaid`, `code` or
  `react`), the chat shows a chip and the newest artifact of a finished turn opens beside the chat (on the
  phone, only when you tap the chip). It runs in a frame with no network, no access to your files and none
  to P9 itself. Select text and press *Add comment*, collect several, and *Send N comments* sends them back
  as one message that quotes each. Details: [docs/guide.md](docs/guide.md#artifacts).
- **A second machine.** Settings > Server makes this window work on a server's P9 over an ssh tunnel (the
  way VS Code Remote-SSH works), Dev Focus included. In Chat Focus, *Send to server* copies one Claude or
  Codex chat to that server between turns and marks the local copy as moved, so the two never both run.
  *Send files to server* (the files panel) copies a folder to the same folder on the server, shows what
  differs, asks before it replaces or deletes anything and keeps every replaced file in P9's recovery
  folder. Limits are under Settings > Send files. When you connect to a server running 0.1.6 or later with an
  older P9, this one builds and installs itself there after chats finish their turn. A failed build leaves the
  server as it was; a new build that does not start is put back. A server still on 0.1.5 has no update
  route, so it needs one update by hand first (see Update).
  Details: [docs/guide.md](docs/guide.md#server-mode-send-to-server-and-send-files).
- **Dev Focus limits.** Saves go through the guarded save, and only Ctrl+S or Save writes (a white dot on the
  tab marks an unsaved file). New File creates a file and never replaces one;
  creating folders, renaming and deleting from the editor's explorer is refused in v1. Do those in a
  terminal, where P9's guards do not apply.
  The editor server starts with VSCodium's server licence accepted for you
  (`--accept-server-license-terms`); its licence is in the download's `LICENSE.txt`.
- **Anymouse** (top bar): send an idea, a bug or a gripe. With no token configured it opens GitHub's
  new-issue page for this repo in your browser, prefilled, so you file it under your own login. To file
  notes straight from the app, give the daemon a fine-grained GitHub token with Issues read/write on this
  repo only, through a systemd drop-in that only you can read (bash):

  ```bash
  mkdir -p ~/.config/systemd/user/p9-foundation.service.d
  umask 077; read -rsp 'GitHub token (hidden): ' TOKEN; echo
  printf 'P9_GITHUB_TOKEN=%s\n' "$TOKEN" > ~/.config/systemd/user/p9-foundation.service.d/anymouse.env; unset TOKEN
  printf '[Service]\nEnvironmentFile=%%h/.config/systemd/user/p9-foundation.service.d/anymouse.env\n' \
    > ~/.config/systemd/user/p9-foundation.service.d/anymouse.conf
  systemctl --user daemon-reload && systemctl --user restart p9-foundation
  ```

  The token stays in that file in plain text, readable only by you. The daemon reads it once at start and
  removes it from its environment, so agents and terminals do not inherit it by accident. It does not stop
  a program running as you from reading the file, so give the token Issues access on this one repo and
  nothing else. What is sent: your note, its kind (as the issue label) and the name of the focus mode you
  were in, as an issue on `JudgeBreddd/p9`, visible to everyone who can see that repo. Without a token the
  whole note goes into the new-issue URL, so it also lands in your browser history. Never paste secrets
  into a note. Notes are capped at 50,000 characters (the box shows a live count and keeps your text if you go over) and 10 per 10 minutes. Without a token, GitHub's link limit cuts the prefilled text at 7,000 characters and the box says so.
  To remove the token: delete both `anymouse.*` files in that folder, then run
  `systemctl --user daemon-reload && systemctl --user restart p9-foundation`.
- **Security settings.** Settings > Security settings, on the computer and on an enrolled phone, has four
  switches: **Agent lock** (agents can read and answer but cannot edit files or run anything that asks
  permission; off by default), **File protection** (the editor cannot open or change secrets, `.env` files,
  `_private`, `.git` or P9's own files; on by default), **Warn before Full access and Bypass permissions**
  (on by default) and **Unrestricted mode** (all of them off at once, and new chats start in Codex Full
  access and Claude Bypass permissions). Turning File protection off, or Unrestricted mode on, asks first.
  The lock and File protection belong to the daemon, so one setting covers the computer and every phone.
  Unrestricted mode on a phone changes the daemon's two switches and that phone's new chats, not the
  computer's new chats.
- **Phone** (optional, needs Tailscale on both devices). **An enrolled phone can do what you can do in
  P9:** read and save workspace files, run chats, terminals and registry buttons, and turn the agent lock
  and File protection on or off. Approve only your own devices; to cut off a lost phone, revoke it from the
  computer (below). The phone has Chats (the same composer, modes, models, photos and one-tap send as the
  desktop), Terminal (with a Paste key that reads the clipboard only when you tap it), Mission, Usage,
  Files and Settings. Its sign-in lasts up to 12 hours, and a message you were typing survives a sign-in. Anyone on your tailnet can open the enrollment page and use up its rate limit, though only you
  can approve.
  1. Add the two remote flags with `systemctl --user edit p9-foundation`: an empty `ExecStart=` line, then
     the unit's own `ExecStart=` line (see `systemctl --user cat p9-foundation`) with
     `--remote-port 8743 --remote-origin https://<machine>.<tailnet>.ts.net` added. Then
     `systemctl --user restart p9-foundation`.
  2. `tailscale serve --bg 8743` puts that loopback port on your tailnet over HTTPS.
  3. Open `https://<machine>.<tailnet>.ts.net/` on the phone and ask to enroll. It shows a 6-digit code.
  4. On the computer, list the request and its code:

     ```sh
     pnpm teh devices --state "$XDG_RUNTIME_DIR/p9-foundation"
     ```

     If the codes match, approve it; if not, refuse it:

     ```sh
     pnpm teh devices approve <enrollment id> --state "$XDG_RUNTIME_DIR/p9-foundation"
     pnpm teh devices refuse <enrollment id> --state "$XDG_RUNTIME_DIR/p9-foundation"
     ```

  5. The phone creates its passkey. To take access away: `pnpm teh devices lock <device id> --state ...`
     (a sign-out: the phone can log in again with its own passkey, no approval needed), `revoke <device id>`
     (gone for good; use this to keep a lost phone out) or `reset`
     (every device), each with the same `--state` as above. The list also shows the last 50 auth events.
  6. To turn phone access off: `tailscale serve --https=443 off`, then `systemctl --user revert p9-foundation`
     (removes the edit from step 1; it also removes the Anymouse drop-in, so add that back if you use it)
     and `systemctl --user restart p9-foundation`.
     Every limit is in `SECURITY.md` under "Phase 10 remote access".

## Update, roll back, uninstall

- **Installed app (Windows, AppImage):** it checks P9's GitHub releases shortly after it starts and every 4
  hours, takes only releases that are not pre-releases, downloads a newer one in the background and installs it
  when you quit, or at once from Settings > Maintenance > Updates. Installing restarts the daemon on the new
  version, which ends a chat turn in progress (reopen it to resume). What it downloads and how that is checked:
  `SECURITY.md` § Auto-update. Remove the AppImage's service with
  `node ~/.local/share/p9/daemon/<version>/scripts/uninstall-service.mjs`, then delete the AppImage.

- **A server running P9** is updated from the computer you connect from once it runs 0.1.6: when this P9 is
  newer (compared by version number), it sends its source, builds beside the running copy, waits until no chat
  is mid-turn, swaps and restarts. A failed build leaves the running copy as it was; a restart that does not
  answer puts the previous copy back. A server still on 0.1.5 has no update route and does not update itself:
  update it once as a source checkout (the steps below: git pull, build, restart), then run
  `bash scripts/install.sh` there. `install.sh` alone does not pull. From a source checkout, the update sends
  its last commit (uncommitted work is not sent); the installed app asks the server to fetch this version's
  source from GitHub. The old copy stays on the server as `source.previous`.

A source checkout never updates itself:

- **Update:** `git pull && pnpm install --frozen-lockfile && pnpm build`, then
  `systemctl --user restart p9-foundation`. Before a new build changes the state database, it copies
  the old one to `p9.db.v<N>.bak` beside it. A migration that dies halfway is undone on the next start.
- **Roll back:** stop the daemon, check out the older version, then run
  `node scripts/rollback.mjs` to restore the newest backup (the current file is kept beside it). Phones log in
  again afterwards, and a phone you revoked stays revoked. If the checked-out build already opens the current
  file, it says `state-current` and changes nothing. Then run
  `pnpm install --frozen-lockfile && pnpm build`, `systemctl --user start p9-foundation` and
  `pnpm teh doctor --state "$XDG_RUNTIME_DIR/p9-foundation"`. A build older than the state file refuses to
  open it, rather than damaging it.
- **Remove the service:** `node scripts/uninstall-service.mjs` runs Stop All (agent chats, registry scripts
  and P9 tmux terminals), then removes the `p9-foundation` unit and its drop-ins. If the daemon is not
  answering it says so and exits 1; check for leftovers with `systemctl --user list-units 'p9-*'`.
- **Remove everything:** remove the service, turn phone access off (above), then delete the clone
  (`~/p9`) and each folder in the table below that you no longer want.

| Where | What | Sensitive |
|---|---|---|
| `~/.local/state/p9-foundation/p9.db` (+ `.v<N>.bak` backups) | chats, operations, terminals, phone devices and the auth audit log | yes |
| `~/.local/state/p9-foundation/conflicts/` | recovery drafts: full text of saves that hit a conflict | yes |
| `~/.config/p9/settings.json` | Mission Control paths | no |
| `~/.local/share/p9/editor/` | Dev Focus editor data, extensions and its connection token | some |
| `~/.local/share/p9/codium-server/` | the VSCodium server you downloaded | no |
| `~/.local/state/p9/` | the "Open in VS Code" click log | no |
| `~/.config/systemd/user/p9-foundation.service.d/` | drop-ins: phone flags, the optional GitHub token | token: yes |
| `$XDG_RUNTIME_DIR/p9-foundation/` | the socket and its cookie; gone at logout | yes |
| `~/.config/Electron/` | the window's profile: focus mode, layout | no |
| the user journal (`journalctl --user -u p9-foundation`) | daemon log lines, including auth events | some |
| the clone (`~/p9`) | the app itself and its `node_modules` | no |

## Develop and test

```sh
pnpm test                 # unit and real-process tests
pnpm gate:all             # every phase gate; some need the editor host, tmux and systemd
pnpm gate:13              # a single phase
```

The tests start real daemons, Electron windows and tmux servers in temporary homes, and never touch your
installed P9. Run them with `TMPDIR` on a disk with space: the full-disk test uses private 1 MiB tmpfs
mounts (it needs unprivileged user and mount namespaces), never a real filesystem.

Besides Node and pnpm, the tests need: tmux, `ss` (iproute2), GTK 3 (Electron), a display (or `xvfb-run`),
a systemd user manager, unprivileged user namespaces (Electron's Chromium sandbox) and gitleaks 8.19 or newer
(`gitleaks dir`; Debian trixie's package is too old). `.github/workflows/test.yaml` installs this same set on
GitHub's Ubuntu runner and runs the suite on every push to a branch other than `main`.

To publish your own copy, run `git config core.hooksPath .githooks`: the commit hook scans the staged
index for secrets, and the push hook runs gitleaks and a private-path scan over the full history.

## Status and known gaps

**Version 0.1.6, beta.** It is for testers: expect rough edges, and file what you hit as an issue
(`pnpm teh doctor` above prints a bundle you can attach). Updating from an earlier build: `UPGRADE.md`.

**New in 0.1.6:** the phone shell and Chats screens, and phone parity with the desktop chat; Send to server
and Send files over your own ssh; the server updating itself on connect; artifacts; the Security settings
group; the Sprint tracker window; the Dev Focus editor server installed by the install script, the AppImage
and a button; P9's own tmux; a saved-only-on-Ctrl+S editor; the side-panel Chat Focus file window that can
save; and the setup wizard finding an existing Mission Control layout.

- **Tested:** Linux is the main platform, built and tested on Arch-based CachyOS. The test suite (real
  daemons, Electron windows and tmux in temporary homes) runs on GitHub's Ubuntu runner on every push to a
  branch other than `main`; on the same pushes the Windows installers (x64 and arm64) are built, installed,
  updated, restarted and uninstalled on GitHub's Windows runners, and the AppImage is built and checked on
  Ubuntu (Actions, Installers; a runner session, not a real desktop).
- **Not tested:** a fresh install under a second Linux account; the Windows installer on a real PC beyond
  that runner; what happens to the host on Windows when Electron crashes (`SECURITY.md`). New in 0.1.6 and
  not run on real machines: Send to server, Send files and the server's self-update over real ssh between
  two computers (the tests use two daemons in one container joined by a stand-in ssh); the AppImage on a
  bare Ubuntu Desktop 24.04 through the wizard's sign-in; how fast the phone's Mission tab is against a
  real daemon.
- **Not supported:** macOS.
- **Known gaps:** installers are unsigned (checksum only, see above); a daemon restart cuts off the chat turn
  in progress (reopen to resume); Dev Focus refuses folder creation, rename and delete; recovery drafts have
  no screen yet; the phone view uses the browser's online flag, so it can miss a daemon that is unreachable;
  the AppImage still asks you to install `tmux` and needs `libfuse2t64`.

## Licenses

P9 is source-available under the [PolyForm Shield License 1.0.0](LICENSE): use it, change it and share it,
but not to sell or provide a product that competes with it. Contributions come in as pull requests; see
[CONTRIBUTING.md](CONTRIBUTING.md).

Every pinned third-party dependency, with its licence, is listed in [LICENSES.md](LICENSES.md).
