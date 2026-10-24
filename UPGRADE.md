# Upgrading P9

## To 0.1.5 (beta)

Dev Focus has a working terminal on Windows. On Windows, apps and pages a Mission button opens keep running after a
service restart, a script whose record says `"detach": true` leaves the apps it opens running when it ends, and
stopping the `P9 Foundation` task now stops everything under it. Setup leaves an existing workspace's layout alone: it finds the AGENTS.md naming your main project and your
"waiting on" folder, and creates only what is missing.

After Change workspace, settings left from another workspace no longer make setup add a starter registry and waiting
folder beside the folder's own. It shows the paths it found, you can change them, and Use these rewrites `settings.json`
(the old file is kept as `settings.json.bak`). If the folder's registry runs commands from the folder above the
workspace, setup offers that folder as `scripts_root`, used only after you confirm.

A message you send while the agent works now reaches it at its next step instead of waiting for the turn to end, and
sending while a question or approval is open declines it. A message that has to wait shows as queued and is kept
across a window restart.

Mission Control picks up `settings.json`, registry and space edits within one refresh, with no restart, and accepts
files saved with a UTF-8 BOM. A space section can show a notes folder (`notes_roots` in settings), even one outside the
workspace. Registry pages may use the extra schemes you list in `page_schemes`, after a confirm showing the full link.
Anymouse takes up to 50,000 characters. The agents in P9's chats get a `p9` MCP server to read and change Mission
Control; running a script or answering a needs-you item through it asks you first.

- **Linux:** update as `README.md` § Update says, then reopen the window (the desktop main process changed).
- **Windows:** run the 0.1.5 installer over the old one: `windows-arm64` on an ARM laptop, `windows-x64` otherwise.
  Your workspace and the `P9 Foundation` task are kept.

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
