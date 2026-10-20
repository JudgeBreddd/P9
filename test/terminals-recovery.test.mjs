import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const terminals = pathToFileURL(fileURLToPath(new URL('../apps/server/terminals.mjs', import.meta.url))).href;

test('a failing tmux query at startup does not end the process; routes still fail', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-faketmux-'));
  await writeFile(path.join(dir, 'tmux'), '#!/bin/sh\necho boom >&2\nexit 1\n');
  await chmod(path.join(dir, 'tmux'), 0o755);
  const script = `
    const { createTerminals } = await import(${JSON.stringify(terminals)});
    const stmt = { all: () => [], run: () => {} };
    const t = createTerminals({ ledger: { db: { exec() {}, prepare: () => stmt } }, workspace: '/', lifecycle: {}, socket: 'p9recovery' });
    await new Promise((r) => setTimeout(r, 300));
    await t.list().then(() => console.log('resolved'), () => console.log('rejected'));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'rejected');
});

test('a socket closed while attach() waits on tmux leaves no tmux client (lock/revoke race, surface 13)', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-faketmux-'));
  const id = '11111111-2222-4333-8444-555555555555', calls = path.join(dir, 'calls');
  // A slow list-sessions holds attach() in its lookup; every call is logged, so a spawned control client shows.
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh\necho "$@" >> ${calls}\ncase "$*" in *list-sessions*) sleep 0.6; echo p9-${id};; esac\n`);
  await chmod(path.join(dir, 'tmux'), 0o755);
  const script = `
    const { EventEmitter } = await import('node:events');
    const { createTerminals } = await import(${JSON.stringify(terminals)});
    const row = { id: ${JSON.stringify(id)}, state: 'running' }, stmt = { all: () => [row], get: () => row, run: () => {} };
    const t = createTerminals({ ledger: { db: { exec() {}, prepare: () => stmt } }, workspace: '/', lifecycle: {}, socket: 'p9race' });
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, close() {}, ping() {}, terminate() {} });
    const attached = t.attach(row.id, ws, { destroyed: false });
    setTimeout(() => { ws.readyState = 3; ws.emit('close'); }, 100);
    await attached;
    await new Promise((r) => setTimeout(r, 300));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { readFileSync } = await import('node:fs');
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /attach-session/);
});

test('a device revoked while Stop Session waits on recovery kills nothing (surface 13)', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-faketmux-'));
  const id = '11111111-2222-4333-8444-555555555555', calls = path.join(dir, 'calls');
  // Startup recovery's list-sessions is slow, so stop() waits on it; the device is revoked during that wait.
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh\necho "$@" >> ${calls}\ncase "$*" in *list-sessions*) sleep 0.6; echo p9-${id};; esac\n`);
  await chmod(path.join(dir, 'tmux'), 0o755);
  const authority = pathToFileURL(fileURLToPath(new URL('../apps/server/authority.mjs', import.meta.url))).href;
  const script = `
    const { createTerminals } = await import(${JSON.stringify(terminals)});
    const { authority } = await import(${JSON.stringify(authority)});
    const row = { id: ${JSON.stringify(id)}, state: 'running' }, stmt = { all: () => [row], get: () => row, run: () => {} };
    const t = createTerminals({ ledger: { db: { exec() {}, prepare: () => stmt } }, workspace: '/', lifecycle: {}, socket: 'p9race' });
    let allowed = true;
    setTimeout(() => { allowed = false; }, 100);
    const outcome = await authority.run(() => allowed, () => t.stop(row.id)).then(() => 'stopped', (error) => error.message);
    console.log(outcome);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'session-ended');
  const { readFileSync } = await import('node:fs');
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /kill-session/);
});

test('a device revoked while Stop All waits on list-sessions kills nothing (surface 13)', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-faketmux-'));
  const id = '11111111-2222-4333-8444-555555555555', calls = path.join(dir, 'calls');
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh\necho "$@" >> ${calls}\ncase "$*" in *list-sessions*) sleep 0.6; echo p9-${id};; esac\n`);
  await chmod(path.join(dir, 'tmux'), 0o755);
  const authority = pathToFileURL(fileURLToPath(new URL('../apps/server/authority.mjs', import.meta.url))).href;
  const script = `
    const { createTerminals } = await import(${JSON.stringify(terminals)});
    const { authority } = await import(${JSON.stringify(authority)});
    const row = { id: ${JSON.stringify(id)}, state: 'running' }, stmt = { all: () => [row], get: () => row, run: () => {} };
    const t = createTerminals({ ledger: { db: { exec() {}, prepare: () => stmt } }, workspace: '/', lifecycle: {}, socket: 'p9race' });
    await t.recovered;
    let allowed = true;
    setTimeout(() => { allowed = false; }, 100);
    console.log(await authority.run(() => allowed, () => t.stopAll()).then((result) => result, (error) => error.message));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'session-ended');
  const { readFileSync } = await import('node:fs');
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /kill-session/);
});

test('frames ws hands over after the raw socket is destroyed (revoke, lock, expiry) never reach tmux (surface 13)', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-faketmux-'));
  const id = '11111111-2222-4333-8444-555555555555', calls = path.join(dir, 'calls');
  // attach-session logs what the daemon writes to the control client, so a send-keys line shows.
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh\necho "$@" >> ${calls}\ncase "$*" in *list-sessions*) echo p9-${id};; *attach-session*) cat >> ${calls};; *display-message*) echo 0 0;; esac\n`);
  await chmod(path.join(dir, 'tmux'), 0o755);
  const script = `
    const { EventEmitter } = await import('node:events');
    const { createTerminals } = await import(${JSON.stringify(terminals)});
    const row = { id: ${JSON.stringify(id)}, state: 'running' }, stmt = { all: () => [row], get: () => row, run: () => {} };
    const t = createTerminals({ ledger: { db: { exec() {}, prepare: () => stmt } }, workspace: '/', lifecycle: {}, socket: 'p9race' });
    let lease = null;
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, close() {}, ping() {}, terminate() {},
      send(data) { if (typeof data === 'string') lease = Buffer.from(JSON.parse(data).lease, 'hex'); } });
    const raw = { destroyed: false };
    await t.attach(row.id, ws, raw);
    for (let i = 0; i < 50 && !lease; i++) await new Promise((r) => setTimeout(r, 20));
    ws.emit('message', Buffer.concat([lease ?? Buffer.alloc(0), Buffer.from('MARK')]), true);
    raw.destroyed = true;  // what socket.destroy() does at once; ws may still emit frames it had read
    ws.emit('message', Buffer.concat([lease ?? Buffer.alloc(0), Buffer.from('LATE')]), true);
    await new Promise((r) => setTimeout(r, 300));
    ws.readyState = 3; ws.emit('close');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { readFileSync } = await import('node:fs');
  const log = readFileSync(calls, 'utf8');
  assert.match(log, /send-keys .* -H 4d 41 52 4b\n/, 'the frame before the destroy ran (positive control)');
  assert.doesNotMatch(log, /4c 41 54 45/, 'a frame after the destroy ran');
});

test('a key whose lease went out before a 10 s laptop sleep is refused, even with the wall clock set back (surface 13)', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-faketmux-'));
  const id = '11111111-2222-4333-8444-555555555555', calls = path.join(dir, 'calls');
  await writeFile(path.join(dir, 'tmux'), `#!/bin/sh\necho "$@" >> ${calls}\ncase "$*" in *list-sessions*) echo p9-${id};; *attach-session*) cat >> ${calls};; *display-message*) echo 0 0;; esac\n`);
  await chmod(path.join(dir, 'tmux'), 0o755);
  const script = `
    const { EventEmitter } = await import('node:events');
    const { createTerminals } = await import(${JSON.stringify(terminals)});
    const row = { id: ${JSON.stringify(id)}, state: 'running' }, stmt = { all: () => [row], get: () => row, run: () => {} };
    const t = createTerminals({ ledger: { db: { exec() {}, prepare: () => stmt } }, workspace: '/', lifecycle: {}, socket: 'p9sleep' });
    let lease = null, code = null;
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, close(c) { code ??= c; }, ping() {}, terminate() {},
      send(data) { if (typeof data === 'string') lease ??= Buffer.from(JSON.parse(data).lease, 'hex'); } });
    await t.attach(row.id, ws, { destroyed: false });
    for (let i = 0; i < 50 && !lease; i++) await new Promise((r) => setTimeout(r, 20));
    ws.emit('message', Buffer.concat([lease ?? Buffer.alloc(0), Buffer.from('MARK')]), true);
    // The laptop slept 10 s: CLOCK_BOOTTIME moved on while performance.now() stood still, and the wall clock, set back
    // by the same 10 s, shows no change, so only the boot clock shows the key is old.
    const fs = (await import('node:fs')).default, read = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => file === '/proc/uptime'
      ? (Number(read(file, 'latin1').split(' ')[0]) + 10).toFixed(2) + ' 0' : read(file, ...rest);
    ws.emit('message', Buffer.concat([lease ?? Buffer.alloc(0), Buffer.from('SLEPT')]), true);
    await new Promise((r) => setTimeout(r, 300));
    console.log('CODE', code);
    ws.readyState = 3; ws.emit('close');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { readFileSync } = await import('node:fs');
  const log = readFileSync(calls, 'utf8');
  assert.match(log, /send-keys .* -H 4d 41 52 4b\n/, 'the fresh key ran (positive control)');
  assert.doesNotMatch(log, /53 4c 45 50 54/, 'a key from before the sleep ran');
  assert.match(result.stdout, /CODE 4408/);
});
