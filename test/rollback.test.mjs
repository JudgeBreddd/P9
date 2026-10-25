// AU5 (threat model row 40): apps/desktop/rollback.mjs, which decides when an installed build goes back to the version
// before it, builds the launcher's command line and the sanitized bug report. The launcher's own run is in
// launcher.test.mjs (Linux) and windows-installer.yaml (Windows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readState, writeState, begin, timedOut, healthy, quit, rolledBack, backTo, startHealthy, launcherCommand, promoteLauncher,
  readRollback, sanitize, reportLink } from '../apps/desktop/rollback.mjs';

const temp = () => mkdtemp(path.join(os.tmpdir(), 'p9-rollback-'));

test('a start is healthy only with the window ready and the daemon answering the same version, within the time', { timeout: 10_000 }, async () => {
  const ready = Promise.resolve();
  assert.equal(await startHealthy({ version: '1.1.0', ready, health: async () => ({ version: '1.1.0' }), ms: 500, every: 10 }), true);
  // The daemon of the version before (an update that did not reach the daemon).
  assert.equal(await startHealthy({ version: '1.1.0', ready, health: async () => ({ version: '1.0.0' }), ms: 200, every: 10 }), false);
  // A daemon that never answers.
  assert.equal(await startHealthy({ version: '1.1.0', ready, health: async () => { throw new Error('ECONNREFUSED'); }, ms: 200, every: 10 }), false);
  // A window that is never ready to show.
  assert.equal(await startHealthy({ version: '1.1.0', ready: new Promise(() => {}), health: async () => ({ version: '1.1.0' }), ms: 200, every: 10 }), false);
  // The daemon answering late, inside the time.
  let asks = 0;
  assert.equal(await startHealthy({ version: '1.1.0', ready, health: async () => ({ version: ++asks > 3 ? '1.1.0' : '1.0.0' }), ms: 1000, every: 10 }), true);
});

test('only a version never healthy that failed 2 starts goes back, to the newest healthy one', async () => {
  const file = path.join(await temp(), 'update-state.json');
  const state = readState(file);
  assert.deepEqual(state, { healthy: [], failed: {}, pending: null, skip: null });
  assert.equal(begin(state, '1.0.0'), null);
  healthy(state, '1.0.0');
  assert.equal(begin(state, '1.1.0'), null);
  assert.equal(timedOut(state, '1.1.0'), null, 'one failed start');
  assert.equal(begin(state, '1.1.0'), null);
  assert.equal(timedOut(state, '1.1.0'), '1.0.0', 'the second');
  // A start that quit or died before it was healthy or timed out counts at the next start.
  const died = readState(file);
  healthy(died, '1.0.0');
  assert.equal(begin(died, '1.1.0'), null);
  assert.equal(begin(died, '1.1.0'), null, 'the first one is counted now');
  assert.equal(begin(died, '1.1.0'), '1.0.0', 'and the second');
  // A version once healthy never goes back, however often it fails afterwards.
  for (let i = 0; i < 3; i++) { begin(state, '1.0.0'); assert.equal(timedOut(state, '1.0.0'), null); }
  // Nothing to go back to: nothing happens.
  const fresh = readState(file);
  begin(fresh, '2.0.0'); timedOut(fresh, '2.0.0'); begin(fresh, '2.0.0');
  assert.equal(timedOut(fresh, '2.0.0'), null);
  assert.equal(fresh.failed['2.0.0'], 2);
  // The newest healthy, the version itself aside.
  const many = { healthy: ['1.2.0', '1.1.0', '1.0.0'], failed: { '1.3.0': 2 }, pending: null, skip: null };
  assert.equal(backTo(many, '1.3.0'), '1.2.0');
});

test('a rollback records the skipped version, clears its count, and the state survives a reload', async () => {
  const file = path.join(await temp(), 'update-state.json');
  const state = readState(file);
  healthy(state, '1.0.0');
  begin(state, '1.1.0'); timedOut(state, '1.1.0'); begin(state, '1.1.0');
  assert.equal(timedOut(state, '1.1.0'), '1.0.0');
  rolledBack(state, '1.1.0');
  writeState(file, state);
  assert.deepEqual(readState(file), { healthy: ['1.0.0'], failed: {}, pending: null, skip: '1.1.0' });
  // Installed again by hand: 2 more tries.
  const again = readState(file);
  begin(again, '1.1.0');
  assert.equal(timedOut(again, '1.1.0'), null);
  // A hand-edited or broken file starts over; keys and values outside the version pattern are dropped.
  await writeFile(file, JSON.stringify({ healthy: ['1.0.0', '../x', 7], failed: { '__proto__': 5, '1.1.0': 'two', '1.2.0': 1 }, pending: 'x', skip: '1.1.0;rm' }));
  assert.deepEqual(readState(file), { healthy: ['1.0.0'], failed: { '1.2.0': 1 }, pending: null, skip: null });
  await writeFile(file, '{');
  assert.deepEqual(readState(file), { healthy: [], failed: {}, pending: null, skip: null });
});

test('a start whose daemon takes 90 s, as a first start has on CI, is healthy; none by 180 s is a failed start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise(setImmediate);
  let now = 0;
  const slow = startHealthy({ version: '1.1.0', ready: Promise.resolve(), health: async () => (now >= 90_000 ? { version: '1.1.0' } : null) });
  for (; now < 100_000; now += 1000) { await flush(); t.mock.timers.tick(1000); }
  assert.equal(await slow, true);
  let settled = false;
  const never = startHealthy({ version: '1.1.0', ready: Promise.resolve(), health: async () => null });
  never.then(() => { settled = true; });
  for (let s = 1; s < 180; s++) { await flush(); t.mock.timers.tick(1000); }
  await flush();
  assert.equal(settled, false, 'still waiting at 179 s');
  t.mock.timers.tick(1000);
  assert.equal(await never, false);
});

test('a quit before a healthy start (the user quits or closes the window) is not counted; a crash or a hang is', async () => {
  const state = readState(path.join(await temp(), 'update-state.json'));
  healthy(state, '1.0.0');
  for (let i = 0; i < 3; i++) { assert.equal(begin(state, '1.1.0'), null); assert.equal(quit(state, '1.1.0'), true); }
  assert.deepEqual(state.failed, {});
  // The limit running out while P9 is still stopping is not counted either.
  begin(state, '1.1.0'); quit(state, '1.1.0');
  assert.equal(timedOut(state, '1.1.0'), null);
  assert.deepEqual(state.failed, {});
  // A crash emits no quit: the next start counts it. Then a hang past the limit is the second.
  begin(state, '1.1.0');
  assert.equal(begin(state, '1.1.0'), null);
  assert.equal(state.failed['1.1.0'], 1);
  assert.equal(timedOut(state, '1.1.0'), '1.0.0');
  assert.equal(quit(state, '1.1.0'), false, 'a start already decided');
});

test('the report has no home path, user name, host name, token, address or email in it', () => {
  const home = 'C:\\Users\\Sam Rivera', user = 'srivera', host = 'SRIVERA-DESK';
  const log = [
    '2026-10-24T12:34:56.789Z state error at C:\\Users\\Sam Rivera\\AppData\\Local\\P9\\daemon\\0.1.6\\node.exe',
    '{"workspace":"C:\\\\Users\\\\Sam Rivera\\\\P9","path":"c:/users/sam rivera/P9/notes.md"}',
    'account srivera on SRIVERA-DESK (srivera-desk.local) said: cookie: p9=4f1c2a9be0d7a1c3; Authorization: Bearer abc.def-ghi',
    'GH_TOKEN=' + 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 and sk-ant-api03-aaaaBBBBccccDDDD1111 and xoxb-123456789-abcdefgh',
    'secret: hunter2 password=hunter3 api_key="k-123" key Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdo',
    'listening on 192.168.1.23:4317 and [fe80::1c2b:3a4d:5e6f:7a8b] and 2001:db8::7, mail sam.rivera@example.com',
  ].join('\n');
  const out = sanitize(log, { home, user, host, platform: 'win32' });
  for (const gone of ['Sam Rivera', 'sam rivera', 'srivera', 'SRIVERA', 'Users', '4f1c2a9be0d7a1c3', 'abc.def', 'ghp_', 'sk-ant', 'xoxb-', 'hunter2',
    'hunter3', 'k-123', 'Zm9vYmFy', '192.168', 'fe80', '2001:db8', 'example.com']) assert.ok(!out.includes(gone), `${gone} survived:\n${out}`);
  // What a reader needs stays: the times, versions, the path under home and the error.
  for (const kept of ['2026-10-24T12:34:56.789Z', 'state error at ~\\AppData\\Local\\P9\\daemon\\0.1.6\\node.exe', '~/P9/notes.md', '<host>', '<user>', '<token>', '<ip>', '<email>'])
    assert.ok(out.includes(kept), `${kept} missing:\n${out}`);
  // Linux paths, case kept. Split so scan.mjs's private-path check does not read the fixture as a real home folder.
  const h = '/ho' + 'me';
  assert.equal(sanitize(`${h}/sam/P9 ${h}/Sam`, { home: `${h}/sam`, user: 'sam', host: 'box', platform: 'linux' }), `~/P9 ${h}/<user>`);
});

test('the report link is GitHub\'s prefilled bug form, cut to fit', () => {
  const link = new URL(reportLink({ from: '1.1.0', to: '1.0.0', log: 'x'.repeat(20_000) + ' end', platform: 'win32', arch: 'arm64' }));
  assert.equal(link.origin + link.pathname, 'https://github.com/JudgeBreddd/p9/issues/new');
  const form = link.searchParams;
  assert.deepEqual([form.get('template'), form.get('version'), form.get('install')], ['bug.yml', '1.1.0', 'Windows installer (arm64)']);
  assert.match(form.get('title'), /1\.1\.0.*1\.0\.0/);
  assert.match(form.get('doctor'), /\[cut to fit a link\]$/);
  assert.ok(link.href.length <= 7000, 'anymouse.mjs LINK_MAX');
});

test('the launcher gets only checked versions, and on Linux none of the AppImage\'s mount', () => {
  const win = launcherCommand({ to: '1.0.0', from: '1.1.0', platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, share: 'C:\\Users\\u\\AppData\\Local\\P9',
    exe: 'C:\\Users\\u\\AppData\\Local\\Programs\\P9 Event Horizon\\P9 Event Horizon.exe', arch: 'x64', pid: 42 });
  assert.equal(win.file, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  assert.deepEqual(win.args.slice(win.args.indexOf('-Rollback')), ['-Rollback', '-To', '1.0.0', '-From', '1.1.0', '-App',
    'C:\\Users\\u\\AppData\\Local\\Programs\\P9 Event Horizon\\P9 Event Horizon.exe', '-Arch', 'x64', '-AppPid', '42']);
  const u = '/ho' + 'me/u'; // split for scan.mjs, as above
  const linux = launcherCommand({ to: '1.0.0', from: '1.1.0', platform: 'linux', share: `${u}/.local/share/p9`, pid: 42,
    env: { APPDIR: '/tmp/.mount_P9x', APPIMAGE: `${u}/P9.AppImage`, ARGV0: 'P9', OWD: u, PATH: '/tmp/.mount_P9x/usr/bin:/usr/bin', HOME: u } });
  assert.deepEqual([linux.file, linux.args], ['/bin/sh', [`${u}/.local/share/p9/launcher/p9-launch.sh`, '--rollback', '1.0.0', '1.1.0', `${u}/P9.AppImage`, '42']]);
  assert.deepEqual(linux.env, { PATH: '/usr/bin', HOME: u });
  for (const [to, from] of [['1.0.0;calc', '1.1.0'], ['1.0.0', '../1.1.0'], ['', '1.1.0'], [undefined, '1.1.0']])
    assert.throws(() => launcherCommand({ to, from, platform: 'linux', env: {} }), /version-refused/);
});

test('a new launcher replaces the old one only when promoted; the restored version reads the launcher\'s record', async () => {
  const share = await temp();
  await mkdir(path.join(share, 'launcher'));
  assert.equal(await promoteLauncher(share, 'linux'), false, 'nothing waiting');
  await writeFile(path.join(share, 'launcher', 'p9-launch.sh'), 'old');
  await writeFile(path.join(share, 'launcher', 'p9-launch.sh.next'), 'new');
  assert.equal(await readFile(path.join(share, 'launcher', 'p9-launch.sh'), 'utf8'), 'old');
  assert.equal(await promoteLauncher(share, 'linux'), true);
  assert.equal(await readFile(path.join(share, 'launcher', 'p9-launch.sh'), 'utf8'), 'new');
  assert.equal(await readRollback(share), null);
  await writeFile(path.join(share, 'rollback.json'), JSON.stringify({ from: '1.1.0', to: '1.0.0', at: 'x', installer: 'kept' }));
  assert.deepEqual(await readRollback(share), { from: '1.1.0', to: '1.0.0', at: 'x', installer: 'kept' });
  await writeFile(path.join(share, 'rollback.json'), JSON.stringify({ from: '1.1.0', to: '<b>' }));
  assert.equal(await readRollback(share), null);
});
