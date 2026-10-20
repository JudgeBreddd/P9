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
  // files = workspace replacement/recovery drafts; mission = registry script spawns (shell:false); main = daemon state; doctor = selected bundle; installer = user unit.
  const allowed = new Set(['packages/files/index.mjs', 'apps/web/src/terminal.mjs', 'apps/server/main.mjs', 'apps/server/server.mjs', 'apps/server/mission.mjs', 'apps/server/hub.mjs', 'apps/server/limits.mjs', 'apps/server/chat.mjs', 'apps/server/process-tree.mjs', 'apps/server/terminals.mjs', 'apps/server/ledger.mjs', 'scripts/teh.mjs', 'scripts/install-service.mjs', 'scripts/uninstall-service.mjs', 'scripts/rollback.mjs', 'scripts/install-windows.ps1', 'scripts/windows-host.ps1', 'scripts/extract-node-windows.ps1', 'scripts/package-windows.mjs', 'scripts/scan.mjs', 'scripts/gate.mjs', 'scripts/licenses.mjs', 'apps/desktop/main.mjs', 'apps/desktop/editor-host.mjs', 'apps/dev/client.js', 'apps/web/src/helpers.mjs', 'apps/web/public/sw.js', 'apps/web/src/phone.ts']);
  const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.ps1', '.nsh', '.ts', '.tsx', '.astro', '.html']);
  const dataExtensions = new Set(['.md', '.json', '.yaml', '.css', '.svg', '.webmanifest']);
  const specialFiles = new Set(['.publish', '.publishignore', '.gitignore', '.githooks/pre-commit', '.githooks/pre-push']);
  for (const file of await paths(directory)) {
    const relative = path.relative(directory, file);
    const extension = path.extname(file);
    if (!sourceExtensions.has(extension)) {
      if (dataExtensions.has(extension) || specialFiles.has(relative)) continue;
      // Release images (README, icons) are binary and live only in docs/brand/, plus the phone's icon in apps/web/public/.
      if ((relative.startsWith('docs/brand/') || relative === 'apps/web/public/p9-icon.png') && ['.png', '.jpg', '.ico'].includes(extension)) continue;
      throw new Error('unsupported-source-extension: ' + relative);
    }
    if (relative.startsWith('test/')) continue;
    const source = await readFile(file, 'utf8');
    if (/(?:node:fs|node:child_process|\b(?:open|writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|mkdir|appendFile|createWriteStream|copyFile|rm|truncate|symlink|link|chmod)\s*\(|\.write\s*\()/.test(source)
        && !allowed.has(relative)) throw new Error('unreviewed-write-module: ' + relative);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await gate();
