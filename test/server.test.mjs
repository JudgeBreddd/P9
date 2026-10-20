import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import net from 'node:net';
import { createListener } from '../apps/server/server.mjs';
import { planLimits } from '../apps/server/limits.mjs';
import { openLedger } from '../apps/server/ledger.mjs';
import { limitLine } from '../apps/web/src/helpers.mjs';
import { ROUTES } from '../packages/protocol/index.mjs';
import { daemon, http, authenticated, root } from './helpers.mjs';

function upgrade(target, headers, route = '/terminals') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target);
    socket.setTimeout(2000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.once('connect', () => socket.write(`GET ${route} HTTP/1.1\r\nHost: p9.local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n'));
    let output = '';
    socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve(Number(output.split(' ')[1])));
  });
}

test('real daemon: owner permissions, full-route login matrix, origin, CSRF and upgrades', async (t) => {
  const instance = await daemon(t);
  const socketPath = path.join(instance.state, 'daemon.sock');
  const headers = authenticated(instance.credentials);
  assert.equal((await lstat(instance.state)).mode & 0o777, 0o700);
  for (const name of ['desktop.json', 'daemon.sock']) assert.equal((await lstat(path.join(instance.state, name))).mode & 0o777, 0o600);
  for (const route of [...ROUTES, '/unknown', '/files?path=note.txt']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE']) {
      assert.equal((await http({ socketPath, route, method })).status, 401, `${method} ${route}`);
      assert.equal((await http({ socketPath, route, method, headers: { ...headers, origin: 'https://hostile.invalid' } })).status, 403);
    }
    assert.equal(await upgrade(socketPath, {}, route), 401);
    assert.equal(await upgrade(socketPath, { cookie: headers.cookie, origin: 'https://hostile.invalid' }, route), 403);
  }
  assert.equal(await upgrade(socketPath, {}), 401);
  assert.equal(await upgrade(socketPath, { cookie: headers.cookie, origin: 'https://hostile.invalid' }), 403);
  assert.equal(await upgrade(socketPath, { cookie: headers.cookie, origin: headers.origin }), 403);
  assert.equal(await upgrade(socketPath, { cookie: headers.cookie, origin: headers.origin, 'x-p9-csrf': headers['x-p9-csrf'] }), 404); // Phase 10: only /terminals/:id/socket upgrades.
  const noOrigin = { ...headers };
  delete noOrigin.origin;
  assert.equal((await http({ socketPath, headers: noOrigin })).status, 403);
  const read = await http({ socketPath, headers, route: '/files?path=note.txt' });
  assert.equal(JSON.parse(read.text).content, 'original');
  assert.equal((await http({ socketPath, headers: { ...headers, 'x-p9-csrf': 'wrong' }, route: '/files', method: 'PUT' })).status, 403);
  assert.equal((await http({ socketPath, headers: { ...headers, host: 'hostile.invalid' } })).status, 403);
  assert.equal((await http({ socketPath, headers: { ...headers, cookie: 'p9=' + 'é'.repeat(64) } })).status, 401);
  assert.equal((await http({ socketPath, headers: { ...headers, cookie: headers.cookie + '; ' + headers.cookie } })).status, 401);
  assert.equal((await http({ socketPath, headers })).status, 200);

  const tcp = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' });
  assert.equal(tcp.includes(`pid=${instance.child.pid},`), false, 'production has no TCP listener');
  const unix = execFileSync('ss', ['-lxnpH'], { encoding: 'utf8' });
  const owned = unix.split('\n').filter((line) => line.includes(`pid=${instance.child.pid},`));
  assert.equal(owned.length, 1);
  assert.ok(owned[0].includes(socketPath));
  const duplicate = spawnSync(process.execPath, ['--import', './test/home-fixture.mjs', 'apps/server/main.mjs', '--workspace', instance.workspace, '--state', instance.state, '--recovery', instance.recovery],
    { cwd: root, env: { PATH: process.env.PATH, P9_TEST_HOME: instance.directory, XDG_STATE_HOME: instance.directory } });
  assert.equal(duplicate.status, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(instance.state, 'desktop.json'), 'utf8')), instance.credentials);
  assert.equal((await http({ socketPath, headers })).status, 200);
  console.log('PASS listener sweep: ss TCP=0 Unix=1; route/method 401, hostile origin 403, CSRF and WS, duplicate daemon safe');
});

test('isolated dormant remote transport rejects cookie and forged proxy identity', async (t) => {
  const credentials = { cookie: 'fixture-cookie', csrf: 'fixture-csrf' };
  const server = createListener({ workspace: '.', credentials, transport: 'remote' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  for (const route of [...ROUTES, '/unknown']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE']) {
      const result = await http({ port, route, method, headers: { ...authenticated(credentials),
        'tailscale-user-login': 'owner@example.invalid', 'tailscale-user-name': 'Owner', 'x-forwarded-for': '127.0.0.1' } });
      assert.equal(result.status, 401);
    }
    assert.equal(await upgrade({ port, host: '127.0.0.1' }, { cookie: 'p9=fixture-cookie' }, route), 401);
  }
  assert.equal(await upgrade({ port, host: '127.0.0.1' }, { cookie: 'p9=fixture-cookie' }), 401);
  console.log('PASS remote isolation: desktop cookie, forged Tailscale identity and upgrades all 401; fixture listener only');
});

test('plan limits: missing sources give null, the newer Claude source wins, nothing is estimated', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-limits-'));
  assert.deepEqual(await planLimits({ home }), { claude: null, codex: null });
  assert.deepEqual(limitLine('Codex', null), { name: 'Codex', text: 'no plan limits recorded yet', stale: true });
  const statusLine = path.join(home, 'status.json');
  // Reset times ahead of now: a reading whose window has already reset is not shown (the fixed times here expired 2026-10-18).
  const at = (hours) => Math.floor(Date.now() / 1000) + hours * 3600, fiveAt = at(3), weekAt = at(72);
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 7200000, utilization: { five_hour: { utilization: 80, resets_at: null } } } }));
  await writeFile(statusLine, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: at(2) } } }));
  let limits = await planLimits({ home, statusLine });
  assert.equal(limits.claude.fiveHour.usedPercent, 5, 'the status line written just now beats the 2 h old cache');
  assert.equal(limits.claude.sevenDay, null);
  await utimes(statusLine, new Date(Date.now() - 86400000), new Date(Date.now() - 86400000));
  limits = await planLimits({ home, statusLine });
  assert.equal(limits.claude.fiveHour.usedPercent, 80);
  assert.match(limitLine('Claude', limits.claude).text, /^5 h 80% · week n\/a · 2 h old$/);
  assert.equal(limitLine('Claude', limits.claude).stale, true);
  // A P9 Claude chat's reading a minute old beats the 2 h old cache; the ledger hands over the newest one it holds.
  const ledger = openLedger(path.join(home, 'ledger.db')), meta = (five, week) => ({ sessionUpdate: 'usage_update', used: 1, size: 10,
    _meta: { '_claude/rateLimit': { status: 'allowed', unifiedWindows: { five_hour: { utilization: five, resetsAt: fiveAt }, seven_day: { utilization: week, resetsAt: weekAt } } } } });
  ledger.append('c1', 'update', meta(0.3, 0.2)); ledger.append('c1', 'update', meta(0.36, 0.25));
  limits = await planLimits({ home, statusLine, claudeLive: ledger.usage().claudeLive });
  assert.deepEqual([limits.claude.fiveHour, limits.claude.sevenDay.usedPercent], [{ usedPercent: 36, resetsAt: fiveAt * 1000 }, 25]);
  assert.match(limitLine('Claude', limits.claude).text, /^5 h 36% \(resets .+\) · week 25% \(resets .+\) · just now$/);
  assert.equal(limitLine('Claude', limits.claude).stale, false);
  await mkdir(path.join(home, '.codex', 'sessions', '2026', '10', '17'), { recursive: true });
  await writeFile(path.join(home, '.codex', 'sessions', '2026', '10', '17', 'rollout-a.jsonl'), '{"type":"session_meta"}\n');
  assert.equal((await planLimits({ home, statusLine })).codex, null, 'a session with no rate_limits event is not a figure');
});
