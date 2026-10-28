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
  // Phase 16 (Mission owned by P9): the hub sections are checked by the mission (phase 5) and phone (phase 11) tests.
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
  // phone.ts, terminal.mjs = the xterm screen's write() and open() (draw and mount, Phase 17; terminal.mjs is the
  // shared terminal code split out of phone.ts), no filesystem.
  // files = workspace replacement/recovery drafts; mission = registry script spawns (shell:false); main = daemon state; doctor = selected bundle, and teh's stageDaemon = the AppImage's daemon copied to ~/.local/share/p9 (AU4); installer = user unit.
  // mcp = registry and space edits through guardedSave, plus journalctl for the daemon log; mcp-relay = stdout only.
  // desktop remote (Server mode, row 50) = the forward's folder under XDG_RUNTIME_DIR (0700) with the server's desktop.json (0600), removed on close, and ssh with fixed argv (no shell here) for the forward, the server's credentials and its restart.
  // server move (Send to server, row 51) = a moving chat's history in <ownership>/moves (0700/0600, removed when settled), and on the receiving server the pieces there plus the transcript in ~/.claude/projects (a temp file, then rename).
  // icons = Mission tile art: the cache of site icons in the state folder (a temp file, then rename) and the user's pictures in the icons folder beside the registry (content-named, written only after the edit route's confirm and hash checks).
  // editor install (D5, row 52) = editor-host's installEditorHost: the pinned REH into a temp folder in P9's folder, checked, then renamed into place (an old one renamed aside); install-editor = reads the installed product.json and calls it.
  // editor spell checker (D12, row 56) = editor-host's installSpellChecker: the pinned Code Spell Checker file into a temp folder in the editor's data folder, checked, handed to the editor server's own --install-extension, then an 'offered' marker.
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
  // sprint (#35) = apps/server/sprint.mjs reads the sprint status file only (open 'r', then stat and read); it writes nothing.
  // desktop rollback (AU5) = update-state.json in the profile folder and rollback.json's shown mark in P9's folder (a temp file, then rename); it starts nothing (main does).
  // files/win32 = the Windows form of the file guard's handle walk (index.mjs's writes, through NtCreateFile handles);
  // conpty = a terminal's input pipe (write), no filesystem; installer.nsh = runs install-windows.ps1 on install and
  // PowerShell to stop and remove the task, and a real uninstall removes %LOCALAPPDATA%\P9\daemon and launcher (matched only by "open (" in a comment). Dev and build scripts, never in the
  // app: bundle-daemon = the daemon bundles into the packaging folder package-windows gives it; hot-reload-check = one probe file in apps/web/dist and a temp profile, both removed;
  // updater = checks that resources/app-update.yml exists (electron-updater writes only its own download cache);
  // package-linux = the AppImage's packaging folder, as package-windows; merge-latest = the one latest.yml CI uploads (its output file); mem-guard = reads /proc/meminfo; p9 = starts Electron (reads only); with-tmp = a temp folder for the tests, removed.
  const allowed = new Set(['packages/files/index.mjs', 'packages/files/win32.mjs', 'apps/server/conpty.mjs', 'scripts/installer.nsh', 'scripts/bundle-daemon.mjs', 'scripts/hot-reload-check.mjs', 'scripts/mem-guard.mjs', 'scripts/p9.mjs', 'scripts/with-tmp.mjs','apps/web/src/terminal.mjs', 'apps/server/main.mjs', 'apps/server/server.mjs', 'apps/server/mission.mjs', 'apps/server/mcp.mjs', 'apps/server/mcp-relay.mjs', 'apps/server/icons.mjs', 'apps/server/hub.mjs', 'apps/server/limits.mjs', 'apps/server/chat.mjs', 'apps/server/process-tree.mjs', 'apps/server/terminals.mjs', 'apps/server/ledger.mjs', 'scripts/teh.mjs', 'scripts/install-service.mjs', 'scripts/install.sh', 'scripts/uninstall-service.mjs', 'scripts/rollback.mjs', 'scripts/install-windows.ps1', 'scripts/windows-host.ps1', 'scripts/extract-node-windows.ps1', 'scripts/package-windows.mjs', 'scripts/package-linux.mjs', 'scripts/merge-latest.mjs', 'scripts/scan.mjs', 'scripts/gate.mjs', 'scripts/licenses.mjs', 'apps/desktop/main.mjs', 'apps/desktop/updater.mjs', 'apps/desktop/rollback.mjs', 'apps/desktop/editor-host.mjs', 'scripts/install-editor.mjs', 'apps/desktop/remote.mjs', 'apps/desktop/xfer.mjs', 'apps/server/move.mjs', 'apps/server/xfer.mjs', 'apps/server/pieces.mjs', 'apps/server/update.mjs', 'scripts/update-swap.mjs', 'apps/desktop/server-update.mjs', 'apps/server/sprint.mjs', 'apps/dev/client.js', 'apps/web/src/helpers.mjs', 'apps/web/public/sw.js', 'apps/web/src/phone.ts']);
  const sourceExtensions = new Set(['.sh', '.js', '.cjs', '.mjs', '.ps1', '.nsh', '.ts', '.tsx', '.astro', '.html']);
  const dataExtensions = new Set(['.md', '.json', '.yaml', '.yml', '.css', '.svg', '.webmanifest']);
  const specialFiles = new Set(['LICENSE', '.publish', '.publishignore', '.gitignore', '.githooks/pre-commit', '.githooks/pre-push']);
  for (const file of await paths(directory)) {
    const relative = path.relative(directory, file);
    const extension = path.extname(file);
    if (!sourceExtensions.has(extension)) {
      if (dataExtensions.has(extension) || specialFiles.has(relative)) continue;
      // Release images (README, icons) are binary and live only in docs/brand/, plus the phone's icon in apps/web/public/
      // and the bundled default pet's sheet.
      if ((relative.startsWith('docs/brand/') || relative === 'apps/web/public/p9-icon.png' || relative === 'apps/desktop/pets/skipper/spritesheet.png') && ['.png', '.jpg', '.ico'].includes(extension)) continue;
      throw new Error('unsupported-source-extension: ' + relative);
    }
    if (relative.startsWith('test/')) continue;
    const source = await readFile(file, 'utf8');
    if (/(?:node:fs|node:child_process|\b(?:open|writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|mkdir|appendFile|createWriteStream|copyFile|rm|truncate|symlink|link|chmod)\s*\(|\.write\s*\()/.test(source)
        && !allowed.has(relative)) throw new Error('unreviewed-write-module: ' + relative);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await gate();
