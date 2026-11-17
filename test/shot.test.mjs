import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O146: scripts/shot.mjs only looks. Every request it lets out is a GET or a HEAD, no WebSocket reaches the server, and the
// session token is never printed or written. It runs against a real daemon, signed in, through a proxy that records every
// method it sees; a probe page served by the proxy tries every way a page can send something.
const script = fileURLToPath(new URL('../scripts/shot.mjs', import.meta.url));
const PROBE = `<!doctype html><title>probe</title><body><h1>probe</h1><form id=f method=post action=/chat/x/prompt><input name=a value=1></form><script>
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) fetch('/chat/x/prompt', { method, body: '{}' }).catch(() => {});
navigator.sendBeacon('/chat/x/prompt', 'beacon');
const xhr = new XMLHttpRequest(); xhr.open('POST', '/chat/x/prompt'); xhr.send('xhr');
try { new WebSocket(location.origin.replace('http', 'ws') + '/socket'); } catch {}
setTimeout(() => document.getElementById('f').submit(), 200);
</script>`;

function run(args, env) {
  return new Promise((resolve) => execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, timeout: 90000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
}

test('O146: the screenshot script sends only GET and HEAD and never shows the token', { timeout: 240000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const { session } = await phone(t, server);
  assert.ok(session.token && session.token.length > 8, 'no session token to sign in with');

  // The proxy: every method and upgrade it sees is kept; /probe is its own page, the rest goes to the daemon with the daemon's own
  // host and origin (the daemon refuses another origin, and the proxy's port is another origin).
  const seen = [], upgrades = [], answered = [];
  const proxy = http.createServer((request, response) => {
    seen.push(request.method + ' ' + request.url.split('?')[0]);
    if (request.url === '/probe') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end(PROBE); }
    const forward = http.request({ host: '127.0.0.1', port: server.port, method: request.method, path: request.url, headers: { ...request.headers, host: server.host, ...(request.headers.origin ? { origin: server.origin } : {}), ...(request.headers.referer ? { referer: server.origin + new URL(request.headers.referer).pathname } : {}) } },
      (answer) => { answered.push(answer.statusCode + ' ' + request.method + ' ' + request.url.split('?')[0]); response.writeHead(answer.statusCode, answer.headers); answer.pipe(response); });
    forward.on('error', () => response.destroy());
    request.pipe(forward);
  });
  proxy.on('upgrade', (request, socket) => { upgrades.push(request.url); socket.destroy(); });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const out = await mkdtemp(path.join(os.tmpdir(), 'p9-shot-'));
  const env = { P9_SHOT_BASE: 'http://app.p9.localhost:' + proxy.address().port, P9_SHOT_TOKEN: session.token, P9_SHOT_OUT: out, P9_SHOT_WAIT: '1500' };

  const probe = await run(['/probe', 'desktop'], env);
  assert.equal(probe.code, 0, 'the probe shot failed: ' + probe.stderr);
  const phoneShot = await run(['/phone/', 'phone'], env);
  assert.equal(phoneShot.code, 0, 'the phone shot failed: ' + phoneShot.stderr);
  const list = path.join(out, 'list.json');
  await writeFile(list, JSON.stringify([{ row: 'O146', claim: 'the chat list draws', path: '/phone/', size: 'phone' }, { row: 'O146', claim: 'the phone page at desktop size (/ redirects to /phone/)', path: '/', size: 'desktop' }]));
  const many = await run(['--list', list], env);
  assert.equal(many.code, 0, 'the list run failed: ' + many.stderr);

  // Only looked: nothing but GET and HEAD reached the server, no socket was opened, and the probe's attempts were stopped.
  const changing = seen.filter((line) => !/^(GET|HEAD) /.test(line));
  assert.deepEqual(changing, [], 'a request that is not GET or HEAD reached the server');
  assert.deepEqual(upgrades, [], 'a WebSocket reached the server');
  assert.match(probe.stderr, /stopped \d+ request/, 'the probe page sent nothing for the script to stop');
  assert.ok(seen.includes('GET /phone/'), 'the phone page was never asked for');
  // Signed in: the phone page's own chat list call was answered, not refused.
  assert.ok(answered.includes('200 GET /chat'), 'the phone was not signed in: ' + answered.join(', '));

  // It made what it says, where it says: PNGs in one dated folder, and one page with every shot and its claim.
  const day = path.join(out, new Date().toISOString().slice(0, 10));
  for (const result of [probe, phoneShot]) {
    const file = result.stdout.trim();
    assert.equal(path.dirname(file), day, 'the PNG is not in the dated folder');
    assert.deepEqual([...(await readFile(file)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'not a PNG');
  }
  const page = await readFile(many.stdout.trim(), 'utf8');
  assert.match(page, /the chat list draws/); assert.match(page, /the phone page at desktop size/);
  assert.equal((page.match(/<img /g) ?? []).length, 2, 'the page does not show both shots');

  // The token is never printed and never written to the output folder.
  for (const result of [probe, phoneShot, many]) assert.ok(!(result.stdout + result.stderr).includes(session.token), 'the token was printed');
  for (const name of await readdir(day)) assert.ok(!(await readFile(path.join(day, name))).includes(session.token), 'the token was written to ' + name);
  console.log('PASS O146: GET/HEAD only, no socket, token never shown; ' + JSON.stringify({ requests: seen.length, answered: answered.length, stopped: probe.stderr.trim(), files: (await readdir(day)).length }));
});
