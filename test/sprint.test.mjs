// Sprint tracker (Mission Control): GET /mission/sprint reads the coordinator's status file in the daemon user's home,
// POST /mission/sprint/tmux opens a P9 terminal running one fixed tmux attach, and the phone draws both. The desktop
// window, in Server mode, is in remote.test.mjs (it needs Electron's sandbox level).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';

const skip = process.platform === 'win32' ? 'tmux terminals; Windows has no Open tmux' : false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The dev space keeps no files: pictures go out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
export const STATUS = { sprint: 'Test sprint', updatedAt: '2026-10-27T14:30:00-05:00', cutoff: '07:00', token: 'not-for-clients', chunks: [
  { id: 'c1', title: 'Settings rows (sonnet)', state: 'merged', percent: 100 },
  { id: 'c2', title: 'Installer (opus)', state: 'running', percent: 40.6 },
  { id: 'c3', title: 'Phone layout (sonnet)', state: 'waiting', percent: 70, waitingOn: 'test run 4f2a in the queue' },
  { id: 'c4', title: 'x'.repeat(300), state: 'sideways', percent: 150, waitingOn: 5, secret: 'leak' }] };
const statusFile = (instance) => path.join(instance.directory, '.local', 'state', 'sprint', 'status.json');
const writeStatus = async (instance, value) => { await mkdir(path.dirname(statusFile(instance)), { recursive: true }); await writeFile(statusFile(instance), typeof value === 'string' ? value : JSON.stringify(value)); };

// The daemon's tmux lives in its own TMUX_TMPDIR, and so does the stand-in "p9" session Open tmux attaches to, so the
// test never reaches a real tmux server.
async function setup(paths) {
  const tmux = path.join(paths.directory, 'tmux');
  for (const dir of ['hub', 'projects', 'waiting']) await mkdir(path.join(paths.workspace, dir), { recursive: true });
  await mkdir(tmux, { mode: 0o700 });
  // The word is printed in two halves, so the echoed command line never contains it: only the run's output does.
  const script = (word) => [process.execPath, '-e', `console.log(${JSON.stringify(word.slice(0, 3))} + ${JSON.stringify(word.slice(3))})`];
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [
    { id: 'sprint-start', title: 'Sprint start', group: 'Sprint', cmd: script('start-ok'), confirm: true },
    { id: 'sprint-close', title: 'Sprint close', group: 'Sprint', cmd: script('close-ok'), confirm: true },
    { id: 'sprint-heavy', title: 'Heavy services', group: 'Sprint', cmd: script('heavy-ok'), confirm: true }], apps: [], pages: [] }));
  await writeFile(path.join(paths.workspace, 'projects', 'AGENTS.md'), '# Projects\n');
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', primary: 'projects/AGENTS.md', waiting: 'waiting' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')], env: { TMUX_TMPDIR: tmux } };
}
function sprintSession(t, instance) {
  const env = { ...process.env, TMUX_TMPDIR: path.join(instance.directory, 'tmux') }; delete env.TMUX;
  const tmux = (...args) => execFileSync('tmux', args, { env }).toString();
  tmux('new-session', '-d', '-s', 'p9', '-x', '80', '-y', '20', 'sh', '-c', 'echo SPRINT-SESSION-MARK; sleep 120');
  t.after(() => { try { tmux('kill-server'); } catch {} });
  return async () => { // the clients attached to the stand-in session, waited for up to 10 s
    let clients = '';
    for (const end = Date.now() + 10000; Date.now() < end && !(clients = tmux('list-clients', '-t', 'p9').trim()); ) await wait(100);
    return clients;
  };
}

test('Sprint route: no file is 404, a file is its known fields cut to size, a broken file says why', { skip, timeout: 60000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const get = () => server.desk('/mission/sprint');
  assert.deepEqual([(await get()).status, (await get()).body], [404, { error: 'no-sprint' }]);
  await writeStatus(server, STATUS);
  const read = await get();
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { sprint: 'Test sprint', updatedAt: '2026-10-27T14:30:00-05:00', cutoff: '07:00', chunks: [
    { id: 'c1', title: 'Settings rows (sonnet)', state: 'merged', percent: 100, waitingOn: '' },
    { id: 'c2', title: 'Installer (opus)', state: 'running', percent: 41, waitingOn: '' },
    { id: 'c3', title: 'Phone layout (sonnet)', state: 'waiting', percent: 70, waitingOn: 'test run 4f2a in the queue' },
    { id: 'c4', title: 'x'.repeat(200), state: 'unknown', percent: 100, waitingOn: '' }] });
  await writeStatus(server, '{"sprint": "half wri');
  assert.deepEqual([(await get()).status, (await get()).body], [422, { error: 'status-unreadable', reason: 'not-json' }]);
  await writeStatus(server, JSON.stringify({ sprint: 'big', chunks: [], pad: 'x'.repeat(300 * 1024) }));
  assert.deepEqual((await get()).body, { error: 'status-unreadable', reason: 'too-large' });
  await rm(statusFile(server));
  assert.equal((await get()).status, 404);
  console.log('PASS sprint route: 404 without the file; only known fields, cut and clamped; 422 not-json and too-large');
});

test('Open tmux: a body is refused; an empty one opens a P9 terminal attached to the sprint session', { skip, timeout: 60000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const clients = sprintSession(t, server);
  for (const body of [{ command: 'rm -r ~' }, [], { typed: 'x' }]) assert.deepEqual([(await server.desk('/mission/sprint/tmux', 'POST', body)).status], [400], JSON.stringify(body));
  const made = await server.desk('/mission/sprint/tmux', 'POST', {});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.match(made.body.terminal, /^[0-9a-f-]{36}$/);
  // Run, not only typed: the stand-in session gains a client (the P9 terminal's tmux attach).
  assert.notEqual(await clients(), '', 'nothing attached to the sprint session');
  console.log('PASS open tmux: bodies refused; {} made a terminal whose tmux attach reached the session');
});

async function signedInPage(browser, server) {
  const device = await passkeyDevice(browser, server, 'phone-sprint');
  const session = await enrollDevice(server, device);
  await device.context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => true })); // no network in the dev space
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.page.goto(server.origin + '/phone/');
  await device.page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await device.page.reload();
  await device.page.setViewportSize({ width: 390, height: 844 });
  return device;
}

test('Phone Sprint window: rings by state, the scripts ask first, Open tmux attaches, no file no tile', { skip, timeout: 90000 }, async (t) => {
  const server = await remoteDaemon(t, { setup });
  const clients = sprintSession(t, server);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page } = await signedInPage(browser, server);
  await page.click('[data-nav="mission"]');
  await page.waitForSelector('#mission .tiles', { timeout: 10000 });
  assert.equal(await page.locator('#sprint [data-open]').count(), 0, 'a Sprint tile with no status file');
  await writeStatus(server, STATUS);
  await page.click('[data-nav="mission"]');
  const tile = page.locator('#sprint [data-open="sprint"]');
  await tile.waitFor({ timeout: 10000 });
  assert.match(await tile.innerText(), /Sprint · Test sprint\s+1\/4/);
  await shot(page, 'phone-sprint-tile');
  await tile.click();
  const dialog = page.locator('#w-sprint[open]');
  await dialog.waitFor({ timeout: 5000 });
  assert.deepEqual(await dialog.locator('.spr').evaluateAll((rows) => rows.map((r) => [r.dataset.state, r.querySelector('.ring b').textContent])),
    [['merged', '100%'], ['running', '41%'], ['waiting', '70%'], ['unknown', '100%']]);
  assert.match(await dialog.locator('.spr[data-state="waiting"]').innerText(), /Waiting on: test run 4f2a in the queue/);
  const colours = await dialog.locator('.spr').evaluateAll((rows) => rows.map((r) => getComputedStyle(r).getPropertyValue('--ring-c').trim()));
  assert.equal(new Set(colours).size, 4, 'each state its own colour: ' + colours);
  assert.ok(await dialog.evaluate((d) => d.querySelector('.wbody').scrollWidth <= d.clientWidth + 1), 'the window is wider than the phone');
  await shot(page, 'phone-sprint-window');
  // A script asks first (confirm), then streams its output.
  const asked = [];
  page.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await dialog.locator('form[data-run] button', { hasText: 'Sprint start' }).click();
  await dialog.locator('pre[data-output]', { hasText: 'start-ok' }).waitFor({ timeout: 10000 });
  assert.deepEqual(asked, ['Run "Sprint start"?']);
  await shot(page, 'phone-sprint-ran');
  // Open tmux: the Terminal tab, on the new terminal, attached to the sprint session.
  await dialog.locator('[data-sprint-tmux]').click();
  await page.waitForFunction(() => document.body.dataset.view === 'terminal', null, { timeout: 5000 });
  await page.locator('#screen .xterm-rows', { hasText: 'SPRINT-SESSION-MARK' }).waitFor({ timeout: 15000 });
  assert.notEqual(await clients(), '');
  await shot(page, 'phone-sprint-tmux');
  // The file goes (sprint-close archives it): the tile goes on the next Mission load.
  await rm(statusFile(server));
  await page.click('[data-nav="mission"]');
  await page.waitForFunction(() => !document.querySelector('#sprint [data-open]'), null, { timeout: 10000 });
  console.log('PASS phone sprint: tile with the file, 4 rings in 4 colours, start asked first and ran, tmux attached, tile gone without the file');
});
