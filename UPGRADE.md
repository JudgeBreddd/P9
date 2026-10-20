# Upgrading P9

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
  your shell does. An older unit keeps working; to get the line, run `node scripts/uninstall-service.mjs`, then
  `node scripts/install-service.mjs "<your workspace>"` again.
- **Settings.** A `settings.json` that does not parse now turns off Mission Control only (`settings-invalid`);
  Chat, terminals and the phone stay up. New optional keys: `space`, `hub`, `server_host` (`README.md`).
- **Uninstall.** If Stop All or `systemctl disable` fails, the unit is kept so you can stop what still runs;
  `--force` removes it anyway.
- **Phone.** A phone that lost its session sign-in goes back to the login page instead of failing every save.
  `lock` is a sign-out (the phone can log in again with its passkey); use `revoke` to keep a phone out.
- **Windows.** The installer now registers the daemon's Scheduled Task itself (workspace `%USERPROFILE%\P9`, kept
  on later updates; runs on battery too) and uninstalling removes it.
