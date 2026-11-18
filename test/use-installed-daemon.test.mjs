// O135 "use the installed daemon" (teh.mjs useInstalledDaemon): a service whose unit or drop-in runs another copy is moved onto
// the launcher only when the caller passes the checkout and the ExecStart the user saw is still what systemd runs. The old
// unit is kept as a backup and drop-ins that set ExecStart are moved aside; an install that fails, or a daemon that never
// answers with the installed version, puts every file back and restarts the old service. systemctl, the staged daemon's
// install-service.mjs and /health are stand-ins here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const teh = new URL('../scripts/teh.mjs', import.meta.url).href;
// The unit as install-service writes it (the workspace quoted), or as written by hand (quoted: false).
const quote = (value) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
const OLD_UNIT = '[Service]\nExecStart=/usr/bin/node /srv/src/p9/apps/server/main.mjs --workspace /srv/old --state %t/p9-foundation --recovery /r\n';
const ENV = '[Service]\nEnvironment=P9_EXAMPLE=1\n';

// One machine: a unit plus two drop-ins, daemon 5.0.0 staged, and what systemctl show answers. health: what /health says
// ({ version } or null for no answer); installFails: the stand-in installer fails as the real one does (unit removed);
// name: the workspace folder's name. A folder 'my' always exists too, where a name like 'my --x w' would be cut. quoted: the
// drop-in quotes the workspace as install-service does; phone: the drop-in carries the phone flags; second: a second drop-in
// that sets ExecStart (zz.conf). base(workspace): the unit's own text instead of OLD_UNIT; spaced: the drop-in writes
// 'ExecStart =' with indentation and spaces round '=' and carries phone flags 9443 and https://b.example. local: false writes no
// override.conf (only env.conf); paths(unit, dropins): what systemctl show says for FragmentPath and DropInPaths instead of the
// files written here; reload: the NeedDaemonReload answer (null: none); later: what the second paths answer is instead.
async function machine({ reload = 'no', later,  health = { version: '5.0.0' }, installFails = false, name = 'my work', quoted = true, phone = true, second = false, base, spaced = false, local = true, paths } = {}) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-home-'))), bin = await mkdtemp(path.join(os.tmpdir(), 'p9-bin-'));
  const workspace = path.join(home, name), units = path.join(home, '.config', 'systemd', 'user'), dir = path.join(home, '.local', 'share', 'p9', 'daemon', '5.0.0');
  for (const folder of [workspace, path.join(home, 'my'), path.join(units, 'p9-foundation.service.d'), path.join(dir, 'scripts')]) await mkdir(folder, { recursive: true });
  const unitText = base ? base(workspace) : OLD_UNIT;
  await writeFile(path.join(units, 'p9-foundation.service'), unitText);
  const flags = ' --state %t/p9-foundation --recovery /r' + (!phone ? '' : spaced ? ' --remote-port 9443 --remote-origin https://b.example' : ' --remote-port 8443 --remote-origin https://phone.example');
  const override = `[Service]\n${spaced ? 'ExecStart =\n  ExecStart = ' : 'ExecStart=\nExecStart='}/usr/bin/node /srv/src/p9/apps/server/main.mjs --workspace ${quoted ? quote(workspace) : workspace}${flags}\n`;
  if (local) await writeFile(path.join(units, 'p9-foundation.service.d', 'override.conf'), override);
  if (second) await writeFile(path.join(units, 'p9-foundation.service.d', 'zz.conf'), override);
  await writeFile(path.join(units, 'p9-foundation.service.d', 'env.conf'), ENV);
  await writeFile(path.join(dir, '..', 'current'), '5.0.0\n');
  await writeFile(path.join(dir, '.complete'), '');
  await symlink(process.execPath, path.join(dir, 'node'));
  await writeFile(path.join(dir, 'scripts', 'install-service.mjs'), `import { writeFileSync, rmSync } from 'node:fs';
writeFileSync(${JSON.stringify(bin + '/installed')}, JSON.stringify(process.argv.slice(2)));
const unit = ${JSON.stringify(path.join(units, 'p9-foundation.service'))};
if (${installFails}) { rmSync(unit); process.exit(1); }
writeFileSync(unit, '[Service]\\nExecStart=/launcher/p9-launch.sh node main.mjs\\n');\n`);
  const seen = `{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/src/p9/apps/server/main.mjs --workspace ${workspace}${flags.replace('%t', '/run/user/1000')} ; ignore_errors=no ; pid=0 }\n`;
  await writeFile(path.join(bin, 'shows'), seen);
  const dropins = ['env.conf', ...(local ? ['override.conf'] : []), ...(second ? ['zz.conf'] : [])], unitFile = path.join(units, 'p9-foundation.service');
  const written = dropins.map((n) => path.join(units, 'p9-foundation.service.d', n));
  await writeFile(path.join(bin, 'paths'), (paths ? paths(unitFile, written) : `FragmentPath=${unitFile}\nDropInPaths=${written.join(' ')}\n`) + (reload === null ? '' : `NeedDaemonReload=${reload}\n`));
  if (later) await writeFile(path.join(bin, 'later'), later(unitFile, written));
  await writeFile(path.join(bin, 'health'), JSON.stringify(health));
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> "${bin}/calls"\n[ "$2" = show ] && [ "$5" = ExecStart ] && cat "${bin}/shows"\n[ "$2" = show ] && [ "$5" = FragmentPath ] && { if [ -e "${bin}/asked" ] && [ -e "${bin}/later" ]; then cat "${bin}/later"; else cat "${bin}/paths"; fi; touch "${bin}/asked"; }\nexit 0\n`, { mode: 0o755 });
  const use = async (options) => {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(teh)});
const { readFile, rename, writeFile } = await import('node:fs/promises');
const options = JSON.parse(process.argv[1]);
let moves = 0;
const move = (from, to) => ++moves === options.failMove ? Promise.reject(new Error('planted move failure')) : rename(from, to);
const result = await m.useInstalledDaemon({ ...options, ms: 1500, move,
  probe: async () => { const h = JSON.parse(await readFile(${JSON.stringify(bin + '/health')}, 'utf8')); if (!h) throw new Error('no answer'); return h; },
  stop: () => writeFile(${JSON.stringify(bin + '/stopped')}, '') });
console.log(JSON.stringify(result));`, JSON.stringify(options)], { env: { ...process.env, HOME: home, PATH: bin + ':' + process.env.PATH }, timeout: 30_000 });
    return JSON.parse(stdout.trim().split('\n').pop());
  };
  const read = (file) => readFile(file, 'utf8').catch(() => null);
  const state = async () => ({ unit: await read(path.join(units, 'p9-foundation.service')), dropins: (await readdir(path.join(units, 'p9-foundation.service.d'))).sort(),
    backups: (await readdir(units)).filter((name) => name.includes('.bak-')), installed: JSON.parse(await read(path.join(bin, 'installed')) ?? 'null'),
    stopped: !!await stat(path.join(bin, 'stopped')).catch(() => null), log: await read(path.join(home, '.local', 'share', 'p9', 'service-install.log')) ?? '', calls: (await read(path.join(bin, 'calls')) ?? '').trim().split('\n').filter((c) => c && !c.includes(' show ')) });
  return { use, state, seen, workspace, units, unitText, dropins };
}

test('O135 use installed: refused without the checkout or when the unit changed since the dialog, and nothing is touched', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  for (const [why, options, error] of [['no checkout', (seen) => ({ seen }), 'checkout-required'], ['no ExecStart', () => ({ checkout: '/usr/bin/node x' }), 'checkout-required'],
    ['unit changed', (seen) => ({ checkout: '/usr/bin/node x', seen: seen.replace('8443', '9443') }), 'unit-changed']]) {
    const m = await machine();
    assert.deepEqual(await m.use(options(m.seen)), { error }, why);
    const after = await m.state();
    assert.equal(after.unit, m.unitText, why + ': unit rewritten');
    assert.deepEqual(after.dropins, ['env.conf', 'override.conf'], why + ': drop-ins moved');
    assert.deepEqual([after.backups, after.installed, after.stopped, after.calls], [[], null, false, []], why + ': something ran');
  }
});

test('O135 use installed: an unquoted workspace that is not one clean word, or an ExecStart outside Service, in another case or continued, is refused, even when the cut path is a real folder', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  for (const [name, setup] of [['my --x w', {}], ['my --state w', {}], ['my --remote-port 9443', { phone: false }], ['my $HOME', {}],
    ['ExecStart in [Unit]', { quoted: true, base: () => '[Unit]\nExecStart=/usr/bin/node x\n' + OLD_UNIT }], ['lower-case execstart', { quoted: true, base: () => OLD_UNIT + 'execstart=/usr/bin/node x\n' }],
    ['a continued ExecStart', { quoted: true, base: () => '[Service]\nExecStart=/usr/bin/node \\\n  /srv/src/p9/apps/server/main.mjs\n' }]]) {
    const m = await machine({ name, quoted: false, ...setup });
    assert.deepEqual(await m.use({ checkout: '/usr/bin/node x', seen: m.seen }), { error: 'workspace-unclear' }, name);
    const after = await m.state();
    assert.equal(after.unit, m.unitText, name + ': unit rewritten');
    assert.deepEqual(after.dropins, ['env.conf', 'override.conf'], name + ': drop-ins moved');
    assert.deepEqual([after.backups, after.installed, after.stopped, after.calls], [[], null, false, []], name + ': something ran');
  }
});

test('O135 use installed: an override systemd applies from outside the files read, a unit file other than the one read, no paths from systemctl, a pending daemon-reload or an unlisted ExecStart drop-in is refused, and nothing is touched', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  const runtime = '/run/user/1000/systemd/user/p9-foundation.service.d/50-x.conf';
  const prefix = (workspace) => `[Service]\nExecStart=/usr/bin/node /srv/src/p9/apps/server/main.mjs --workspace ${quote(path.join(path.dirname(workspace), 'my'))} --state %t/p9-foundation --recovery /r\n`;
  for (const [why, setup, error = 'workspace-unclear'] of [['NeedDaemonReload=yes, disk says /my, systemd runs /my w', { name: 'my w', phone: false, local: false, base: prefix, reload: 'yes' }],
    ['no NeedDaemonReload', { reload: null }], ['an unlisted ExecStart drop-in', { paths: (unit, d) => `FragmentPath=${unit}\nDropInPaths=${d.filter((f) => !f.endsWith('override.conf')).join(' ')}\n` }],
    ['a reload pending by the time work would stop', { later: (unit, d) => `FragmentPath=${unit}\nDropInPaths=${d.join(' ')}\nNeedDaemonReload=yes\n` }, 'unit-changed'],
    ['local /my, the active override /my w', { name: 'my w', phone: false, local: false, base: prefix, paths: (unit, d) => `FragmentPath=${unit}\nDropInPaths=${[...d, runtime].join(' ')}\n` }], ['a runtime drop-in', { paths: (unit, d) => `FragmentPath=${unit}\nDropInPaths=${[...d, runtime].join(' ')}\n` }],
    ['a vendor unit file', { paths: (unit, d) => `FragmentPath=/usr/lib/systemd/user/p9-foundation.service\nDropInPaths=${d.join(' ')}\n` }],
    ['no DropInPaths', { paths: (unit) => `FragmentPath=${unit}\n` }], ['no answer', { paths: () => '' }]]) {
    const m = await machine(setup);
    assert.deepEqual(await m.use({ checkout: '/usr/bin/node x', seen: m.seen }), { error }, why);
    const after = await m.state();
    assert.equal(after.unit, m.unitText, why + ': unit rewritten');
    assert.deepEqual(after.dropins, m.dropins, why + ': drop-ins moved');
    assert.deepEqual([after.backups, after.installed, after.stopped, after.calls], [[], null, false, []], why + ': something ran');
    // Part B: the log says what systemd answered, so a unit file found under another path (a symlinked folder) shows up.
    if (why === 'a vendor unit file') assert.match(after.log, /refused, workspace-unclear: FragmentPath=\/usr\/lib\/systemd\/user\/p9-foundation\.service; DropInPaths=/, 'the log: ' + after.log);
  }
});

test('O135 use installed: the unit is backed up, the ExecStart drop-in moved aside, a quoted workspace with spaces and dashes and the phone flags carried exactly', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  const m = await machine({ name: 'my --remote-port 9443 "x" w' });
  const result = await m.use({ checkout: '/usr/bin/node /srv/src/p9/apps/server/main.mjs', seen: m.seen });
  assert.equal(result.done, true, JSON.stringify(result));
  assert.equal(result.version, '5.0.0');
  const after = await m.state();
  assert.equal(await readFile(result.backup, 'utf8'), m.unitText, 'the backup is the old unit');
  assert.match(after.unit, /p9-launch\.sh/, 'the unit runs the launcher');
  assert.equal(after.dropins.length, 2);
  assert.ok(after.dropins.includes('env.conf') && after.dropins.some((name) => name.startsWith('override.conf.bak-')), 'drop-ins: ' + after.dropins);
  assert.deepEqual(after.installed, [m.workspace, '--remote-port', '8443', '--remote-origin', 'https://phone.example'], 'install-service got the old workspace and phone flags');
  assert.ok(after.stopped, 'running work was not stopped first');
});

test('O135 use installed: a drop-in written ExecStart = (spaced, indented) wins over the base unit: its phone flags are carried and it is moved aside', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  const base = (workspace) => `[Service]\nExecStart=/usr/bin/node /srv/src/p9/apps/server/main.mjs --workspace ${quote(workspace)} --state %t/p9-foundation --recovery /r --remote-port 7443 --remote-origin https://a.example\n`;
  const m = await machine({ base, spaced: true });
  const result = await m.use({ checkout: '/usr/bin/node /srv/src/p9/apps/server/main.mjs', seen: m.seen });
  assert.equal(result.done, true, JSON.stringify(result));
  const after = await m.state();
  assert.deepEqual(after.installed, [m.workspace, '--remote-port', '9443', '--remote-origin', 'https://b.example'], 'the base unit\'s stale phone flags were carried');
  assert.ok(after.dropins.includes('env.conf') && after.dropins.some((name) => name.startsWith('override.conf.bak-')), 'the spaced override was not moved: ' + after.dropins);
  assert.equal(await readFile(result.backup, 'utf8'), m.unitText, 'the backup is the old unit');
});

test('O135 use installed: a failed drop-in move, a failed install or a daemon that never answers with the new version puts the old service back', { skip: process.platform === 'win32', timeout: 60_000 }, async () => {
  for (const [why, setup, error] of [['install fails', { installFails: true }, 'install-failed'], ['old version keeps answering', { health: { version: '4.9.0' } }, 'version-not-answering'],
    ['no answer at all', { health: null }, 'version-not-answering'], ['the second drop-in move fails', { second: true, failMove: 2 }, 'backup-failed']]) {
    const { failMove, ...rest } = setup, m = await machine(rest);
    const result = await m.use({ checkout: '/usr/bin/node /srv/src/p9/apps/server/main.mjs', seen: m.seen, failMove });
    assert.deepEqual([result.error, result.restored], [error, true], why + ': ' + JSON.stringify(result));
    if (failMove) assert.deepEqual([result.reason, (await m.state()).installed], ['planted move failure', null], why + ': not the original error, or install ran');
    const after = await m.state();
    assert.equal(after.unit, m.unitText, why + ': the old unit is not back');
    assert.deepEqual(after.dropins, m.dropins, why + ': the drop-ins are not back');
    assert.deepEqual(after.calls, ['--user daemon-reload', '--user enable p9-foundation.service', '--user restart p9-foundation.service'], why + ': the old service was not reloaded and restarted');
    assert.equal(await readFile(result.backup, 'utf8'), m.unitText, why + ': the backup is kept');
  }
});
