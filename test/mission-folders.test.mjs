import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, utimes, realpath } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { daemon, http, authenticated, root, remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';
import os from 'node:os';
import { rootRefused } from '../apps/server/mission.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// Mission M2: folder lists (threat model row M2-a), registry references, and allow_folder (row M2-b).
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const SPACE = { sections: [
  { title: 'Plans', refs: ['hello', 'editor', 'dash', 'gone'], quick_note: { root: 'vault', path: 'plans' },
    logs: [{ id: 'vault-log', title: 'Vault log', root: 'vault', path: 'plans/a.md' }, { id: 'no-root-log', title: 'No root', root: 'nope', path: 'x.log' }], folders: [
    { id: 'open-plans', title: 'Open plans', root: 'vault', path: 'plans', pattern: '*.md', recursive: true, match: 'Status: open' },
    { id: 'all-plans', title: 'All plans', root: 'vault', path: 'plans', pattern: '*.md' },
    { id: 'run-logs', title: 'Run logs', path: 'logs', pattern: 'run-??.log' },
    { id: 'wide', title: 'Wide', root: 'wide' }] },
  { title: 'Bad', folders: [{ id: 'slash', title: 'Slash', pattern: 'a/b' }, { id: 'extra', title: 'Extra', where: 'x' }] },
  { title: 'Private', folders: [{ id: 'solo', title: 'Solo runs', path: '_' + 'private/solo-runs', pattern: '*.md', fix: 'Tidy this run.' }] }] };

async function seed({ directory, workspace }) {
  for (const folder of ['projects', 'hub', '_waiting', 'logs']) await mkdir(path.join(workspace, folder));
  await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n');
  await writeFile(path.join(workspace, SETTINGS.registry), JSON.stringify({ scripts: [{ id: 'hello', title: 'Hello', cmd: ['true'] }],
    apps: [{ id: 'editor', title: 'Editor', cmd: ['true'] }], pages: [{ id: 'dash', title: 'Dashboard', url: 'https://example.com' }] }));
  await writeFile(path.join(workspace, SETTINGS.space), JSON.stringify(SPACE, null, 2) + '\n');
  for (const name of ['run-01.log', 'run-02.log', 'run-100.log', 'notes.txt']) await writeFile(path.join(workspace, 'logs', name), 'x\n');
  await mkdir(path.join(workspace, '_private', 'solo-runs'), { recursive: true });
  for (const name of ['run.md', '.env.md']) await writeFile(path.join(workspace, '_private', 'solo-runs', name), '# Solo run\n');
  const vault = path.join(directory, 'vault'), plans = path.join(vault, 'plans');
  await mkdir(path.join(plans, 'sub'), { recursive: true });
  // 3 hold the line (one indented, in a subfolder), 1 does not, 1 is a link to a file outside the root that holds it too.
  const files = { 'a.md': '# A\nStatus: open\n', 'sub/b.md': '# B\n  Status: open  \n', 'c.md': 'Status: open\n', 'd.md': '# D\nStatus: closed\n' };
  let minute = 0;
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(plans, name), text);
    const when = new Date(Date.UTC(2026, 0, 1, 0, minute += 1));
    await utimes(path.join(plans, name), when, when);
  }
  await writeFile(path.join(directory, 'outside.md'), 'Status: open\n');
  await symlink(path.join(directory, 'outside.md'), path.join(plans, 'link.md'));
  await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ ...SETTINGS, notes_roots: { vault, wide: directory } }));
  await mkdir(path.join(directory, 'other'));
  return { args: ['--acp-override', fake, '--settings', path.join(directory, 'settings.json')] };
}
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const start = (t) => daemon(t, undefined, false, seed);
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ status: result.status, body: result.text ? JSON.parse(result.text) : null }));
const list = (instance, id) => call(instance, '/mission/folder?' + new URLSearchParams({ id }));
const open = (instance, id, file) => call(instance, '/mission/folder/file?' + new URLSearchParams({ id, path: file }));

test('folder list: 3 files holding the line, newest first; the link out of the root is refused', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const overview = (await call(instance, '/mission')).body;
  const plans = overview.space.find((section) => section.title === 'Plans');
  assert.deepEqual(plans.folders.map((folder) => folder.id), ['open-plans', 'all-plans', 'run-logs', 'wide']);
  const matched = await list(instance, 'open-plans');
  assert.equal(matched.status, 200);
  assert.deepEqual(matched.body.files.map((file) => file.path), ['plans/c.md', 'plans/sub/b.md', 'plans/a.md']);
  assert.deepEqual([matched.body.total, matched.body.partial], [3, false]);
  assert.equal(matched.body.files[1].name, 'sub/b.md');
  // Not recursive, no match: the folder's own .md files, still without the link.
  assert.deepEqual((await list(instance, 'all-plans')).body.files.map((file) => file.name), ['d.md', 'c.md', 'a.md']);
  assert.deepEqual((await open(instance, 'open-plans', 'plans/link.md')).status, 404);
  assert.deepEqual((await open(instance, 'open-plans', 'plans/../../outside.md')).status, 404);
  assert.deepEqual((await open(instance, 'open-plans', 'plans/d.md')).status, 404, 'a file the list does not hold');
  const opened = await open(instance, 'open-plans', 'plans/sub/b.md');
  assert.deepEqual([opened.status, opened.body.text], [200, '# B\n  Status: open  \n']);
  console.log('PASS folder list: 3 rows, newest first; link.md, .. and an unlisted file are refused');
});

test('folder list: workspace folders, ? patterns, refused roots and malformed items', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  assert.deepEqual((await list(instance, 'run-logs')).body.files.map((file) => file.name).sort(), ['run-01.log', 'run-02.log']);
  assert.deepEqual([(await list(instance, 'wide')).status, (await list(instance, 'wide')).body.error], [403, 'root-refused']);
  assert.equal((await list(instance, 'nope')).status, 404);
  assert.equal((await list(instance, '../x')).status, 400);
  const mission = (await call(instance, '/mission')).body;
  const invalid = mission.invalid.filter((entry) => entry.reason === 'malformed-record').map((entry) => entry.detail);
  assert.equal(invalid.length, 1);
  assert.match(invalid.join('\n'), /pattern: /);
  // An unknown field is kept, as on every item (W-F): the folder still lists, and the page gets the extra key.
  assert.deepEqual(mission.space.find((section) => section.title === 'Bad').folders, [{ where: 'x', id: 'extra', title: 'Extra' }]);
  console.log('PASS folder list: ? pattern, a root holding the workspace 403, unknown id 404, bad id 400, malformed items dropped');
});

// Wall 10: logs outside the workspace (~/icm-logs, ~/.local/state/sprint). allow_folder takes a folder in the home folder,
// never the home folder itself, and a log view reads its file inside an allowed root.
test('log view root: a log in an allowed folder shows; a root not allowed does not; a home subfolder can be allowed', { timeout: 60000 }, async (t) => {
  const home = os.homedir(), guard = { workspace: path.join(home, 'no-such-workspace'), recovery: path.join(home, 'no-such-recovery') };
  assert.deepEqual([await rootRefused(path.join(home, 'icm-logs'), guard), await rootRefused(path.join(home, '.local/state/sprint'), guard), await rootRefused(home, guard)], [false, false, true]);
  const instance = await start(t);
  const log = (name) => call(instance, '/mission/space-log?' + new URLSearchParams({ name }));
  const shown = await log('vault-log');
  assert.equal(shown.status, 200);
  assert.match(shown.body.text, /Status: open/);
  assert.deepEqual([(await log('no-root-log')).status, (await log('no-root-log')).body.error], [404, 'unknown-root']);
});

// P11 (owner, 2026-11-02: "don't restrict access to people's machine or files"): a space folder in _private lists and
// opens with File protection on; .env names stay hidden, and the editor's own routes still refuse _private.
test('P11: a space folder inside _private lists and opens with File protection on; keys stay hidden', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  assert.equal((await call(instance, '/file-protection')).body.on, true);
  const solo = await list(instance, 'solo');
  assert.deepEqual([solo.status, solo.body.files.map((file) => file.name)], [200, ['run.md']]);
  const opened = await open(instance, 'solo', '_' + 'private/solo-runs/run.md');
  assert.deepEqual([opened.status, opened.body.text], [200, '# Solo run\n']);
  assert.equal((await open(instance, 'solo', '_' + 'private/solo-runs/.env.md')).status, 404);
  assert.equal((await call(instance, '/files?' + new URLSearchParams({ path: '_' + 'private/solo-runs/run.md' }))).status >= 400, true, 'the editor still refuses it');
  // Review 3 L1: seeing it is not sending it. Fix with Claude would put the file in a chat's prompt, so with File protection
  // on it is refused before any chat is made; off, Fix goes ahead as before.
  const fix = () => call(instance, '/mission/fix', 'POST', { id: 'solo', path: '_' + 'private/solo-runs/run.md' });
  const chats = async () => (await call(instance, '/chat')).body;
  const before = JSON.stringify(await chats());
  assert.deepEqual([(await fix()).status, (await fix()).body.error], [403, 'file-protection'], 'Fix with File protection on');
  assert.equal(JSON.stringify(await chats()), before, 'no chat was made');
  assert.equal((await call(instance, '/file-protection', 'POST', { on: false })).body.on, false);
  const off = await fix();
  assert.notEqual(off.body?.error, 'file-protection', 'Fix with File protection off: ' + JSON.stringify(off));
  console.log('PASS P11: _' + 'private/solo-runs lists run.md and opens it with File protection on; .env.md hidden; /files refuses; Fix refused until File protection is off');
});

test('refs: found ones name their script, app or page; a missing ID says so', { timeout: 60000 }, async (t) => {
  const instance = await start(t);
  const refs = (await call(instance, '/mission')).body.space.find((section) => section.title === 'Plans').refs;
  assert.deepEqual(refs, [{ id: 'hello', kind: 'scripts', title: 'Hello' }, { id: 'editor', kind: 'apps', title: 'Editor' },
    { id: 'dash', kind: 'pages', title: 'Dashboard' }, { id: 'gone', missing: true }]);
  console.log('PASS refs: 3 resolved, gone is missing');
});

async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return { hit, cursor: after };
  }
  throw new Error('event-timeout');
}
async function agent(t, instance) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude' });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  const { hit, cursor } = await until(instance, (event) => event.conversation === conversation && event.data?.content?.text?.startsWith('mcp:'));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  const tool = async (name, args = {}, options) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, options)).content[0].text);
  return { conversation, tool, cursor };
}

test('allow_folder: nothing is added without the user\'s yes; P9\'s own folders are refused before asking', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const { conversation, tool, cursor } = await agent(t, instance);
  const settingsFile = path.join(instance.directory, 'settings.json'), before = await readFile(settingsFile, 'utf8');
  const other = path.join(instance.directory, 'other');
  const approval = (after) => until(instance, (event) => event.conversation === conversation && event.type === 'approval', after);
  const answer = (request, optionId) => call(instance, `/chat/${conversation}/answer`, 'POST', { request, answer: { optionId } });

  let pending = tool('allow_folder', { name: 'other', folder: other });
  let asked = await approval(cursor);
  assert.equal(asked.hit.data.toolCall.title, 'P9 Mission Control: let Mission list the folder ' + await realpath(other) + ', named other. Mission reads it, and a checklist in your space can change the review and mark lines of files in it, nothing else.');
  await answer(asked.hit.data.request, 'reject');
  assert.equal((await pending).error, 'not-allowed');
  assert.equal(await readFile(settingsFile, 'utf8'), before);

  const controller = new AbortController();
  pending = tool('allow_folder', { name: 'other', folder: other }, { signal: controller.signal });
  asked = await approval(asked.cursor);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(await readFile(settingsFile, 'utf8'), before);

  // Refused with no prompt (a prompt here would hang the call): a folder holding the workspace, a drive root, a relative path, a taken name.
  assert.equal((await tool('allow_folder', { name: 'wide2', folder: instance.directory })).error, 'root-refused');
  assert.equal((await tool('allow_folder', { name: 'top', folder: '/' })).error, 'root-refused');
  assert.equal((await tool('allow_folder', { name: 'rel', folder: 'other' })).error, 'request-refused');
  assert.equal((await tool('allow_folder', { name: 'vault', folder: other })).error, 'name-taken');
  assert.equal(await readFile(settingsFile, 'utf8'), before);

  pending = tool('allow_folder', { name: 'other', folder: other });
  asked = await approval(asked.cursor);
  await answer(asked.hit.data.request, 'allow');
  const added = await pending;
  assert.equal(added.name, 'other', JSON.stringify(added));
  const after = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.deepEqual(after, { ...JSON.parse(before), notes_roots: { ...JSON.parse(before).notes_roots, other: await realpath(other) } });
  console.log('PASS allow_folder: reject and cancel write nothing; refused folders never ask; allow adds only that key');
});

// The phone (plan: one look for every focus mode): the section's window shows folder lists with their counts and the
// references; a folder row lists its files newest first, and a file opens read-only; a missing reference says not found.
test('folder lists and references on the phone at 390x844', { timeout: 90000, skip: process.platform === 'win32' && 'Windows CI has no Playwright Chromium' }, async (t) => {
  const server = await remoteDaemon(t, { setup: seed });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-folders');
  const session = await enrollDevice(server, device);
  const page = device.page;
  // The dev space has no network, so Chromium says offline and the phone sends no write: say online, as the other phone tests do.
  await device.context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true }));
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-nav="mission"]');
  const tile = page.locator('#mission [data-open]', { has: page.locator('span', { hasText: /^Plans$/ }) });
  await tile.waitFor({ timeout: 15000 });
  await tile.click();
  const box = page.locator('#mission dialog[open]');
  // Counts fill when the window opens: 3 open plans, 3 top-level .md plans, 2 run logs; the root holding the workspace is refused.
  await box.locator('[data-folder-count="open-plans"]', { hasText: '3' }).waitFor({ timeout: 10000 });
  assert.deepEqual(await box.locator('[data-folder-count]').evaluateAll((all) => all.map((n) => n.textContent.trim())), ['3', '3', '2', 'refused']);
  assert.deepEqual(await box.locator('[data-ref]').evaluateAll((all) => all.map((n) => n.dataset.ref)), ['hello', 'editor', 'dash']);
  assert.match(await box.locator('[data-ref-missing]').innerText(), /gone\s*not found/);
  await shot(page, 'phone-space-event-horizon-prime');
  // The phone's own theme menu (it does not follow the browser's scheme), then the same window again in Daylight.
  await page.keyboard.press('Escape');
  await page.click('[data-nav="chat"]');
  await page.click('[data-bar="chat"] #themeBtn');
  await page.click('#themeMenu [data-theme-pick="daylight"]');
  await page.keyboard.press('Escape');
  await page.click('[data-nav="mission"]');
  await tile.click();
  await box.locator('[data-folder-count="open-plans"]', { hasText: '3' }).waitFor({ timeout: 10000 });
  await shot(page, 'phone-space-daylight');
  await box.locator('summary', { hasText: 'Open plans' }).click();
  const files = box.locator('[data-folder="open-plans"] summary');
  await files.first().waitFor({ timeout: 10000 });
  assert.deepEqual(await files.evaluateAll((all) => all.map((n) => n.firstChild.textContent.trim())), ['c.md', 'sub/b.md', 'a.md']);
  await files.nth(1).click();
  await box.locator('[data-folder="open-plans"] pre', { hasText: 'Status: open' }).waitFor({ timeout: 10000 });
  // Read-only lists: the Quick note form is the one writable field (create-only, row 76).
  assert.equal(await box.locator(':is(textarea, [contenteditable="true"]):not([data-quicknote] *)').count(), 0, 'read-only');
  await shot(page, 'phone-space-folder');
  // Quick note from the phone (threat model row 76): one new file in the section's folder, through the phone's own form.
  await page.keyboard.press('Escape');
  await tile.click();
  const quick = box.locator('[data-quicknote]');
  await quick.locator('[name="title"]').fill('Phone idea');
  await quick.locator('[name="body"]').fill('from the phone');
  await quick.locator('button[type="submit"]').click();
  await quick.locator('[data-qn-status]', { hasText: 'Saved plans/Phone idea.md.' }).waitFor({ timeout: 10000 });
  await shot(page, 'phone-quick-note');
  const vaultDir = path.join(server.directory, 'vault');
  assert.equal(await readFile(path.join(vaultDir, 'plans', 'Phone idea.md'), 'utf8'), 'from the phone\n');
  const create = (body) => page.evaluate(async ([csrf, body]) => { const r = await fetch('/mission/notes/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-p9-csrf': csrf, 'x-p9-op': crypto.randomUUID() }, body: JSON.stringify(body) });
    return r.status; }, [session.csrf, body]);
  assert.equal(await create({ root: 'vault', path: 'plans/Phone idea.md', content: 'replaced?' }), 409, 'an existing name is refused');
  assert.equal(await readFile(path.join(vaultDir, 'plans', 'Phone idea.md'), 'utf8'), 'from the phone\n');
  assert.equal(await create({ root: 'vault', path: 'outside.md', content: 'x' }), 404, 'outside the quick note folder');
  assert.equal(await create({ root: 'vault', path: 'plans/sub/deeper.md', content: 'x' }), 404, 'a subfolder is outside too');
  assert.equal(await create({ root: 'vault', path: 'plans/big.md', content: 'x'.repeat(70 * 1024) }), 413, 'size cap');
  // Only the desktop main process may set the vault folder (threat model row 73): a phone is refused even with its session.
  const vault = await page.evaluate(async (csrf) => { const r = await fetch('/mission/vault', { method: 'POST', headers: { 'content-type': 'application/json', 'x-p9-csrf': csrf, 'x-p9-op': crypto.randomUUID() }, body: JSON.stringify({ folder: '/tmp' }) });
    return { status: r.status, body: await r.json().catch(() => ({})) }; }, session.csrf);
  assert.deepEqual(vault, { status: 403, body: { error: 'desktop-only' } }, 'a phone cannot set the vault');
  console.log('PASS phone: counts 3/3/2/refused, 3 refs + not found, files newest first, one opens read-only');
});
