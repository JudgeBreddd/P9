import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-test-'));
  const workspace = path.join(directory, 'workspace');
  const state = path.join(directory, 'state');
  const recovery = path.join(directory, 'recovery');
  await mkdir(workspace);
  await mkdir(recovery, { mode: 0o700 });
  await writeFile(path.join(workspace, 'note.txt'), 'original');
  return { directory, workspace, state, recovery };
}
export async function daemon(t, entry = 'apps/server/main.mjs', nested = false, setup) {
  const fixturePaths = await fixture();
  if (nested) {
    fixturePaths.workspace = path.join(fixturePaths.workspace, 'root');
    await mkdir(fixturePaths.workspace);
    await writeFile(path.join(fixturePaths.workspace, 'note.txt'), 'original');
  }
  const extra = setup ? await setup(fixturePaths) : {};
  return startDaemon(t, entry, fixturePaths, extra);
}
// A second daemon on the same home (same ledger) after the first was stopped or killed; runtime state is fresh.
export async function restart(t, instance, name) {
  return startDaemon(t, 'apps/server/main.mjs', { ...instance, state: path.join(instance.directory, name) }, instance.extra);
}
async function startDaemon(t, entry, fixturePaths, extra) {
  const daemonArgs = [process.execPath, '--import', './test/home-fixture.mjs', entry, '--workspace', fixturePaths.workspace,
    '--state', fixturePaths.state, '--recovery', fixturePaths.recovery, ...(extra.args ?? [])];
  const windows = process.platform === 'win32';
  if (windows) {
    await mkdir(path.join(fixturePaths.directory, 'local-app-data'));
    await mkdir(path.join(fixturePaths.directory, 'roaming-app-data'));
  }
  const command = windows ? 'powershell.exe' : daemonArgs.shift();
  const inherited = windows ? Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME',
    'TEMP', 'TMP', 'ProgramData'].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) : {};
  const environment = { ...inherited, PATH: extra.path ?? process.env.PATH, ...extra.env, P9_TEST_HOME: fixturePaths.directory,
    XDG_STATE_HOME: fixturePaths.directory, ...(windows ? { LOCALAPPDATA: path.join(fixturePaths.directory, 'local-app-data'),
      APPDATA: path.join(fixturePaths.directory, 'roaming-app-data') } : {}) };
  const payload = Buffer.from(JSON.stringify({ argv: daemonArgs, env: environment })).toString('base64');
  const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts', 'windows-host.ps1'), '-Mode', 'Daemon', '-Payload', payload] : daemonArgs;
  const child = spawn(command, args, { cwd: root,
    env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const ready = new Promise((resolve, reject) => {
    // Windows pays two PowerShell starts and an Add-Type compile before P9_READY.
    const timer = setTimeout(() => reject(new Error('daemon-timeout')), process.platform === 'win32' ? 20000 : 5000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon-exit-${code}`)); });
    child.stdout.on('data', () => { if (output.includes('P9_READY')) { clearTimeout(timer); resolve(); } });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  await ready;
  const credentials = JSON.parse(await readFile(path.join(fixturePaths.state, 'desktop.json'), 'utf8'));
  return { ...fixturePaths, child, credentials, extra };
}

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function remoteDaemon(t, extra = {}) {
  const port = await freePort();
  const origin = 'http://app.p9.localhost:' + port, host = 'app.p9.localhost:' + port;
  const tmux = 'p9t-' + randomUUID().slice(0, 8);
  const instance = await daemon(t, undefined, false, async (paths) => {
    const configured = extra.setup ? await extra.setup(paths) : {};
    return { ...configured, args: ['--remote-port', String(port), '--remote-origin', origin, '--tmux-socket', tmux,
      ...(configured.args ?? []), ...(extra.args ?? [])] };
  });
  const desk = async (route, method = 'GET', body) => {
    const result = await http({ socketPath: instance.credentials.socketPath, route, method,
      headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed;
    try { parsed = JSON.parse(result.text); } catch {}
    return { ...result, body: parsed };
  };
  t.after(() => desk('/stop-all', 'POST').catch(() => {}));
  const remote = async (route, { method = 'GET', session, body, headers = {} } = {}) => {
    const result = await http({ port, route, method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { host, origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { cookie: 'p9s=' + session.token, 'x-p9-csrf': session.csrf } : {}), ...headers } })
      .catch((error) => { throw new Error(method + ' ' + route + ': ' + error.message); });
    let parsed;
    try { parsed = JSON.parse(result.text); } catch {}
    return { ...result, body: parsed };
  };
  return { ...instance, port, origin, host, desk, remote };
}

export async function passkeyDevice(browser, server, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(server.origin + '/login');
  return { name, page, context };
}

const ceremony = (page, kind, options, rpID = null) => page.evaluate(async ({ kind, o, rpID }) => {
  const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const text = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const credential = kind === 'create'
    ? await navigator.credentials.create({ publicKey: { ...o, rp: rpID ? { ...o.rp, id: rpID } : o.rp, challenge: bytes(o.challenge),
      user: { ...o.user, id: bytes(o.user.id) }, excludeCredentials: [] } })
    : await navigator.credentials.get({ publicKey: { ...o, challenge: bytes(o.challenge), allowCredentials: [] } });
  const r = credential.response;
  const response = { clientDataJSON: text(r.clientDataJSON) };
  if (r.attestationObject) Object.assign(response, { attestationObject: text(r.attestationObject), transports: r.getTransports() });
  else Object.assign(response, { authenticatorData: text(r.authenticatorData), signature: text(r.signature), userHandle: r.userHandle ? text(r.userHandle) : undefined });
  return { id: credential.id, rawId: text(credential.rawId), type: credential.type, response, clientExtensionResults: credential.getClientExtensionResults() };
}, { kind, o: options, rpID });
export const createPasskey = (page, options, rpID) => ceremony(page, 'create', options, rpID);
export const assertPasskey = (page, options) => ceremony(page, 'get', options);
export const remoteSession = (result) => ({ token: /p9s=([^;]+)/.exec(result.headers['set-cookie']?.[0] ?? '')?.[1], csrf: result.body?.csrf });

export async function askEnrollment(server, name) {
  const asked = await server.remote('/auth/enroll', { method: 'POST', body: { name } });
  assert.equal(asked.status, 201, asked.text);
  return asked.body.enrollment;
}
export async function enrollDevice(server, dev) {
  const id = await askEnrollment(server, dev.name);
  assert.equal((await server.desk('/devices/enrollments/' + id + '/approve', 'POST')).status, 200);
  const options = await server.remote('/auth/enroll/' + id + '/options', { method: 'POST' });
  assert.equal(options.status, 200, options.text);
  const verified = await server.remote('/auth/enroll/' + id + '/verify', { method: 'POST', body: await createPasskey(dev.page, options.body.options) });
  assert.equal(verified.status, 201, verified.text);
  return { ...remoteSession(verified), device: verified.body.device };
}
export async function loginDevice(server, dev) {
  const options = await server.remote('/auth/login/options', { method: 'POST' });
  assert.equal(options.status, 200, options.text);
  const response = await assertPasskey(dev.page, options.body.options);
  const result = await server.remote('/auth/login/verify', { method: 'POST', body: response });
  return { result, response, ...remoteSession(result) };
}
export function http({ socketPath, port, route = '/health', method = 'GET', headers = {}, body, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    // Every mutation carries an operation ID (phase 6); a test that is about operation IDs sets its own.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !Object.hasOwn(headers, 'x-p9-op')) headers = { ...headers, 'x-p9-op': randomUUID() };
    // A fresh connection each time: lock and revoke destroy a device's sockets, and a pooled one could be reused mid-close.
    const req = request({ agent: false,...(socketPath ? { socketPath } : { hostname: '127.0.0.1', port }),
      path: route, method, headers, timeout }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body);
  });
}
export function authenticated(credentials) {
  return { host: 'p9.local', origin: 'http://p9.local', cookie: `p9=${credentials.cookie}`, 'x-p9-csrf': credentials.csrf };
}
export function externalEdit(file, kind = 'write') {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync, renameSync, unlinkSync, symlinkSync } from 'node:fs';
    const [file, kind] = process.argv.slice(1);
    if (kind === 'replace') { writeFileSync(file + '.agent', 'competing'); renameSync(file + '.agent', file); }
    else if (kind === 'symlink') { unlinkSync(file); symlinkSync(file + '.outside', file); }
    else writeFileSync(file, 'competing');
  `, file, kind], { env: { PATH: process.env.PATH } });
}

// A terminal socket's key frames start with the newest lease the daemon sent, as the phone's do (threat model
// surface 13). keys(text, lease) sends with an older lease when given one.
export function leased(ws) {
  let lease = null;
  ws.on('message', (data, binary) => { if (!binary) try { lease = Buffer.from(JSON.parse(String(data)).lease, 'hex'); } catch {} });
  return {
    lease: () => lease,
    async keys(text, use) {
      for (let i = 0; i < 100 && !lease; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      ws.send(Buffer.concat([use ?? lease ?? Buffer.alloc(0), Buffer.from(text)]));  // no lease: a bare frame, which closes 4408
    },
  };
}
