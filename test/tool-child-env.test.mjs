// PD-2 (second half): the update's pnpm and the phone's Rebuild + reload start with childEnv() plus child-env.mjs's
// TOOL_NAMES, not the daemon's whole environment. A token the daemon holds (npm_config__authToken) or a GIT_DIR from a
// git hook stays behind; the owner's proxy (HTTPS_PROXY) still reaches pnpm. The agents fetch (setup-routes.mjs) runs only in
// a daemon bundle (agents.json beside it; slim-bundle.test.mjs drives it), so here its list is read from the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';
import { createUpdate } from '../apps/server/update.mjs';
import * as childEnvModule from '../apps/server/child-env.mjs';

const skip = process.platform === 'win32' ? 'the update and the rebuild are Linux only' : false;
const PLANTED = { npm_config__authToken: 'planted-token', GIT_DIR: '/nonexistent/planted-git-dir', HTTPS_PROXY: 'http://127.0.0.1:9',
  P9_GITHUB_TOKEN: 'planted-github', P9_MCP_TOKEN: 'planted-mcp' };
// A node stand-in (no shell) that writes the environment it was given to `out` and fails, so nothing builds for real.
async function standIn(file, out) {
  await writeFile(file, '#!' + process.execPath + '\nrequire("fs").writeFileSync(' + JSON.stringify(out) + ', JSON.stringify(process.env)); process.exit(1);\n');
  await chmod(file, 0o755);
}
const seen = async (out) => {
  for (let end = Date.now() + 30000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const text = await readFile(out, 'utf8').catch(() => null);
    if (text) return JSON.parse(text);
  }
  assert.fail('the stand-in never ran');
};
const check = (env, what) => {
  assert.equal(env.npm_config__authToken, undefined, what + ': the daemon\'s npm token stayed behind');
  assert.equal(env.GIT_DIR, undefined, what + ': the daemon\'s GIT_DIR stayed behind');
  for (const name of ['P9_GITHUB_TOKEN', 'P9_MCP_TOKEN']) assert.equal(env[name], undefined, what + ': the daemon\'s ' + name + ' stayed behind');
  assert.equal(env.HTTPS_PROXY, PLANTED.HTTPS_PROXY, what + ': the owner\'s proxy reached it');
};

test('the update\'s pnpm gets childEnv() plus the tool names: no npm token, no GIT_DIR, the proxy kept', { skip, timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-toolenv-'));
  const source = path.join(dir, 'share', 'source'), bin = path.join(dir, 'bin'), out = path.join(dir, 'pnpm-env.json');
  const saved = { ...process.env };
  t.after(async () => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); await rm(dir, { recursive: true, force: true }); });
  for (const [name, text] of Object.entries({ 'package.json': JSON.stringify({ version: '0.1.0' }), 'pnpm-lock.yaml': '', 'apps/server/main.mjs': '' })) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), text);
  }
  await mkdir(bin);
  await standIn(path.join(bin, 'pnpm'), out);
  const src = path.join(dir, 'src', 'p9');
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  const tarball = path.join(dir, 'p9.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', path.dirname(src), 'p9']);
  const data = await readFile(tarball);
  // The daemon's own environment: systemd's INVOCATION_ID (an update needs it), the stand-in first on PATH, and the planted names.
  Object.assign(process.env, { INVOCATION_ID: 'test', PATH: bin + path.delimiter + process.env.PATH }, PLANTED);
  const update = createUpdate({ ownership: path.join(dir, 'own'), state: path.join(dir, 'state'), chat: {}, lifecycle: {}, version: '0.1.0', root: source });
  const id = randomUUID();
  assert.equal((await update.part(id, { offset: 0, data: data.toString('base64') })).status, 200);
  assert.equal((await update.commit(id, { version: '0.2.0', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })).status, 202);
  const env = await seen(out);
  check(env, 'update');
  assert.equal(env.CI, '1', 'update: CI=1 as before');
  console.log('PASS tool child env: the update\'s pnpm got no npm_config__authToken, GIT_DIR, P9_GITHUB_TOKEN or P9_MCP_TOKEN; HTTPS_PROXY and CI=1 reached it');
});

test('the phone\'s Rebuild + reload gets childEnv() plus the tool names: no npm token, no GIT_DIR, the proxy kept', { skip, timeout: 120000 }, async (t) => {
  let out;
  const server = await remoteDaemon(t, { setup: async (paths) => {
    out = path.join(paths.directory, 'build-env.json');
    const file = path.join(paths.directory, 'build');
    await standIn(file, out);
    return { env: { ...PLANTED, P9_BUILD: file } };
  } });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const session = await enrollDevice(server, await passkeyDevice(browser, server, 'phone'));
  const built = await server.remote('/rebuild', { method: 'POST', session, body: {} });
  assert.equal(built.status, 500, 'the stand-in fails on purpose');
  check(await seen(out), 'rebuild');
  console.log('PASS tool child env: the rebuild got no npm_config__authToken, GIT_DIR, P9_GITHUB_TOKEN or P9_MCP_TOKEN; HTTPS_PROXY reached it');
});

// CI on the first head: the fetch was given TOOL_NAMES alone, so scripts/agents.mjs lost P9_AGENTS_FROM, went for the real
// download, and slim-bundle.test.mjs hung on its FIFO. Whatever list the fetch's start names must keep every P9_* name the
// script reads, and still drop the planted token and GIT_DIR.
test('the agents fetch keeps the P9_* names scripts/agents.mjs reads, and drops the npm token and GIT_DIR', async () => {
  const route = await readFile(new URL('../apps/server/setup-routes.mjs', import.meta.url), 'utf8');
  const start = route.slice(route.indexOf("'/setup/agents-fetch'"));
  const list = /execFile\(process\.execPath, \[script[^\n]*env: childEnv\(process\.env, process\.platform, (\w+)\)/.exec(start)?.[1];
  assert.ok(list && Array.isArray(childEnvModule[list]), 'the fetch starts with childEnv() and a list child-env.mjs exports: ' + list);
  const script = await readFile(new URL('../scripts/agents.mjs', import.meta.url), 'utf8');
  const reads = [...new Set([...script.matchAll(/process\.env\.(P9_\w+)/g)].map(([, name]) => name))];
  assert.ok(reads.includes('P9_AGENTS_FROM'), 'agents.mjs reads P9_AGENTS_FROM');
  const source = { HOME: '/h', PATH: '/usr/bin', ...PLANTED, ...Object.fromEntries(reads.map((name) => [name, '/from'])) };
  const env = childEnvModule.childEnv(source, 'linux', childEnvModule[list]);
  for (const name of reads) assert.equal(env[name], '/from', 'the fetch keeps ' + name);
  check(env, 'agents fetch');
  console.log('PASS tool child env: the agents fetch keeps ' + reads.join(', ') + ' and HTTPS_PROXY, drops the npm token, GIT_DIR, P9_GITHUB_TOKEN and P9_MCP_TOKEN');
});
