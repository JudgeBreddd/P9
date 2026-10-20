// Phase 10: passkey logins on the remote listener, with a real daemon, real headless Chromium and its CDP virtual
// authenticator (no mocked verifier), a real tmux terminal socket and the real fake ACP adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { chromium } from '@playwright/test';
import { ROUTES } from '../packages/protocol/index.mjs';
import { http, root, authenticated, remoteDaemon as start, passkeyDevice as device, createPasskey as create,
  assertPasskey as assertion, remoteSession as session, askEnrollment as ask, enrollDevice as enroll,
  loginDevice as login, leased } from './helpers.mjs';

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function upgrade(server, route, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(server.port, '127.0.0.1');
    socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.once('connect', () => socket.write('GET ' + route + ' HTTP/1.1\r\nHost: ' + server.host + '\r\nOrigin: ' + server.origin
      + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + randomBytes(16).toString('base64') + '\r\n'
      + Object.entries(headers).map(([name, value]) => name + ': ' + value + '\r\n').join('') + '\r\n'));
    let output = '';
    socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve({ status: Number(output.split(' ')[1]), output }));
  });
}
// Every route and method in the inventory, an unknown route and a terminal socket: all refused with this status, and
// the reply carries nothing but the error (no file content, no workspace path).
async function sweep(server, auth, expected) {
  const headers = auth ? { cookie: 'p9s=' + auth.token, 'x-p9-csrf': auth.csrf } : {};
  for (const route of [...ROUTES, '/files?path=note.txt', '/unknown']) {
    for (const method of METHODS) {
      const result = await server.remote(route, { method, headers });
      assert.equal(result.status, expected, method + ' ' + route + ' ' + result.text);
      assert.ok(!result.text.includes('original') && !result.text.includes(server.workspace), route);
    }
  }
  const socket = await upgrade(server, '/terminals/' + randomUUID() + '/socket', headers);
  assert.equal(socket.status, expected);
  assert.ok(!socket.output.includes('101'));
}

test('Phase 10: auth state machine and threat model surface 12 with real passkeys', async (t) => {
  const server = await start(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const [a, b, c] = await Promise.all(['phone-a', 'tablet-b', 'stranger-c'].map((name) => device(browser, server, name)));

  // Logged out: 401 everywhere; only the login page and ceremonies are public.
  await sweep(server, null, 401);
  assert.equal((await server.remote('/login')).status, 200);
  assert.match((await server.remote('/login')).headers['content-security-policy'], /default-src 'none'/);
  // The TCP port alone cannot add a device: no options and no verify without desktop approval.
  const unapproved = await ask(server, c.name);
  assert.equal((await server.remote('/auth/enroll/' + unapproved + '/options', { method: 'POST' })).status, 403);
  assert.equal((await server.remote('/auth/enroll/' + unapproved + '/verify', { method: 'POST', body: { id: 'x', response: {} } })).status, 403);
  assert.equal((await server.desk('/devices')).body.devices.length, 0);
  // A hostile page cannot start an enrollment (Origin pinned), and proxy identity headers are never identity.
  assert.equal((await server.remote('/auth/enroll', { method: 'POST', body: { name: 'evil' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await server.remote('/health', { headers: { 'tailscale-user-login': 'builder@example.invalid', 'x-forwarded-for': '100.64.0.1' } })).status, 401);
  assert.equal((await server.remote('/health', { headers: { host: '127.0.0.1:' + server.port } })).status, 403);
  // Phase 11 phone check (Builder, 2026-10-16: the installed app showed {"error":"login-required"}): a real browser opening
  // /phone/ with no session lands on the login page; the same GET as a fetch still gets the JSON 401.
  const fresh = await c.context.newPage();
  await fresh.goto(server.origin + '/phone/');
  assert.equal(fresh.url(), server.origin + '/login');
  assert.ok(await fresh.locator('#enroll').count());
  await fresh.close();
  assert.equal((await server.remote('/phone/', { headers: { 'sec-fetch-mode': 'cors' } })).status, 401);
  console.log('PASS logged out: every inventory route, method and the terminal socket 401; enrollment needs the desktop; a page load of /phone/ goes to /login');

  // Two devices race the first enrollment: the desktop approves only B, and only B can register.
  const raceB = await ask(server, b.name), raceC = await ask(server, c.name);
  assert.equal((await server.desk('/devices')).body.enrollments.length, 3);
  assert.equal((await server.desk('/devices/enrollments/' + raceB + '/approve', 'POST')).status, 200);
  const [optionsB, optionsC] = await Promise.all([raceB, raceC].map((id) => server.remote('/auth/enroll/' + id + '/options', { method: 'POST' })));
  assert.equal(optionsC.status, 403);
  assert.equal(optionsB.status, 200);
  const registrationB = await create(b.page, optionsB.body.options);
  const [winner, loser] = await Promise.all([
    server.remote('/auth/enroll/' + raceB + '/verify', { method: 'POST', body: registrationB }),
    server.remote('/auth/enroll/' + raceC + '/verify', { method: 'POST', body: registrationB })]);
  assert.equal(winner.status, 201, winner.text);
  assert.equal(loser.status, 403);
  let sessionB = session(winner);
  assert.equal((await server.remote('/files?path=note.txt', { session: sessionB })).body.content, 'original');
  // The same registration again (replay) is refused, on its own enrollment and on a freshly approved one.
  assert.equal((await server.remote('/auth/enroll/' + raceB + '/verify', { method: 'POST', body: registrationB })).status, 403);
  const replay = await ask(server, 'replay');
  await server.desk('/devices/enrollments/' + replay + '/approve', 'POST');
  assert.equal((await server.remote('/auth/enroll/' + replay + '/options', { method: 'POST' })).status, 200);
  assert.equal((await server.remote('/auth/enroll/' + replay + '/verify', { method: 'POST', body: registrationB })).status, 400);
  for (const id of [unapproved, raceC]) await server.desk('/devices/enrollments/' + id + '/refuse', 'POST');
  console.log('PASS race: only the approved device enrolls; replayed registration refused (403 used, 400 new challenge)');

  // Wrong origin and wrong RP ID: real browser ceremonies on other origins, each on its own desktop approval.
  const other = createServer((request, response) => response.end('<!doctype html><title>other</title>')).listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise((resolve) => other.close(resolve)));
  // Wrong origin: same RP ID, another port. Wrong RP ID: the right page asks for the parent domain 'p9.localhost'.
  for (const [where, rpID] of [['http://app.p9.localhost:' + other.address().port, null], [server.origin + '/login', 'p9.localhost']]) {
    const id = await ask(server, 'wrong');
    await server.desk('/devices/enrollments/' + id + '/approve', 'POST');
    const options = (await server.remote('/auth/enroll/' + id + '/options', { method: 'POST' })).body.options;
    const page = await c.context.newPage();
    const cdp = await c.context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(where);
    const response = await create(page, options, rpID);
    assert.equal((await server.remote('/auth/enroll/' + id + '/verify', { method: 'POST', body: response })).status, 400, where);
    await page.close();
  }
  assert.equal((await server.desk('/devices')).body.devices.length, 1);
  console.log('PASS wrong origin (p9.localhost:other port) and wrong RP ID (p9.localhost, from the right page) registrations refused, device count stays 1');

  // Device A through the real login page buttons: request, desktop approves the shown code, passkey created.
  await a.page.fill('#name', a.name);
  await a.page.click('#enroll');
  await a.page.waitForFunction(() => document.getElementById('code').textContent.length === 6);
  const code = await a.page.textContent('#code');
  const pending = (await server.desk('/devices')).body.enrollments.find((row) => row.code === code);
  assert.equal(pending.name, a.name);
  await server.desk('/devices/enrollments/' + pending.id + '/approve', 'POST');
  await a.page.waitForURL(server.origin + '/phone/', { timeout: 15000 });
  const cookieA = (await a.context.cookies(server.origin)).find((cookie) => cookie.name === 'p9s');
  assert.ok(cookieA.httpOnly && cookieA.secure && cookieA.sameSite === 'Strict');
  let sessionA = { token: cookieA.value, csrf: await a.page.evaluate(() => sessionStorage.getItem('p9-csrf')) };
  // The phone page long-polls chat (Phase 17) and leaves for /login when its session rotates; the passkey ceremonies
  // below run on this page, so it waits on the public login page instead.
  await a.page.goto(server.origin + '/login');
  assert.equal((await server.remote('/health', { session: sessionA })).status, 200);
  const deviceA = (await server.desk('/devices')).body.devices.find((row) => row.name === a.name).id;
  const deviceB = (await server.desk('/devices')).body.devices.find((row) => row.name === b.name).id;
  console.log('PASS login page: enroll button, desktop approves the 6-digit code, HttpOnly Secure SameSite=Strict cookie');

  // CSRF and Origin on a session: a mutation without the token, or from another origin, is refused.
  assert.equal((await server.remote('/terminals', { method: 'POST', body: {}, headers: { cookie: 'p9s=' + sessionA.token } })).status, 403);
  assert.equal((await server.remote('/files?path=note.txt', { session: sessionA, headers: { origin: 'https://evil.example' } })).status, 403);
  // Device management is desktop-only: the TCP port has no /devices routes even with a valid session.
  assert.equal((await server.remote('/devices', { session: sessionA })).status, 404);
  assert.equal((await server.remote('/devices/reset', { method: 'POST', session: sessionA })).status, 404);
  assert.equal((await server.desk('/auth/login/options', 'POST')).status, 404);
  // An operation ID one device used cannot be replayed by another device.
  const op = randomUUID();
  assert.equal((await server.remote('/chat', { method: 'POST', session: sessionA, body: { provider: 'nope' }, headers: { 'x-p9-op': op } })).status, 400);
  assert.equal((await server.remote('/chat', { method: 'POST', session: sessionB, body: { provider: 'nope' }, headers: { 'x-p9-op': op } })).status, 409);

  // One assertion sent twice at once: exactly one login (the challenge is spent when checked, not after verifying).
  const raceOptions = await server.remote('/auth/login/options', { method: 'POST' });
  const raceAssertion = await assertion(a.page, raceOptions.body.options);
  const raced = await Promise.all([1, 2].map(() => server.remote('/auth/login/verify', { method: 'POST', body: raceAssertion })));
  assert.deepEqual(raced.map((result) => result.status).sort(), [200, 401]);
  // Cookie rotation: a new login replaces the old session; the login assertion cannot be replayed.
  const again = await login(server, a);
  assert.equal(again.result.status, 200, again.result.text);
  assert.equal((await server.remote('/health', { session: sessionA })).status, 401);
  assert.equal((await server.remote('/auth/login/verify', { method: 'POST', body: again.response })).status, 401);
  sessionA = again;
  assert.equal((await server.remote('/health', { session: sessionA })).status, 200);
  console.log('PASS CSRF/origin 403, /devices 404 on TCP, per-device operation IDs, rotation: old cookie 401, replayed assertion 401');

  // Lock: 423 on every route for that device only; another device unlocking does not unlock it; its passkey does.
  assert.equal((await server.desk('/devices/' + deviceA + '/lock', 'POST')).status, 200);
  await sweep(server, sessionA, 423);
  assert.equal((await server.remote('/health', { session: sessionB })).status, 200);
  assert.equal((await server.remote('/lock', { method: 'POST', session: sessionB })).status, 200);
  await sweep(server, sessionB, 423);
  const unlockB = await login(server, b);
  assert.equal(unlockB.result.status, 200);
  sessionB = unlockB;
  assert.equal((await server.remote('/health', { session: sessionB })).status, 200);
  assert.equal((await server.remote('/health', { session: sessionA })).status, 423);
  const unlockA = await login(server, a);
  assert.equal(unlockA.result.status, 200);
  assert.equal((await server.remote('/health', { session: sessionA })).status, 401, 'pre-lock session rotated away');
  sessionA = unlockA;
  console.log('PASS lock: 423 sweep for the locked device only; B unlocking leaves A locked; A unlocks only with its own passkey');

  // Revoke is final: the session and the passkey stop working; getting back in is a new enrollment the desktop approves.
  assert.equal((await server.desk('/devices/' + deviceA + '/revoke', 'POST')).status, 200);
  await sweep(server, sessionA, 401);
  const revokedLogin = await login(server, a);
  assert.equal(revokedLogin.result.status, 401);
  const reenroll = await ask(server, a.name);
  assert.equal((await server.remote('/auth/enroll/' + reenroll + '/options', { method: 'POST' })).status, 403);
  await server.desk('/devices/enrollments/' + reenroll + '/refuse', 'POST');
  sessionA = await enroll(server, a);
  assert.equal((await server.remote('/health', { session: sessionA })).status, 200);
  console.log('PASS revoke: 401 sweep, old passkey 401, re-enroll refused until the desktop approves (recovery path)');

  // Reset: every device out; the next one needs desktop approval again.
  const reset = await server.desk('/devices/reset', 'POST');
  assert.equal(reset.body.revoked, 2);
  for (const auth of [sessionA, sessionB]) assert.equal((await server.remote('/health', { session: auth })).status, 401);
  const afterReset = await ask(server, b.name);
  assert.equal((await server.remote('/auth/enroll/' + afterReset + '/options', { method: 'POST' })).status, 403);
  await server.desk('/devices/enrollments/' + afterReset + '/approve', 'POST');
  assert.equal((await server.remote('/auth/enroll/' + afterReset + '/options', { method: 'POST' })).status, 200);

  const events = (await server.desk('/devices')).body.audit.map((row) => row.event);
  for (const event of ['enroll-requested', 'enroll-approved', 'enroll-refused', 'enroll-failed', 'enrolled', 'login', 'login-failed', 'locked', 'unlocked', 'revoked', 'reset']) {
    assert.ok(events.includes(event), event);
  }
  assert.ok(deviceB);
  console.log('PASS reset: both devices 401, next enrollment needs approval; audit log has every auth event type');
});

test('Phase 10: revoke and lock close that device\'s terminal socket and long poll within 1 s', async (t) => {
  const server = await start(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const [a, b] = await Promise.all(['phone-a', 'tablet-b'].map((name) => device(browser, server, name)));
  const sessions = { a: await enroll(server, a), b: await enroll(server, b) };

  async function connect(auth) {
    const created = await server.remote('/terminals', { method: 'POST', session: auth, body: {} });
    assert.equal(created.status, 201, created.text);
    const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/terminals/' + created.body.terminal + '/socket', {
      headers: { host: server.host, origin: server.origin, cookie: 'p9s=' + auth.token } });  // a browser WebSocket sends no custom header
    const opened = once(ws, 'open');  // before the awaits below, or the open event can fire unseen
    for (const origin of ['https://evil.example', undefined]) {
      const refused = new WebSocket('ws://127.0.0.1:' + server.port + '/terminals/' + created.body.terminal + '/socket', {
        headers: { host: server.host, ...(origin ? { origin } : {}), cookie: 'p9s=' + auth.token } });
      const status = await new Promise((resolve) => { refused.on('unexpected-response', (request, response) => resolve(response.statusCode)); refused.on('open', () => resolve(101)); refused.on('error', () => {}); });
      assert.equal(status, 403, 'terminal socket with origin ' + origin);
    }
    let output = '';
    const frames = [];
    ws.on('message', (data, binary) => { if (binary) { output += data.toString(); frames.push(Date.now()); } });
    const keys = leased(ws);
    await opened;
    await keys.keys('echo P9-MARK-4""2\r');  // the echo, not the typed line, contains P9-MARK-42 (sh and fish)
    for (let i = 0; i < 100 && !output.includes('P9-MARK-42'); i++) await wait(50);
    assert.ok(output.includes('P9-MARK-42'), 'terminal round trip: ' + JSON.stringify(output.slice(-200)));
    // A chat long poll held open on the same device.
    const poll = http({ port: server.port, route: '/chat/events?after=999999999&wait=8000', timeout: 15000,
      headers: { host: server.host, origin: server.origin, cookie: 'p9s=' + auth.token } }).then((result) => ({ ended: Date.now(), result }), (error) => ({ ended: Date.now(), error }));
    await wait(200);
    return { ws, frames, poll, terminal: created.body.terminal };
  }
  for (const [name, action, refused] of [['a', 'revoke', 401], ['b', 'lock', 423]]) {
    const auth = sessions[name];
    const open = await connect(auth);
    const closed = once(open.ws, 'close').then(() => Date.now());
    const id = (await server.desk('/devices')).body.devices.find((row) => row.name.endsWith('-' + name)).id;
    const started = Date.now();
    assert.equal((await server.desk('/devices/' + id + '/' + action, 'POST')).status, 200);
    const [wsClosed, poll] = await Promise.all([closed, open.poll]);
    assert.ok(wsClosed - started < 1000, action + ' terminal socket closed in ' + (wsClosed - started) + ' ms');
    assert.ok(poll.ended - started < 1000 && poll.error, action + ' long poll cut in ' + (poll.ended - started) + ' ms');
    // New terminal output, chat events and file changes never reach it: every way back in is refused.
    const after = Date.now();
    await server.desk('/files', 'PUT', { path: 'note.txt', hash: JSON.parse((await http({ socketPath: server.credentials.socketPath,
      route: '/files?path=note.txt', headers: authenticated(server.credentials) })).text).hash, content: 'changed by desktop ' + name });
    await server.desk('/chat', 'POST', { provider: 'claude' }).catch(() => {});
    assert.equal(open.frames.filter((at) => at > after).length, 0);
    assert.equal((await upgrade(server, '/terminals/' + open.terminal + '/socket', { cookie: 'p9s=' + auth.token, 'x-p9-csrf': auth.csrf })).status, refused);
    for (const route of ['/chat/events?after=0', '/files?path=note.txt', '/terminals']) {
      const result = await server.remote(route, { session: auth });
      assert.equal(result.status, refused);
      assert.ok(!result.text.includes('changed by desktop'));
    }
    console.log('PASS ' + action + ': terminal socket closed in ' + (wsClosed - started) + ' ms, long poll in ' + (poll.ended - started) + ' ms; reconnects ' + refused);
  }
});

test('Phase 10: login rate limit, and an agent and a terminal get nothing with the credentials they can see', async (t) => {
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const server = await start(t, { args: ['--acp-override', fake] });
  const probe = path.join(root, 'test/credential-probe.mjs');
  // The desktop credential file: owner-only and outside the workspace (the stated limit: same-user code can read it).
  const credentialFile = path.join(server.state, 'desktop.json');
  assert.equal((await stat(credentialFile)).mode & 0o777, 0o600);
  assert.ok(path.relative(server.workspace, credentialFile).startsWith('..'));
  // Plant the desktop cookie where a careless agent might find it, to show the remote port never accepts it.
  await writeFile(path.join(server.workspace, 'leaked.txt'), JSON.parse(await readFile(credentialFile, 'utf8')).cookie);

  // An ACP agent started by the daemon runs the probe.
  const chat = await server.desk('/chat', 'POST', { provider: 'claude' });
  assert.equal(chat.status, 201, chat.text);
  assert.equal((await server.desk('/chat/' + chat.body.conversation + '/prompt', 'POST', { text: 'probe ' + server.port + ' ' + server.host + ' ' + probe })).status, 202);
  let agentProbe, cursor = 0;
  for (let i = 0; i < 40 && !agentProbe; i++) {
    const events = (await server.desk('/chat/events?after=' + cursor + '&wait=2000')).body;
    cursor = events.cursor;
    agentProbe = events.events.map((event) => event.data?.content?.text ?? '').find((text) => text.startsWith('PROBE '));
  }
  assert.ok(agentProbe, 'agent probe reply');
  const agent = JSON.parse(agentProbe.slice(6));
  // A real P9 terminal (tmux pane) runs the same probe.
  const terminal = (await server.desk('/terminals', 'POST', {})).body.terminal;
  const tmux = (await server.desk('/terminals')).body;
  assert.ok(tmux.terminals.some((row) => row.id === terminal));
  const out = path.join(server.directory, 'terminal-probe.txt');
  const { execFileSync } = await import('node:child_process');
  const socketName = server.extra.args[server.extra.args.indexOf('--tmux-socket') + 1];
  execFileSync('tmux', ['-L', socketName, 'send-keys', '-t', '=p9-' + terminal + ':', process.execPath + ' ' + probe + ' ' + server.port + ' ' + server.host + ' > ' + out, 'Enter']);
  let terminalProbe;
  for (let i = 0; i < 100 && !terminalProbe; i++) { await wait(100); terminalProbe = await readFile(out, 'utf8').catch(() => '').then((text) => text.includes('PROBE ') ? text : null); }
  assert.ok(terminalProbe, 'terminal probe output');
  const shell = JSON.parse(terminalProbe.slice(terminalProbe.indexOf('PROBE ') + 6));
  for (const [who, result] of [['agent', agent], ['terminal', shell]]) {
    assert.ok(result.tried >= 1, who + ' found candidates (the planted cookie at least)');
    assert.deepEqual(Object.keys(result.statuses), ['401'], who + ' ' + JSON.stringify(result));
    assert.deepEqual(result.names, [], who + ' has no P9 credential variables');
  }
  console.log('PASS agent and terminal: ' + agent.tried + ' and ' + shell.tried + ' candidates incl. the desktop cookie, every remote try 401, no P9 variables');

  // Rate limit: 10 failed logins in 5 minutes close the login routes (one window: Serve makes every client 127.0.0.1).
  const bogus = { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' }, clientExtensionResults: {} };
  for (let i = 0; i < 10; i++) assert.equal((await server.remote('/auth/login/verify', { method: 'POST', body: bogus })).status, 401);
  assert.equal((await server.remote('/auth/login/verify', { method: 'POST', body: bogus })).status, 429);
  assert.equal((await server.remote('/auth/login/options', { method: 'POST' })).status, 429);
  assert.equal((await server.remote('/auth/enroll', { method: 'POST', body: { name: 'late' } })).status, 429);
  const audit = (await server.desk('/devices')).body.audit;
  assert.equal(audit.filter((row) => row.event === 'login-failed').length, 10);
  console.log('PASS rate limit: 10 failures then 429 on login and enrollment; audit log has 10 login-failed rows');
});

test('Phase 10: a request pipelined behind a long poll on one connection does not shield it from revoke (C-H3)', async (t) => {
  const server = await start(t, { args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const auth = await enroll(server, await device(browser, server, 'phone-p'));
  const socket = net.createConnection(server.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.on('data', () => {});
  socket.on('error', () => {});
  const closed = once(socket, 'close').then(() => Date.now());
  const head = (route, extra = '') => 'GET ' + route + ' HTTP/1.1\r\nHost: ' + server.host + '\r\nOrigin: ' + server.origin + '\r\n' + extra + '\r\n';
  // One write: the authenticated long poll, then a public request behind it on the same keep-alive connection.
  socket.write(head('/chat/events?after=999999999&wait=8000', 'Cookie: p9s=' + auth.token + '\r\n') + head('/login'));
  await wait(300);
  const id = (await server.desk('/devices')).body.devices[0].id;
  const started = Date.now();
  assert.equal((await server.desk('/devices/' + id + '/revoke', 'POST')).status, 200);
  const ended = await Promise.race([closed, wait(3000).then(() => null)]);
  socket.destroy();
  assert.ok(ended && ended - started < 1000, 'pipelined long poll cut in ' + (ended ? ended - started : '>3000') + ' ms');
  console.log('PASS pipelined long poll cut in ' + (ended - started) + ' ms');
});

test('Phase 17: terminal socket control frames and IDs (threat model surface 13, cases 5 and 6)', async (t) => {
  const server = await start(t, {});
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const auth = await enroll(server, await device(browser, server, 'phone-17'));
  const created = await server.remote('/terminals', { method: 'POST', session: auth, body: {} });
  assert.equal(created.status, 201, created.text);
  const open = async (id) => {
    const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/terminals/' + id + '/socket', { headers: { host: server.host, origin: server.origin, cookie: 'p9s=' + auth.token } });
    const state = { output: '', closed: once(ws, 'close').then(([code]) => code) };
    ws.on('message', (data, binary) => { if (binary) state.output += data.toString(); });
    ws.on('error', () => {});
    const { keys, lease } = leased(ws);
    await Promise.race([once(ws, 'open'), state.closed]);
    return Object.assign(state, { ws, keys, lease });
  };
  const until = async (state, text) => { for (let i = 0; i < 100 && !state.output.includes(text); i++) await wait(50); assert.ok(state.output.includes(text), text + ': ' + JSON.stringify(state.output.slice(-200))); };
  // A valid resize reaches the shell.
  const good = await open(created.body.terminal);
  good.ws.send(JSON.stringify({ resize: [101, 33] }));
  await wait(200);
  await good.keys('echo C-$(tput cols)-$(tput lines)-E\r');
  await until(good, 'C-101-33-E');
  good.ws.close();
  // Case 5: any other text frame closes the socket with 1008, and the shell keeps running.
  for (const frame of ['ls\r', '{"resize":[1,24]}', '{"resize":[80,500]}', '{"resize":["80x24; kill-server",1]}', '{"resize":[80,24],"x":1}']) {
    const bad = await open(created.body.terminal);
    bad.ws.send(frame);
    assert.equal(await bad.closed, 1008, frame);
  }
  const after = await open(created.body.terminal);
  await after.keys('echo STILL-4""2\r');
  await until(after, 'STILL-42');
  after.ws.close();
  // Case 3, keys typed into a dead link: a key stamped with a lease the daemon sent over 5 s ago closes the socket with
  // 4408, and a key with the newest lease right behind it in the same burst does not run either.
  const quiet = await open(created.body.terminal);
  await quiet.keys('echo FRESH-4""2\r');
  await until(quiet, 'FRESH-42');
  const typed = quiet.lease();
  await wait(6000);
  await quiet.keys('echo LATE-4""2\r', typed);
  await quiet.keys('echo AFTER-4""2\r');
  assert.equal(await Promise.race([quiet.closed, wait(8000).then(() => 'still open')]), 4408, 'late keys close the socket');
  // No lease at all: a bare key frame (the old protocol) and a made-up lease close 4408 too.
  for (const frame of [Buffer.from('echo BARE-4""2\r'), Buffer.concat([randomBytes(8), Buffer.from('echo FAKE-4""2\r')])]) {
    const bare = await open(created.body.terminal);
    for (let i = 0; i < 100 && !bare.lease(); i++) await wait(50);
    bare.ws.send(frame);
    assert.equal(await Promise.race([bare.closed, wait(8000).then(() => 'still open')]), 4408, String(frame));
  }
  const check = await open(created.body.terminal);
  await check.keys('echo CHECK-4""2\r');
  await until(check, 'CHECK-42');
  for (const word of ['LATE-42', 'AFTER-42', 'BARE-42', 'FAKE-42']) assert.ok(!check.output.includes(word), word + ' reached the shell');
  check.ws.close();
  // Case 1: refused upgrades attach no tmux client (the closed sockets above left none either).
  const { execFileSync } = await import('node:child_process');
  const socketName = server.extra.args[server.extra.args.indexOf('--tmux-socket') + 1];
  const clients = async () => { await wait(300); return execFileSync('tmux', ['-L', socketName, 'list-clients']).toString().trim(); };
  assert.equal(await clients(), '');
  const route = '/terminals/' + created.body.terminal + '/socket';
  assert.equal((await upgrade(server, route, {})).status, 401, 'no cookie');
  const raw = (origin) => new Promise((resolve) => {
    const socket = net.createConnection(server.port, '127.0.0.1', () => socket.write('GET ' + route + ' HTTP/1.1\r\nHost: ' + server.host
      + (origin ? '\r\nOrigin: ' + origin : '') + '\r\nCookie: p9s=' + auth.token + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '
      + randomBytes(16).toString('base64') + '\r\n\r\n'));
    let output = ''; socket.on('data', (chunk) => { output += chunk; }); socket.on('end', () => resolve(Number(output.split(' ')[1])));
  });
  assert.equal(await raw('https://evil.example'), 403, 'foreign Origin');
  assert.equal(await raw(null), 403, 'no Origin');
  assert.equal(await clients(), '');
  // Case 6: an unknown ID and a stopped terminal close with 4404; a name that is not a P9 terminal ID is refused at the upgrade.
  assert.equal(await (await open(randomUUID())).closed, 4404);
  assert.equal((await server.remote('/terminals/' + created.body.terminal + '/stop', { method: 'POST', session: auth, body: {} })).status, 200);
  assert.equal(await (await open(created.body.terminal)).closed, 4404);
  for (const name of ['main', '0', 'p9-' + created.body.terminal]) {
    const refused = await upgrade(server, '/terminals/' + name + '/socket', { cookie: 'p9s=' + auth.token });
    assert.equal(refused.status, 404, name);
  }
  // Case 1, locked device: refused with 423 and no client.
  const live = await server.remote('/terminals', { method: 'POST', session: auth, body: {} });
  const id = (await server.desk('/devices')).body.devices[0].id;
  assert.equal((await server.desk('/devices/' + id + '/lock', 'POST')).status, 200);
  assert.equal((await upgrade(server, '/terminals/' + live.body.terminal + '/socket', { cookie: 'p9s=' + auth.token })).status, 423);
  assert.equal(await clients(), '');
});

test('Phase 17: keys reach only P9\'s tmux socket, and a shell that exits by itself reads as stopped (case 6)', { skip: process.platform !== 'linux' }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  // The daemon and this test share a private TMUX_TMPDIR, so the "default" tmux socket here is not Builder's.
  const tmpdir = await mkdtemp(path.join(os.tmpdir(), 'p9-tmux-'));
  const env = { ...process.env, TMUX_TMPDIR: tmpdir };
  const server = await start(t, { setup: async () => ({ env: { TMUX_TMPDIR: tmpdir } }) });
  const socketName = server.extra.args[server.extra.args.indexOf('--tmux-socket') + 1];
  t.after(() => { for (const args of [[], ['-L', socketName]]) try { execFileSync('tmux', [...args, 'kill-server'], { env, stdio: 'ignore' }); } catch {} });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const auth = await enroll(server, await device(browser, server, 'phone-17-canary'));
  const created = await server.remote('/terminals', { method: 'POST', session: auth, body: {} });
  assert.equal(created.status, 201, created.text);
  const id = created.body.terminal;
  // A same-named canary on the default socket: a build that dropped -L would type into it.
  execFileSync('tmux', ['new-session', '-d', '-s', 'p9-' + id], { env });
  const open = async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/terminals/' + id + '/socket', { headers: { host: server.host, origin: server.origin, cookie: 'p9s=' + auth.token } });
    const state = { ws, output: '', closed: once(ws, 'close').then(([code]) => code), ...leased(ws) };
    ws.on('message', (data, binary) => { if (binary) state.output += data.toString(); });
    ws.on('error', () => {});
    await Promise.race([once(ws, 'open'), state.closed]);
    return state;
  };
  const term = await open();
  await term.keys('echo CANARY-4""2\r');
  for (let i = 0; i < 100 && !term.output.includes('CANARY-42'); i++) await wait(50);
  const pane = (args) => execFileSync('tmux', [...args, 'capture-pane', '-p', '-t', '=p9-' + id + ':'], { env }).toString();
  assert.ok(pane(['-L', socketName]).includes('CANARY-42'), 'P9 session did not get the keys');
  assert.ok(!pane([]).includes('CANARY-42'), 'keys reached the default tmux socket');
  // The shell exits on its own (no stop route): the next attach closes 4404 and the ledger reads stopped.
  await term.keys('exit\r');
  await term.closed;
  assert.equal(await (await open()).closed, 4404);
  const listed = await server.remote('/terminals', { session: auth });
  assert.equal(listed.body.terminals.find((row) => row.id === id)?.state, 'stopped');
});

test('Phase 17: real tmux, audited: no client for refused, malformed or abandoned upgrades; early, mixed and oversized frames run nothing (cases 1-3, 5, 6)', { skip: process.platform !== 'linux' }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, chmod, rm } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  // A wrapper in front of the real tmux logs every call; while the slow file exists, list-sessions takes 1.5 s.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-audit-'));
  const log = path.join(dir, 'calls'), slow = path.join(dir, 'slow');
  const real = execFileSync('sh', ['-c', 'command -v tmux']).toString().trim();
  await writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nprintf "%s\\n" "$*" >> ' + log + '\ncase " $* " in *" list-sessions "*) [ -e ' + slow + ' ] && sleep 1.5;; esac\nexec ' + real + ' "$@"\n');
  await chmod(path.join(dir, 'tmux'), 0o755);
  await writeFile(log, '');
  const server = await start(t, { setup: async () => ({ env: { PATH: dir + ':' + process.env.PATH } }) });
  const socketName = server.extra.args[server.extra.args.indexOf('--tmux-socket') + 1];
  const attaches = async () => (await readFile(log, 'utf8')).split('\n').filter((line) => line.includes('attach-session')).length;
  const clients = async () => { await wait(300); return execFileSync(real, ['-L', socketName, 'list-clients']).toString().trim(); };
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const auth = await enroll(server, await device(browser, server, 'phone-17-audit'));
  const id = (await server.remote('/terminals', { method: 'POST', session: auth, body: {} })).body.terminal;
  const url = 'ws://127.0.0.1:' + server.port + '/terminals/' + id + '/socket';
  const headers = { host: server.host, origin: server.origin, cookie: 'p9s=' + auth.token };
  // Positive control: one real attach is logged once, so a zero below means none started.
  const good = new WebSocket(url, { headers });
  await once(good, 'message');
  good.close();
  await once(good, 'close');
  assert.equal(await attaches(), 1, 'the log sees a real attach');
  // Malformed targets ('GET //' threw in new URL before authentication) are refused, and the daemon stays up.
  const raw = (target) => new Promise((resolve) => {
    const socket = net.createConnection(server.port, '127.0.0.1', () => socket.write('GET ' + target + ' HTTP/1.1\r\nHost: ' + server.host
      + '\r\nOrigin: ' + server.origin + '\r\nCookie: p9s=' + auth.token + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '
      + randomBytes(16).toString('base64') + '\r\n\r\n'));
    let output = ''; socket.on('data', (chunk) => { output += chunk; }); socket.on('error', () => {});
    socket.on('close', () => resolve(Number(output.split(' ')[1]) || 0));
  });
  for (const target of ['//', '/\\x', 'http://evil.example/terminals/' + id + '/socket']) assert.equal(await raw(target), 400, target);
  assert.equal((await server.desk('/terminals')).status, 200, 'daemon alive after malformed upgrades');
  // Refused upgrades: no cookie, an unknown ID (4404), a non-ID name.
  assert.equal((await upgrade(server, '/terminals/' + id + '/socket', {})).status, 401);
  const unknown = new WebSocket('ws://127.0.0.1:' + server.port + '/terminals/' + randomUUID() + '/socket', { headers });
  assert.equal((await once(unknown, 'close'))[0], 4404);
  assert.equal((await upgrade(server, '/terminals/main/socket', { cookie: 'p9s=' + auth.token })).status, 404);
  const pane = () => execFileSync(real, ['-L', socketName, 'capture-pane', '-p', '-t', '=p9-' + id + ':']).toString();
  const opened = async (options) => {
    const ws = new WebSocket(url, { headers, ...options });
    const state = { ws, output: '', closed: once(ws, 'close').then(([code]) => code), ...leased(ws) };
    ws.on('message', (data, binary) => { if (binary) state.output += data.toString(); });
    ws.on('error', () => {});
    await Promise.race([once(ws, 'open'), state.closed]);
    return state;
  };
  // Case 5: a bad text frame and a key right behind it in the same burst: 1008, and the key never runs.
  const burst = await opened();
  for (let i = 0; i < 100 && !burst.lease(); i++) await wait(50);
  burst.ws.send('not-a-resize');  // both frames leave in the same tick
  burst.ws.send(Buffer.concat([burst.lease() ?? Buffer.alloc(0), Buffer.from('echo BURST-4""2\r')]));
  assert.equal(await Promise.race([burst.closed, wait(4000).then(() => 'still open')]), 1008);
  // An over-limit frame (65,537 bytes) and a text frame that is not UTF-8 end that socket, never the daemon.
  for (const [frame, options] of [[Buffer.alloc(65537, 0x61), { binary: true }], [Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { binary: false }]]) {
    const big = await opened();
    big.ws.send(frame, options);
    assert.ok([1006, 1007, 1009].includes(await big.closed), 'closed ' + frame.length);
    assert.equal((await server.desk('/terminals')).status, 200, 'daemon alive after a ' + frame.length + '-byte frame');
  }
  // Case 1: a wrong Host header is refused before any tmux call.
  const hostile = await new Promise((resolve) => {
    const socket = net.createConnection(server.port, '127.0.0.1', () => socket.write('GET /terminals/' + id + '/socket HTTP/1.1\r\nHost: evil.example'
      + '\r\nOrigin: ' + server.origin + '\r\nCookie: p9s=' + auth.token + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '
      + randomBytes(16).toString('base64') + '\r\n\r\n'));
    let output = ''; socket.on('data', (chunk) => { output += chunk; }); socket.on('error', () => {});
    socket.on('close', () => resolve(Number(output.split(' ')[1]) || 0));
  });
  assert.equal(hostile, 403, 'wrong Host');
  await wait(300);
  for (const word of ['BURST-42']) assert.ok(!pane().includes(word), word + ' reached the shell');
  // Cases 2 and 6, close during the lookup: the phone closes while list-sessions is slow; no client starts.
  const before = await attaches();
  await writeFile(slow, '');
  // Case 3, a key during the lookup (no lease exists yet) closes 4408; it is not held for later, and no client starts.
  const early = await opened();
  early.ws.send(Buffer.concat([randomBytes(8), Buffer.from('echo EARLY-4""2\r')]));
  assert.equal(await Promise.race([early.closed, wait(4000).then(() => 'still open')]), 4408);
  const quitter = new WebSocket(url, { headers });
  await once(quitter, 'open');
  quitter.close();
  await once(quitter, 'close');
  await wait(2500);
  assert.equal(await attaches(), before, 'a client started for a socket closed during the lookup');
  // Case 2, lock during the lookup through the real listener: the socket is cut and no client starts.
  const locked = new WebSocket(url, { headers });
  const lockedClosed = once(locked, 'close');
  await once(locked, 'open');
  const deviceId = (await server.desk('/devices')).body.devices[0].id;
  assert.equal((await server.desk('/devices/' + deviceId + '/lock', 'POST')).status, 200);
  await lockedClosed;
  await wait(2500);
  await rm(slow);
  assert.equal(await attaches(), before, 'a client started for a socket locked during the lookup');
  assert.equal(await clients(), '');
  assert.ok(!pane().includes('EARLY-42'), 'a key sent during the lookup reached the shell');
});
