# Upgrading P9

## To 0.1.6 (beta)

The Windows app and the AppImage update themselves from 0.1.5 (Settings > Maintenance > Updates). A source checkout
updates as `README.md` § Update, roll back, uninstall says, then reopen the window (the desktop main process changed).
Installing restarts the background service, which ends a chat turn in progress.

**What you will notice**

- Dev Focus saves only on Ctrl+S or Save. Before, the editor wrote a file about a second after your last key. A white
  dot on a tab marks an unsaved file.
- Settings has a Security settings group with four switches: Agent lock, File protection, Warn before Full access and
  Bypass permissions, and Unrestricted mode. The defaults are the ones you had (lock off, protection on, warnings
  on). The paired phone can now change the agent lock and File protection too, and edit your Mission Control files;
  before 0.1.6 only the desktop could. To cut off a lost phone, revoke it from the desktop. Turning File protection
  off, or Unrestricted mode on, asks first.
- A loosened mode (Claude Bypass permissions, Codex Full access) no longer carries into the next new chat unless you
  said "Don't show again". Settings > New chats start in sets each agent's default mode.
- The phone has a new shell (a 44 px top bar and a tab bar), a Chats list that opens a chat at its last message, the
  desktop's composer, modes, models and photos, a Paste key in the terminal, a Mission tab, a Sprint window, and Settings (theme, Security settings, Mission Control files, Rebuild + reload).
- Chat Focus shows artifacts: an agent's fenced block marked `<type> artifact` opens in a sealed frame beside the
  chat, and your comments on it go back as one message. A file you open from Chat Focus can be saved (the same
  guarded save as Dev Focus), and Chat Focus full keeps only the text box under a full-screen artifact.
- Mission Control: chips read `needs <your name>`, rail robot heads are numbered, rows have a Run pill and cost in
  cents, and an empty Mission explains itself. A Sprint button appears while the machine you are connected to has a sprint status file; its window shows a ring for the whole sprint and one per chunk.
- The setup wizard has a *Claude, Codex or both?* step that installs the CLIs P9 ships, a Mission step that finds an
  existing layout (an `AGENTS.md`, a `registry.json`, a `needs-you` or `waiting` folder) and offers *Use these files*,
  and a welcome choice to connect to a P9 on another machine. The wizard, the Mission plans list and the hub queue no
  longer look inside `node_modules`, `.venv`, `dist`, `build`, `.cache` and similar folders.

**What you can now do**

- Settings > Server works on a server's P9, Dev Focus included. In Chat Focus, *Send to server* moves a Claude or
  Codex chat to it, and *Send files to server* copies a folder, with no Syncthing. Settings > Send files sets the
  limits. From 0.1.6 on, connecting from a newer P9 updates a server that already runs 0.1.6 (a failed build leaves the
  server as it was; a new build that does not start is put back). A server still on 0.1.5 needs one update by hand. You need an `ssh` entry for the server that works without a password prompt.

**What you must do**

- **Linux AppImage, new installs:** it needs `libfuse2t64` (the AppImage mounts itself with FUSE, and Ubuntu Desktop
  24.04 does not ship it): `sudo apt install libfuse2t64`. It still needs `tmux` installed.
- **Linux source checkout:** run `bash scripts/install.sh` again after you update. It installs Dev Focus's editor
  server into `~/.local/share/p9/codium-server`, downloads P9's pinned static tmux 3.8 when you have no tmux, and shows
  the reason before it asks for your admin password for anything else. Without it, Dev Focus offers an *Install the
  editor server* button.
- **A server that runs P9:** a server still on 0.1.5 does not update itself (0.1.5 has no update route). Update it by
  hand once, as a source checkout (the README's Update steps: git pull, build, restart), then run
  `bash scripts/install.sh` there, as the source checkout bullet above says. After that, connecting from a newer P9 updates it.
  A server you reach another way updates as a source checkout does.
- **Windows:** nothing. The update keeps your workspace and the `P9 Foundation` task.

## To 0.1.5 (beta)

The installed app now updates itself. From 0.1.5 on, the Windows app and the new Linux AppImage check P9's public
GitHub releases shortly after they start and every 4 hours, take only releases that are not pre-releases, download a
newer one in the background and install it when you quit, or at once from Settings > Maintenance > Updates.
Installing restarts the background service on the new version, which ends a chat turn in progress. 0.1.4 cannot
update itself, so this one move to 0.1.5 is still a manual install (below). A source checkout never updates itself;
there, Check now opens P9's newest release in your browser, as the old update button did. What is downloaded and how it
is checked: `SECURITY.md` § Auto-update.

If an update will not start twice, P9 goes back to the version you had on its own, says so once, and offers a
prefilled GitHub bug report with the log (home folder, user and host names, tokens and IP addresses removed) that you
read and send yourself. The version it came back from is not offered again; the next newer release is. This protects
updates from 0.1.5 on; on Linux it needs the AppImage that P9 keeps of the version you had.

The background service now runs from its own copy for each version, and the one before is kept, so an update never
changes the files of the service that is running. The installers are smaller. The Windows ARM64 installer ships the
ARM64 Node. GitHub has forms for bug reports and feature requests.

Settings has a Maintenance group: Reload window, Refresh Mission, Restart daemon, Repair daemon service, and Rebuild +
reload in a source checkout, each also in Ctrl K. Restart daemon waits until the new service answers. Updates is a row
there. Every setting has an "i": hover it to see what the setting does, click it to open that part of the guide.

Settings also has a Mission Control files group: your setup paths, the space file, the server host name, link schemes
(`page_schemes`) and notes folders (`notes_roots`). Each saves at once and keeps the old file as `settings.json.bak`;
a value P9 refuses says why under its box. Setup says when a file is where a folder should be, and when you picked the
workspace folder itself. Its Mission Control step explains what each file is for and links to how to add buttons. It
checks every 10 s instead of every 2 s and stops once done, and it accepts a scripts folder.

Dev Focus has a working terminal on Windows. On Windows, apps and pages a Mission button opens keep running after a
service restart, a script whose record says `"detach": true` leaves the apps it opens running when it ends, and
stopping the `P9 Foundation` task now stops everything under it. Setup leaves an existing workspace's layout alone: it finds the AGENTS.md naming your main project and your
"waiting on" folder, and creates only what is missing.

After Change workspace, settings left from another workspace no longer make setup add a starter registry and waiting
folder beside the folder's own. It shows the paths it found, you can change them, and Use these rewrites `settings.json`
(the old file is kept as `settings.json.bak`). If the folder's registry runs commands from the folder above the
workspace, setup offers that folder as `scripts_root`, used only after you confirm.

Dev Focus can open any folder with File > Open Folder: one inside the workspace opens at once, one outside it after one
question naming it. Saves there get the same conflict check as the workspace. Your home folder, a drive root and P9's
own folders are refused, and the phone cannot write there. Changing workspace, or `p9 edit` on a workspace file, takes
Dev Focus back to the workspace.

Chat: while the agent works, Enter steers your message in after the current step, Tab queues it for after the turn,
and Esc cancels. Sending while a question or approval is open declines it. A queued message is kept across a window
restart. Photos you send are kept and show again as thumbnails (the oldest are deleted past 200 MB; the phone does not
show them), and a click on a picture shows it large (Esc or a click closes it). Edits show as real line diffs that
wrap, code blocks have a Copy button, the message box grows to twice its height, and a restart request from an agent
has a Restart button. A chat no longer freezes after you answer a question with Enter.

The agent's plan is pinned above the message box, and agents can pin cards there (Markdown, a checklist or a table).
Claude chats have a Hand off button: it stops the chat and opens a terminal with
`claude --resume <session> --remote-control` typed in; nothing runs until you press Enter, and Remote Control needs a
claude.ai subscription.

The phone: a Phone button in a desktop chat shows a QR code that opens that chat on the phone (set the server host name
first). The phone keeps a message typed offline, or while an approval waits, and sends it once it can ("Queue message",
with Take back). It opens faster, because it loads only the chats that are running, and it shows the plan and the
pinned cards.

Meters: every bar fills and turns amber from 75%; Claude and Codex limits update as you work, the cache timer counts
down on its own, and P9 finds your Claude and Codex folders when you have moved them with `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`. The halo ring turns more smoothly and uses much less CPU.

Mission Control picks up `settings.json`, registry and space edits within one refresh, with no restart, and accepts
files saved with a UTF-8 BOM. A space section can show a notes folder (`notes_roots` in settings), even one outside the
workspace. Registry pages may use the extra schemes you list in `page_schemes`, after a confirm showing the full link.
Edit names and icons changes a tile's name and icon, and saving several Mission Control file rows quickly keeps every
one. Link tiles show the site's own icon and app tiles the program's own icon; the Picture button sets your own image
(Remove goes back to automatic). A tile uses your picture, then your emoji or text icon, then the automatic icon, then
its letters.

Anymouse takes up to 50,000 characters and no longer says P9's repository is private. The agents in P9's chats get a
`p9` MCP server to read and change Mission Control, including tile names and icons (not pictures); running a script
or answering a needs-you item through it asks you first.

- **Linux:** a source checkout updates as `README.md` § Update, roll back, uninstall says; then reopen the window (the
  desktop main process changed). To use the AppImage instead, see `README.md` § Install; it needs `tmux`.
- **Windows:** run the 0.1.5 installer over the old one: `windows-arm64` on an ARM laptop, `windows-x64` otherwise.
  Your workspace and the `P9 Foundation` task are kept. Later versions install themselves.

## To 0.1.4 (beta)

The Windows installer unpacks far fewer files: the background service now ships as two bundled files plus the agents'
own programs, not 26,000 loose package files (0.1.3), so it installs faster. Its licence notices are in
`resources\licenses\daemon-NOTICES.md`. **Change the folder** in setup now works on Windows too: P9 stops what is
running, moves the `P9 Foundation` task to the new folder, and goes back to the old one if the service does not start.

The Look picker has two new looks, **Aphrodite Blue** and **Aphrodite Charcoal**. AMOLED (on by default) shows them
on black, so switch AMOLED off in the Look picker to see their colours.

- **Linux:** update as `README.md` § Update says, then reopen the window (the desktop main process changed).
- **Windows:** run the 0.1.4 installer over the old one: `windows-arm64` on an ARM laptop, `windows-x64` otherwise.
  Your workspace and the `P9 Foundation` task are kept; a task whose saved settings cannot be read is set up again on
  the default folder, `%USERPROFILE%\P9`.

## To 0.1.3 (beta)

Windows gets a native ARM64 installer next to the x64 one, and the installer now works for a standard (non-admin)
user. An installed P9 runs only the Node it ships, never one on your PATH.

- **Linux:** update as `README.md` § Update says, then reopen the window (the desktop main process changed). A
  service unit from before 0.1.0 now finds `tmux` in `~/.local/bin` without a reinstall.
- **Windows:** run the 0.1.3 installer over the old one: `windows-arm64` on an ARM laptop, `windows-x64` otherwise.
  Your workspace and the `P9 Foundation` task are kept.

## To 0.1.2 (beta)

Settings has an Updates row: it shows the version you have, and **Check for updates** opens P9's newest GitHub
release in your browser. P9 itself downloads nothing. Building the Windows installer no longer needs any cache
setting (the NSIS path limit is handled in `scripts/package-windows.mjs`).

- **Linux:** update as `README.md` § Update says, then reopen the window (the desktop main process changed).
- **Windows:** run the 0.1.2 installer over the old one. Your workspace and the `P9 Foundation` task are kept.

## To 0.1.1 (beta)

No app code changed since 0.1.0: P9 now carries a licence (PolyForm Shield), Linux has a one-line install, and
the Windows installer ships licence notices in `resources\licenses`.

- **Linux:** update as `README.md` § Update says. Nothing else to do.
- **Windows:** run the 0.1.1 installer over the old one. Your workspace and the `P9 Foundation` task are kept.

## To 0.1.0 (beta)

0.1.0 is the first tagged release. A new install needs nothing from this file; follow `README.md`.

If you ran a clone from before 0.1.0:

1. Update as `README.md` § Update says: `git pull && pnpm install --frozen-lockfile && pnpm build`, then
   `systemctl --user restart p9-foundation`. The restart stops running button runs and cuts off any agent turn in
   progress; chats resume when reopened.
2. Reopen the window: the desktop main process does not hot reload.
3. Run `pnpm teh doctor --state "$XDG_RUNTIME_DIR/p9-foundation"`; it exits 0 when the daemon answers.

What changes for an existing install:

- **State database.** The first start migrates the ledger to schema 2 (a chat's start folder). The old file is
  copied to `p9.db.v<N>.bak` first; `node scripts/rollback.mjs` restores the newest backup an older build can open.
- **Service PATH.** New units record the installer's `PATH`, so the service finds the same `tmux` and agent CLIs
  your shell does. An older unit can start with systemd's bare `PATH` after a reboot; P9 now adds `~/.local/bin`
  itself, so a `tmux` there is found. For a tool anywhere else, get the line: run `node scripts/uninstall-service.mjs`,
  then `node scripts/install-service.mjs "<your workspace>"` again.
- **Settings.** A `settings.json` that does not parse now turns off Mission Control only (`settings-invalid`);
  Chat, terminals and the phone stay up. New optional keys: `space`, `hub`, `server_host` (`README.md`).
- **Uninstall.** If Stop All or `systemctl disable` fails, the unit is kept so you can stop what still runs;
  `--force` removes it anyway.
- **Phone.** A phone that lost its session sign-in goes back to the login page instead of failing every save.
  `lock` is a sign-out (the phone can log in again with its passkey); use `revoke` to keep a phone out.
- **Windows.** The installer now registers the daemon's Scheduled Task itself (workspace `%USERPROFILE%\P9`, kept
  on later updates; runs on battery too) and uninstalling removes it.
