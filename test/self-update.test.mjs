// The server updates itself on connect (item 14, spec tunnel-file-transfer.md checks 1 and 6, threat model row 62).
// Throwaway daemons in throwaway homes, each pointed (--update-root) at a stand-in checkout in its own temp folder, with
// stand-in pnpm and systemd-run first on PATH: nothing builds for real and no service restarts. The swap script runs
// directly against a tiny daemon that a stand-in systemctl restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http2 from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { daemon, remoteDaemon, http, authenticated, root, passkeyDevice, enrollDevice } from './helpers.mjs';
import { newer } from '../apps/server/update.mjs';
import { PIECE } from '../apps/server/pieces.mjs';
import { daemonRequest } from '../scripts/teh.mjs';
import { updateServer } from '../apps/desktop/server-update.mjs';

const skip = process.platform === 'win32' ? 'a server update is Linux only (systemd, a source checkout)' : false;
const VERSION = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const bump = (v) => v.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, a, b, c) => a + '.' + b + '.' + (Number(c) + 1));
const NEXT = bump(VERSION);
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const until = async (check, what, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) { const v = await check(); if (v) return v; }
  assert.fail('timed out: ' + what);
};
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...(r.status === 404 ? {} : JSON.parse(r.text)) }));
const sh = async (file, text) => { await writeFile(file, '#!/bin/sh\n' + text); await chmod(file, 0o755); };
const lines = (file) => readFile(file, 'utf8').then((t) => t.trim().split('\n').filter(Boolean), () => []);
// The phase says restarting a moment before the stand-in systemd-run has written its line.
const swapCall = (instance) => until(async () => (await lines(instance.log.run))[0], 'systemd-run called');

// A checkout's few files: what update.mjs checks for. extra: more files (name -> text).
async function tree(folder, version, extra = {}) {
  for (const [name, text] of Object.entries({ 'package.json': JSON.stringify({ name: 'p9', version }), 'pnpm-lock.yaml': '', 'apps/server/main.mjs': '', ...extra })) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), text);
  }
}
// git archive's shape: one top folder (p9/), gzipped.
async function archive(version, extra) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'p9-upd-src-'));
  await tree(path.join(folder, 'p9'), version, extra);
  const file = path.join(folder, 'p9.tar.gz');
  execFileSync('tar', ['-czf', file, '-C', folder, 'p9']);
  const data = await readFile(file);
  return { file, data, sha256: createHash('sha256').update(data).digest('hex') };
}

// A daemon whose update root is a stand-in checkout of its own version, with stand-in pnpm and systemd-run.
async function server(t, { remote = false, args = [] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-upd-'));
  const source = path.join(directory, 'share', 'source'), bin = path.join(directory, 'bin');
  await tree(source, VERSION);
  await mkdir(bin);
  const log = { pnpm: path.join(directory, 'pnpm.log'), run: path.join(directory, 'systemd-run.log') };
  // pnpm: notes each call and marks the tree built; a tree with a fail-build file fails.
  await sh(path.join(bin, 'pnpm'), `echo "$PWD $*" >> '${log.pnpm}'\n[ -e fail-build ] && { echo 'build broke' >&2; exit 1; }\necho built > built-$1\n`);
  // systemd-run: notes its argv (the swap command) and starts nothing.
  await sh(path.join(bin, 'systemd-run'), `printf '%s\\n' "$*" >> '${log.run}'\n`);
  // Settings as mission.test.mjs's teammate has them, so the phone's Mission tab answers.
  const setup = async ({ directory: home, workspace }) => {
    for (const folder of ['_waiting', 'hub', 'projects']) await mkdir(path.join(workspace, folder));
    await writeFile(path.join(workspace, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n');
    await writeFile(path.join(home, 'settings.json'), JSON.stringify({ waiting: '_waiting', registry: 'hub/registry.json', primary: 'projects/AGENTS.md' }));
    return { path: bin + path.delimiter + process.env.PATH, env: { INVOCATION_ID: 'test' },
      args: ['--acp-override', fake, '--update-root', source, '--settings', path.join(home, 'settings.json'), ...args] };
  };
  const instance = remote ? await remoteDaemon(t, { setup }) : await daemon(t, undefined, false, setup);
  return { ...instance, source, share: path.dirname(source), log };
}
async function push(instance, pushed, version, id = randomUUID()) {
  for (let offset = 0; offset < pushed.data.length; offset += PIECE) {
    const sent = await call(instance, '/update/' + id + '/part', 'POST', { offset, data: pushed.data.subarray(offset, offset + PIECE).toString('base64') });
    assert.equal(sent.status, 200, JSON.stringify(sent));
  }
  return call(instance, '/update/' + id + '/commit', 'POST', { version, bytes: pushed.data.length, sha256: pushed.sha256 });
}
const job = async (instance) => (await call(instance, '/update/status')).job;
const leftovers = async (instance) => (await readdir(instance.share)).filter((name) => name !== 'source');

test('update: semver order, a pre-release below its release', () => {
  assert.ok(newer('0.1.7', '0.1.6') && newer('0.2.0', '0.1.9') && newer('1.0.0', '0.9.9') && newer('0.1.10', '0.1.9'));
  assert.ok(newer('0.1.6', '0.1.6-rc.1') && newer('0.1.6-rc.2', '0.1.6-rc.1') && newer('0.1.6-rc.10', '0.1.6-rc.9') && newer('0.1.6-rc.1.1', '0.1.6-rc.1'));
  assert.ok(!newer('0.1.6', '0.1.6') && !newer('0.1.5', '0.1.6') && !newer('0.1.6-rc.1', '0.1.6') && !newer('x', '0.1.6') && !newer('0.1.7', 'x'));
});

test('update check 1: every /update route needs the desktop cookie and is not on the phone listener', { skip, timeout: 60000 }, async (t) => {
  const instance = await server(t, { remote: true });
  const ROUTES = [['POST', '/update/' + randomUUID() + '/part', { offset: 0, data: '' }], ['POST', '/update/' + randomUUID() + '/commit', { version: NEXT }],
    ['POST', '/update/fetch', { version: NEXT }], ['GET', '/update/status']];
  for (const [method, route, body] of ROUTES) {
    const anonymous = await http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
      headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    assert.equal(anonymous.status, 401, method + ' ' + route + ' without the cookie');
  }
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const session = await enrollDevice(instance, await passkeyDevice(browser, instance, 'phone'));
  for (const [method, route, body] of ROUTES) {
    const phone = await instance.remote(route, { method, session, body, headers: { 'x-p9-op': randomUUID() } });
    assert.equal(phone.status, 404, method + ' ' + route + ' on the phone listener');
  }
  const status = await call(instance, '/update/status');
  assert.equal(status.status, 200);
  assert.deepEqual([status.version, status.supported], [VERSION, true]);
  assert.deepEqual(await lines(instance.log.run), []);
});

test('update check 6: the same or an older version is refused on every route, and nothing is unpacked', { skip, timeout: 60000 }, async (t) => {
  const instance = await server(t);
  const older = VERSION.replace(/^(\d+)\.(\d+)\.\d+.*$/, (_, a, b) => a + '.' + b + '.0-rc.1');
  for (const version of [VERSION, older, '0.0.1']) {
    const pushed = await push(instance, await archive(version), version);
    assert.deepEqual([pushed.status, pushed.error, pushed.version], [409, 'not-newer', VERSION], version);
    const fetched = await call(instance, '/update/fetch', 'POST', { version });
    assert.deepEqual([fetched.status, fetched.error], [409, 'not-newer'], version);
  }
  assert.equal((await call(instance, '/update/fetch', 'POST', { version: 'v' + NEXT })).status, 400);
  assert.equal(await job(instance), undefined);
  assert.deepEqual(await leftovers(instance), []);
  assert.deepEqual([await lines(instance.log.pnpm), await lines(instance.log.run)], [[], []]);
  assert.equal(JSON.parse(await readFile(path.join(instance.source, 'package.json'), 'utf8')).version, VERSION);
});

test('update: a newer version builds beside the checkout, waits for the turn, then holds new starts and hands over to the swap', { skip, timeout: 60000 }, async (t) => {
  const instance = await server(t);
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'slow' })).status, 202);
  await until(async () => (await call(instance, '/chat')).conversations.find((c) => c.id === id).state === 'turn', 'the slow turn started');
  const deps = 'export async function ensureDependencies() { console.log("placing"); return { placed: ["git"], missing: [{ id: "tmux", why: "terminals", command: "sudo apt install tmux" }] }; }\n';
  const pushed = await push(instance, await archive(NEXT, { 'scripts/deps.mjs': deps }), NEXT);
  assert.equal(pushed.status, 202, JSON.stringify(pushed));
  const waiting = await until(async () => { const j = await job(instance); return j?.phase === 'waiting-turns' && j; }, 'waiting for the turn');
  assert.equal(waiting.turns, 1);
  assert.deepEqual(waiting.missing, [{ id: 'tmux', why: 'terminals', command: 'sudo apt install tmux' }]);
  const next = path.join(instance.share, 'source.new-' + pushed.id);
  assert.ok(existsSync(path.join(next, 'built-install')) && existsSync(path.join(next, 'built-build')), 'built in the new tree');
  assert.deepEqual((await lines(instance.log.pnpm)).map((l) => l.split(' ').slice(1).join(' ')), ['install --frozen-lockfile --ignore-scripts', 'build']);
  assert.equal(JSON.parse(await readFile(path.join(instance.source, 'package.json'), 'utf8')).version, VERSION, 'the running checkout untouched');
  const mission = await call(instance, '/mission');
  assert.deepEqual([mission.status, mission.update], [200, { phase: 'waiting-turns', version: NEXT, turns: 1 }], JSON.stringify(mission));
  // A second update meanwhile is refused; the turn keeps running for 2 more polls and nothing restarts.
  assert.equal((await call(instance, '/update/fetch', 'POST', { version: bump(NEXT) })).error, 'update-running');
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.deepEqual(await lines(instance.log.run), []);
  assert.equal((await call(instance, '/chat/' + id + '/stop', 'POST')).status, 200);
  await until(async () => (await job(instance))?.phase === 'restarting', 'the swap started');
  const swap = await swapCall(instance);
  assert.match(swap, new RegExp('^--user --unit p9-update-' + pushed.id.slice(0, 8) + ' --collect --quiet -- \\S+ \\S+/scripts/update-swap\\.mjs --root ' + instance.source
    + ' --next ' + next + ' --version ' + NEXT + ' --from ' + VERSION + ' --id ' + pushed.id + ' '));
  // Held: a message now would start a turn the restart cuts off.
  const refused = await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  assert.deepEqual([refused.status, refused.error], [503, 'updating']);
});

test('update: a failed build removes the new tree, the old checkout runs on, and starts are not held', { skip, timeout: 60000 }, async (t) => {
  const instance = await server(t);
  const pushed = await push(instance, await archive(NEXT, { 'fail-build': '' }), NEXT);
  assert.equal(pushed.status, 202);
  const failed = await until(async () => { const j = await job(instance); return j?.phase === 'failed' && j; }, 'the build failed');
  assert.equal(failed.error, 'build-failed');
  assert.match(failed.logTail, /build broke/);
  assert.deepEqual(await leftovers(instance), []);
  assert.deepEqual(await lines(instance.log.run), []);
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  assert.equal((await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' })).status, 202);
  // A tarball whose package.json names another version than the commit said is refused before any build.
  const lying = await push(instance, await archive(bump(NEXT)), NEXT);
  assert.equal(lying.status, 202);
  assert.equal((await until(async () => { const j = await job(instance); return j?.phase === 'failed' && j.id === lying.id && j; }, 'refused')).error, 'version-mismatch');
  assert.equal((await lines(instance.log.pnpm)).length, 1);
});

test('update: a packaged app has the server download its version; a missing release fails cleanly', { skip, timeout: 60000 }, async (t) => {
  const pushed = await archive(NEXT);
  const asked = [];
  const site = http2.createServer((req, res) => { asked.push(req.url); req.url === '/v' + NEXT + '.tar.gz' ? res.end(pushed.data) : res.writeHead(404).end(); });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => site.close());
  const instance = await server(t, { args: ['--update-archive', 'http://127.0.0.1:' + site.address().port + '/'] });
  const started = await call(instance, '/update/fetch', 'POST', { version: NEXT });
  assert.equal(started.status, 202, JSON.stringify(started));
  await until(async () => (await job(instance))?.phase === 'restarting', 'downloaded, built and handed over');
  assert.deepEqual(asked, ['/v' + NEXT + '.tar.gz']);
  await swapCall(instance);
  assert.equal((await lines(instance.log.run)).length, 1);
});

test('update: a missing release fails as download-failed and nothing is built', { skip, timeout: 60000 }, async (t) => {
  const site = http2.createServer((req, res) => res.writeHead(404).end());
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => site.close());
  const instance = await server(t, { args: ['--update-archive', 'http://127.0.0.1:' + site.address().port + '/'] });
  assert.equal((await call(instance, '/update/fetch', 'POST', { version: NEXT })).status, 202);
  const failed = await until(async () => { const j = await job(instance); return j?.phase === 'failed' && j; }, 'failed');
  assert.deepEqual([failed.error, failed.detail], ['download-failed', 'HTTP 404']);
  assert.deepEqual([await lines(instance.log.pnpm), await leftovers(instance)], [[], []]);
});

// The laptop's half (apps/desktop/server-update.mjs) against a real daemon: check() is the tunnel's /health.
const laptop = (instance, options) => {
  const events = [];
  const check = () => daemonRequest(instance.state, 'GET', '/health').then((r) => r.body);
  return { events, run: () => updateServer({ state: instance.state, check, host: 'test', tell: (event) => { events.push(event); }, ...options }) };
};

test('update, laptop: an app older than its server is told so and never starts an update', { skip, timeout: 60000 }, async (t) => {
  const instance = await server(t);
  const { events, run } = laptop(instance, { version: '0.0.1', checkout: root });
  assert.equal((await run()).phase, 'app-older');
  assert.deepEqual(events, [{ phase: 'app-older', host: 'test', server: VERSION, app: '0.0.1' }]);
  assert.deepEqual([(await call(instance, '/update/status')).job ?? null, await lines(instance.log.pnpm), await leftovers(instance)], [null, [], []]);
});

test('update, laptop: a checkout one version ahead pushes its HEAD and follows the server to the restart', { skip, timeout: 60000 }, async (t) => {
  const instance = await server(t);
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'p9-upd-checkout-'));
  await tree(checkout, NEXT);
  const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'next');
  // Uncommitted edits are not sent: the server builds HEAD.
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({ name: 'p9', version: bump(NEXT) }));
  let stop = false;
  const { events, run } = laptop(instance, { version: NEXT, checkout, live: () => !stop });
  const following = run();
  await until(() => events.some((e) => e.phase === 'restarting'), 'the laptop saw the restart', 30000);
  stop = true;
  assert.equal((await following).phase, 'left');
  assert.equal(events.at(-1).phase, 'restarting');
  assert.ok(events.every((e) => ['building', 'waiting-turns', 'restarting'].includes(e.phase) && e.version === NEXT), JSON.stringify(events));
  const commit = git('rev-parse', 'HEAD').toString().trim();
  assert.equal((await call(instance, '/update/status')).job.commit, commit);
  assert.match(await swapCall(instance), new RegExp(' --version ' + NEXT.replace(/\./g, '\\.') + ' '));
});

// The swap against a tiny daemon: answers /health on <state>/daemon.sock with its tree's version, or exits at once when
// its tree has a "broken" file. The stand-in systemctl restarts it from whatever the root folder holds now.
const TINY = `import { createServer } from 'node:http'; import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
const [state] = process.argv.slice(2), here = new URL('.', import.meta.url).pathname;
if (existsSync(here + 'broken')) process.exit(1);
const version = JSON.parse(readFileSync(here + 'package.json', 'utf8')).version;
rmSync(state + '/daemon.sock', { force: true });
writeFileSync(state + '/desktop.json', JSON.stringify({ cookie: 'c', csrf: 'x', socketPath: state + '/daemon.sock' }));
createServer((req, res) => res.end(req.headers.cookie === 'p9=c' ? JSON.stringify({ version }) : '{}')).listen(state + '/daemon.sock');
`;
async function swapStage(t, { broken = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-swap-'));
  const source = path.join(directory, 'source'), next = path.join(directory, 'source.new-x'), state = path.join(directory, 'state'), bin = path.join(directory, 'bin');
  await tree(source, VERSION, { 'tiny.mjs': TINY });
  await tree(next, NEXT, { 'tiny.mjs': TINY, ...(broken ? { broken: '' } : {}) });
  await mkdir(state); await mkdir(bin);
  const pid = path.join(directory, 'pid'), log = path.join(directory, 'systemctl.log');
  await sh(path.join(bin, 'systemctl'), `echo "$*" >> '${log}'\n[ -e '${pid}' ] && kill "$(cat '${pid}')" 2>/dev/null\n`
    + `'${process.execPath}' '${source}/tiny.mjs' '${state}' </dev/null >/dev/null 2>&1 &\necho $! > '${pid}'\n`);
  t.after(() => { try { process.kill(Number(execFileSync('cat', [pid]).toString())); } catch {} });
  // The old one running, as the service would be.
  execFileSync(path.join(bin, 'systemctl'), ['--user', 'start', 'test'], { env: process.env });
  const result = path.join(directory, 'result.json');
  const run = () => new Promise((resolve) => spawn(process.execPath, [path.join(root, 'scripts/update-swap.mjs'), '--root', source, '--next', next, '--version', NEXT,
    '--from', VERSION, '--id', 'job', '--state', state, '--result', result, '--service', 'p9-test', '--wait', '5000'],
  { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, stdio: 'ignore' }).on('exit', resolve));
  return { directory, source, next, result, log, run };
}
const versionOf = async (folder) => JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')).version;

test('update swap: the new tree starts healthy, and the old checkout is kept as .previous', { skip, timeout: 60000 }, async (t) => {
  const stage = await swapStage(t);
  // A .previous from an earlier update is replaced only once this one is healthy.
  await tree(stage.source + '.previous', '0.0.9');
  await stage.run();
  const result = JSON.parse(await readFile(stage.result, 'utf8'));
  assert.deepEqual([result.ok, result.id, result.version, result.from], [true, 'job', NEXT, VERSION], JSON.stringify(result));
  assert.deepEqual([await versionOf(stage.source), await versionOf(stage.source + '.previous')], [NEXT, VERSION]);
  assert.deepEqual((await readdir(stage.directory)).filter((n) => n.startsWith('source')).sort(), ['source', 'source.previous']);
  assert.deepEqual(await lines(stage.log), ['--user start test', '--user restart p9-test']);
});

test('update swap: a new tree that does not start goes aside and the old checkout comes back and answers', { skip, timeout: 60000 }, async (t) => {
  const stage = await swapStage(t, { broken: true });
  await tree(stage.source + '.previous', '0.0.9');
  await stage.run();
  const result = JSON.parse(await readFile(stage.result, 'utf8'));
  assert.deepEqual([result.ok, result.rolledBack, result.reason], [false, true, 'start-failed'], JSON.stringify(result));
  assert.equal(await versionOf(stage.source), VERSION);
  assert.equal(await versionOf(stage.source + '.previous'), '0.0.9', 'the earlier kept copy is back as it was');
  assert.equal(await versionOf(path.join(stage.directory, result.failed)), NEXT);
  assert.ok(result.failed.startsWith('source.failed-' + NEXT + '-'));
  assert.deepEqual(await lines(stage.log), ['--user start test', '--user restart p9-test', '--user restart p9-test']);
});
