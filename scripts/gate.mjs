import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { paths, scan } from './scan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Electron checks send real keys to a focused window: a click elsewhere while one runs fails the gate. A sticky desktop
// notice says so until the gate exits (pass or fail). No notify-send (Windows, headless): no notice.
function handsOff() {
  const shown = spawnSync('notify-send', ['--print-id', '--urgency=critical', '--app-name=P9', 'Hands off: P9 tests running',
    'A test window will pop up. Leave it in front, and do not click or type, until this notice closes.'], { encoding: 'utf8' });
  const id = Number.parseInt(shown.stdout, 10);
  if (Number.isSafeInteger(id)) process.on('exit', () => spawnSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications',
    '--object-path', '/org/freedesktop/Notifications', '--method', 'org.freedesktop.Notifications.CloseNotification', String(id)]));
}
async function gate() {
  if (['--all', '--phase4', '--phase5', '--phase6', '--phase7', '--phase8', '--phase9', '--phase10', '--phase11', '--phase12', '--phase16', '--phase17'].some((flag) => process.argv.includes(flag))) handsOff();
  if (['--all', '--phase4', '--phase5', '--phase6', '--phase7', '--phase8', '--phase9', '--phase10', '--phase11', '--phase12', '--phase16', '--phase17'].some((flag) => process.argv.includes(flag))) await duwopPins(root);
  if (process.argv.includes('--all')) {
    const spike = path.resolve(root, '../spikes/gate.py');
    run('python3', [spike, '--all']);
  }
  run(process.execPath, ['--test', 'test/diagnostics.test.mjs', 'test/files.test.mjs', 'test/save-faults.test.mjs', 'test/scanner.test.mjs', 'test/server.test.mjs', 'test/startup.test.mjs', 'test/inventory.test.mjs']);
  await scan(root);
  console.log('PASS phase3 secret and private-path scan');
  run(process.execPath, ['scripts/licenses.mjs']);
  await mutationInventory(root);
  console.log('PASS phase3 mutation inventory: filesystem/process imports and mutation sites confined to enumerated reviewed modules; not an OS sandbox');
  console.log('PASS phase3 foundation code checks; run the project plan gate separately for review and Required threat-model acceptance');
  const phase6 = process.argv.includes('--all') || process.argv.includes('--phase6');
  const phase7 = process.argv.includes('--all') || process.argv.includes('--phase7');
  const phase8 = process.argv.includes('--all') || process.argv.includes('--phase8') || process.argv.includes('--phase15');
  // Phase 16 (Mission owned by P9): Mission's sections are checked by the mission (phase 5) and phone (phase 11) tests.
  const phase11 = process.argv.includes('--all') || process.argv.includes('--phase11') || process.argv.includes('--phase16') || process.argv.includes('--phase17');
  const phase10 = phase11 || process.argv.includes('--all') || process.argv.includes('--phase10');
  const phase9 = process.argv.includes('--all') || process.argv.includes('--phase9');
  const phase12 = process.argv.includes('--all') || process.argv.includes('--phase12');
  const phase13 = process.argv.includes('--all') || process.argv.includes('--phase13');
  const phase5 = phase6 || phase8 || phase9 || phase10 || phase12 || process.argv.includes('--phase5');
  if (phase5) run(process.execPath, ['--test', 'test/mission.test.mjs']);
  if (phase6) run(process.execPath, ['--test', '--test-concurrency=1', 'test/chat.test.mjs', 'test/acp-contract.test.mjs']);
  if (phase7) run(process.execPath, ['--test', '--test-concurrency=1', 'test/windows-process-tree.test.mjs']);
  if (phase5 || process.argv.includes('--phase4')) {
    run('pnpm', ['build']);
    run('pnpm', ['check']);
    run(process.execPath, ['--test', '--test-concurrency=1', 'test/desktop.test.mjs', 'test/shell-regressions.test.mjs', 'test/duwop.test.mjs']);
  }
  if (phase8) {
    run('pnpm', ['build:dev']);
    // ponytail: --test-force-exit; something in the Electron/REH run keeps node's loop alive after every test passed (cause not found).
    run(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=200000', 'test/dev.test.mjs']);
  }
  if (phase9) run(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', 'test/session-ui.test.mjs', 'test/session-durability.test.mjs', 'test/terminals-recovery.test.mjs']);
  if (phase10) run(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=180000', 'test/remote-auth.test.mjs', 'test/auth-races.test.mjs']);
  if (phase11) run(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=180000', 'test/phone.test.mjs', 'test/surface2.test.mjs']);
  if (phase12) {
    if (!phase8) run('pnpm', ['build:dev']);
    // auth-races already ran with phase 10 under --all.
    run(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit', '--test-timeout=240000', 'test/adversarial.test.mjs', ...(phase10 ? [] : ['test/auth-races.test.mjs'])]);
  }
  if (phase13) run(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', 'test/release-state.test.mjs', 'test/anymouse.test.mjs', 'test/teh-devices.test.mjs', 'test/release-install.test.mjs']);
}

export async function duwopPins(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'duwop-source.json'), 'utf8'));
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(directory, 'apps/web', file.target));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('duwop-pin-mismatch: ' + file.target);
  }
  console.log('PASS phase4 DUWOP: every unmodified vendor file matches its pinned sha256');
}

export async function mutationInventory(directory) {
  // Inventory filesystem/process access, including server's read-only recovery count.
  // side.mjs, controller.mjs = the side panel's own side.open(slot, ...) and close (c12: a panel in the page, no filesystem; the page has no fs at all).
  // phone.ts, terminal.mjs = the xterm screen's write() and open() (draw and mount, Phase 17; terminal.mjs is the
  // shared terminal code split out of phone.ts), no filesystem.
  // files = workspace replacement/recovery drafts; mission = registry script spawns (shell:false); main = daemon state; doctor = selected bundle, and teh's stageDaemon = the AppImage's daemon copied to ~/.local/share/p9 (AU4); installer = user unit.
  // mcp = registry and space edits through guardedSave, plus journalctl for the daemon log; mcp-relay = stdout only.
  // desktop remote (Server mode, row 50) = the forward's folder under XDG_RUNTIME_DIR (0700) with the server's desktop.json (0600), removed on close, and ssh with fixed argv (no shell here) for the forward, the server's credentials and its restart.
  // server move (Send to server, row 51) = a moving chat's history in <ownership>/moves (0700/0600, removed when settled), and on the receiving server the pieces there plus the transcript in ~/.claude/projects (a temp file, then rename).
  // icons = Mission tile art: the cache of site icons in the state folder (a temp file, then rename) and the user's pictures in the icons folder beside the registry (content-named, written only after the edit route's confirm and hash checks).
  // editor install (D5, row 52) = editor-host's installEditorHost: the pinned REH into a temp folder in P9's folder, checked, then renamed into place (an old one renamed aside); install-editor = reads the installed product.json and calls it.
  // agent launchers (item 15, row 61) = deps.mjs placeAgents: a claude/codex launcher in P9's bin folder (0700), two absolute paths and no request text (a temp file, then rename), and placeTmux (row 60): the pinned tmux 3.8 there, written only after its SHA-256 matches (a temp file, then rename); it never runs sudo (install.sh and the wizard show the reason and ask).
  // desktop send files (item 23, row 59) = xfer.mjs's record of what was sent to each server, <profile>/xfer/<host>.json (0700/0600,
  // a temp file, then rename); the files themselves are written by the two daemons (apps/server/xfer.mjs, through packages/files).
  // server send files (item 23, row 59) = apps/server/xfer.mjs: a send's pieces in <ownership>/xfer/in-<id> (0700/0600, removed on commit
  // or abort, the folder swept at start), git ls-files with fixed argv (no shell, reads only); workspace writes only through packages/files.
  // pieces (item 23) = apps/server/pieces.mjs appends one checked piece (0600) to the staging file its caller names, xfer.mjs's above.
  // server update (item 14, row 62) = apps/server/update.mjs: the pushed or downloaded source archive in <ownership>/update/<id>.tar.gz
  // (0600, removed after unpacking, swept at start), its build log there, and the new checkout beside the running one (<root>.new-<id>,
  // tar and pnpm with fixed argv, no shell, swept at start); scripts/update-swap.mjs renames the two (old kept as <root>.previous, a new one
  // that does not start moved to <root>.failed-*) and writes <ownership>/update/result.json (a temp file, then rename). apps/desktop/server-update.mjs = git archive (fixed argv) into a
  // temp folder for the push, removed after.
  // remote install (D15a, row 67) = apps/desktop/remote-install.mjs: ssh with fixed argv and BatchMode, no shell here; it writes nothing on
  // this machine (a checkout's git archive goes to ssh's stdin). On the remote: ~/p9 only when absent, then install.sh --headless.
  // ssh password login (rows 78, 79) = apps/desktop/ssh-login.mjs: ssh's control folder (XDG_RUNTIME_DIR or the temp folder, made 0700,
  // refused unless a real folder this user owns), and in it, for one login only, a random-named Unix socket (0600), the SSH_ASKPASS
  // helper (0700, P9's own Node and a fixed script, no password in it) and ssh's stderr log (0600), all three removed after; ssh with
  // fixed argv (host checked against HOST, no shell). The password goes window -> socket -> helper's stdout -> ssh, never a file, argument
  // or environment. makeKey: P9's own key in the profile's ssh folder (0700) by ssh-keygen with fixed argv; a half pair is removed
  // first. installKey: the checked p9-event-horizon public line on ssh's stdin, appended to the remote's authorized_keys only if absent.
  // slim agents (U8, row 50) = scripts/agents.mjs, run on a remote by install.sh --slim only: each agent's binary package by exact URL,
  // sha512-checked against the lock file's pin before anything is written, unpacked by tar (fixed argv) in a temp folder in P9's
  // node_modules, then renamed over that one package's folder; the temp folder is removed.
  // No filesystem, matched only by their text: idle.mjs = its own open() counting a server's connections (row I1);
  // mission-fields.mjs = "link (" in a comment and in an error message; data-tiles.mjs = "link (" in a comment.
  // what's new (D13) = apps/desktop/whats-new.mjs: p9-version.txt in the desktop's profile folder, holding P9's own package.json
  // version (nothing from the window); a lost write only shows the popup once more or not at all.
  // live Claude usage (row 42) = apps/server/claude-usage.mjs: starts one Claude Agent SDK query (the claude CLI, fixed options, cwd the
  // temp folder, no settings, hooks, plugins or MCP servers, no session kept, never a prompt) and writes nothing itself; a page's GET
  // /usage only marks that someone looks (no input reaches the query), and the answer is read for the 5 h and 7 d windows only.
  // phone rebuild (c18, row 64) = server.mjs's POST /rebuild: pnpm build (or P9_BUILD in tests) with fixed argv, no shell, in the checkout it serves, 10 minutes, one at a time; it writes only what the build writes (apps/web/dist).
  // phone Security settings (c18, row 66) = no new writes: the phone listener gets the desktop's POST /agent-lock and /file-protection (prefs rows) and /setup/settings (settings.json, .bak, temp + rename).
  // frame runtimes (item 19, row 65) = scripts/frame-runtimes.mjs, a build step: copies Mermaid's and TypeScript's browser builds and writes the React bundle into apps/web/dist/frame; nothing at run time.
  // sprint (#35) = apps/server/sprint.mjs reads the sprint status file only (open 'r', then stat and read); it writes nothing.
  // delegate = fixed git status in the worker folder, no shell, hooks and fsmonitor disabled; repository clean filters may still run.
  // windows trimLog (0107bfa) = daemon.log beside P9's state folder (the Windows task's, Linux background mode's; none beside the unit's): copied to daemon.log.1, then truncated in place when over 5 MB; the desktop's p9-freeze.log in its profile folder the same way (main.mjs); fixed paths, never one a request names.
  // desktop rollback (AU5) = update-state.json in the profile folder and rollback.json's shown mark in P9's folder (a temp file, then rename); it starts nothing (main does).
  // files/win32 = the Windows form of the file guard's handle walk (index.mjs's writes, through NtCreateFile handles);
  // conpty = a terminal's input pipe (write), no filesystem; installer.nsh = runs install-windows.ps1 on install and
  // PowerShell to stop and remove the task, and a real uninstall removes %LOCALAPPDATA%\P9\daemon and launcher (matched only by "open (" in a comment). Dev and build scripts, never in the
  // app: bundle-daemon = the daemon bundles into the packaging folder package-windows gives it; hot-reload-check = one probe file in apps/web/dist and a temp profile, both removed;
  // updater = checks that resources/app-update.yml exists (electron-updater writes only its own download cache);
  // package-linux = the AppImage's packaging folder, as package-windows; merge-latest = the one latest.yml CI uploads (its output file); mem-guard = reads /proc/meminfo; p9 = starts Electron (reads only); with-tmp = a temp folder for the tests, removed.
  // bare-machine (CI and by hand, never in the app) = docker only: builds the p9-bare and p9-bare-apt-file images, starts the privileged p9-bare (or p9-bare-appimage) container, replacing one of that name, and --rm containers for the static tmux build and its check; inside them it apt-installs packages, installs P9 from a tar of the git-tracked files, calls the wizard's routes and runs each launcher's --version (node:child_process, inside the container). The image's p9 user has passwordless sudo (inside the container only). On the host it writes only /tmp/p9-bare-before.txt, -desktop.txt (Ubuntu's Desktop manifest, downloaded) and -install.log, and in the DIR it is given tmux's release tarball (SHA-256 checked before use), tmux, tmux.versions, tmux.sha256; never the checkout or the host's P9.
  // F9 split (0.1.9): setup-routes = server.mjs's setup wizard routes, moved out of createListener with the same accesses as before (wizard folders and files, agent launchers, the agents fetch).
  // F9 split (0.1.9), desktop: pet-files, served-pages, pets-ipc, dev-ipc = main.mjs's pet folder reads and installs, build-asset reads, pet IPCs and Dev Focus IPCs, moved out of main.mjs with the same accesses as before.
  // F9 split (0.1.9), web: mission-view (o.write( on a Mission view) and chat-view (side.open( for the side panel) = renderer code moved out of controller.mjs, which is on the list for the same text; no file access of their own.
  // N1 (0.1.9): projects = P9's own folder per project under <ownership>/projects (project.json and instructions.md by temp file and rename, added files by O_EXCL then link, the folder removed on delete) and one createDirectory for "new folder somewhere else"; never a write in a work folder.
  // Worker folders (0.1.9 K1, SECURITY.md "Worker folders") = apps/server/worker-folders.mjs: under <ownership>/sprints only: a clone made in a temp folder then renamed, git worktree add/remove and branch -D in that clone, a ready marker per worker, rm of only its own workers/ready/clone; runs git (fixed arguments, no shell) and the owner's setup command (shell, the allow-list environment, 15 min, as a process tree of process-tree.mjs launchTree, stopped whole by endTree at the cap) in a new worker folder; reads git facts in the owner's folder; opens no socket.
  // Sprint files (0.1.9 D1 D3 D4, SECURITY.md "Sprint files") = apps/server/sprint-files.mjs: under <ownership>/sprints/<lead id>/ only, five fixed names (plan, rules, role files, notes), a link refused, each written whole by temp file and rename (0600, folders 0700); reads them; runs nothing, opens no socket.
  // N1 panel (0.1.9): panel.mjs = the left panel; o.newPop.open( opens the new-chat popover (and "open (" in a comment); no file access.
  // N1 projects (0.1.9): projects-view.mjs = the project page and New project; o.newPop.open( opens the new-chat popover; added files go to the daemon as base64 through p9:chat; no file access.
  // No local paths (0.1.9, CI and pre-push, never in the app): no-local-paths = runs git log and git diff (reads only) and reads the PR body file it is given.
  // live Codex usage (0.1.9, SECURITY.md "Plan usage reads") = apps/server/codex-usage.mjs: starts the bundled Codex's app-server (fixed arguments, no shell, the allow-list environment, cwd the temp folder), sends it one fixed read of the account's rate limits over stdio and ends it; it opens and writes no file.
  // provider profiles (0.1.9 O48, SECURITY.md "Provider profiles") = apps/server/profiles.mjs: writes one file, profiles.json beside the ledger (mode 600, create-then-rename), and runs the profile's own key command at a chat start (no shell, the allow-list environment, 10 s); it opens no socket.
  const allowed = new Set(['apps/server/profiles.mjs', 'apps/server/worker-folders.mjs', 'apps/server/sprint-files.mjs', 'apps/server/codex-usage.mjs', 'scripts/no-local-paths.mjs', 'packages/files/index.mjs', 'apps/server/projects.mjs', 'apps/web/src/projects-view.mjs', 'packages/files/win32.mjs', 'apps/server/windows.mjs', 'apps/server/conpty.mjs', 'scripts/installer.nsh', 'scripts/bundle-daemon.mjs', 'scripts/hot-reload-check.mjs', 'scripts/mem-guard.mjs', 'scripts/p9.mjs', 'scripts/with-tmp.mjs', 'scripts/bare-machine.sh','apps/web/src/terminal.mjs', 'apps/server/main.mjs', 'apps/server/server.mjs', 'apps/server/mission.mjs', 'apps/server/mcp.mjs', 'apps/server/mcp-relay.mjs', 'apps/server/icons.mjs', 'apps/server/limits.mjs', 'apps/server/chat.mjs', 'apps/server/process-tree.mjs', 'apps/server/terminals.mjs', 'apps/server/ledger.mjs', 'scripts/teh.mjs', 'scripts/install-service.mjs', 'scripts/install.sh', 'scripts/uninstall-service.mjs', 'scripts/rollback.mjs', 'scripts/install-windows.ps1', 'scripts/windows-host.ps1', 'scripts/extract-node-windows.ps1', 'scripts/package-windows.mjs', 'scripts/package-linux.mjs', 'scripts/merge-latest.mjs', 'scripts/scan.mjs', 'scripts/gate.mjs', 'scripts/frame-runtimes.mjs', 'scripts/licenses.mjs', 'apps/desktop/main.mjs', 'apps/desktop/updater.mjs', 'apps/desktop/rollback.mjs', 'apps/desktop/editor-host.mjs', 'scripts/install-editor.mjs', 'apps/desktop/remote.mjs', 'apps/desktop/xfer.mjs', 'apps/server/move.mjs', 'apps/server/deps.mjs', 'apps/server/xfer.mjs', 'apps/server/pieces.mjs', 'apps/server/update.mjs', 'scripts/update-swap.mjs', 'apps/desktop/server-update.mjs', 'apps/desktop/whats-new.mjs', 'apps/server/claude-usage.mjs', 'apps/desktop/remote-install.mjs', 'apps/desktop/ssh-login.mjs', 'scripts/agents.mjs', 'apps/server/idle.mjs', 'apps/server/mission-fields.mjs', 'apps/web/src/data-tiles.mjs', 'apps/server/sprint.mjs', 'apps/server/delegate.mjs', 'apps/server/memory.mjs', 'apps/server/telemetry.mjs', 'apps/dev/client.js', 'apps/web/src/helpers.mjs', 'apps/web/public/sw.js', 'apps/web/src/phone.ts', 'apps/web/src/side.mjs', 'apps/web/src/controller.mjs', 'apps/server/setup-routes.mjs', 'apps/desktop/pet-files.mjs', 'apps/desktop/served-pages.mjs', 'apps/desktop/pets-ipc.mjs', 'apps/desktop/dev-ipc.mjs', 'apps/web/src/mission-view.mjs', 'apps/web/src/chat-view.mjs', 'apps/web/src/panel.mjs']);
  const sourceExtensions = new Set(['.sh', '.js', '.cjs', '.mjs', '.ps1', '.nsh', '.ts', '.tsx', '.astro', '.html']);
  const dataExtensions = new Set(['.md', '.json', '.yaml', '.yml', '.css', '.svg', '.webmanifest']);
  const specialFiles = new Set(['LICENSE', '.publish', '.publishignore', '.gitignore', '.gitattributes', '.gitleaksignore', '.githooks/pre-commit', '.githooks/pre-push']);
  for (const file of await paths(directory)) {
    const relative = path.relative(directory, file);
    const extension = path.extname(file);
    if (!sourceExtensions.has(extension)) {
      if (dataExtensions.has(extension) || specialFiles.has(relative)) continue;
      // Release images (README, icons) are binary and live only in docs/brand/, plus the phone's icon and the top bar's mark
      // in apps/web/public/ and the bundled default pet's sheet.
      if ((relative.startsWith('docs/brand/') || relative === 'apps/web/public/p9-icon.png' || relative === 'apps/web/public/p9-mark.png' || relative === 'apps/desktop/pets/skipper/spritesheet.png') && ['.png', '.jpg', '.ico'].includes(extension)) continue;
      // The landing v5 poster and its rendered loop (163ac1e), imported by the controller as asset URLs.
      if (['apps/web/src/components/landing-v5/black-hole.webp', 'apps/web/src/components/landing-v5/rendered/horizon-loop.mp4'].includes(relative)) continue;
      // The stands-alone check's baseline, plain rows of counts (data).
      if (relative === 'scripts/stands-alone-baseline.txt') continue;
      throw new Error('unsupported-source-extension: ' + relative);
    }
    if (relative.startsWith('test/')) continue;
    const source = await readFile(file, 'utf8');
    if (/(?:node:fs|node:child_process|\b(?:open|writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|mkdir|appendFile|createWriteStream|copyFile|rm|truncate|symlink|link|chmod)\s*\(|\.write\s*\()/.test(source)
        && !allowed.has(relative)) throw new Error('unreviewed-write-module: ' + relative);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await gate();
