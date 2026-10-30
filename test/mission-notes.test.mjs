import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { daemon, http, authenticated, remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';
import { md } from '../apps/web/src/helpers.mjs';

// Notes (threat model row 34): a folder outside the workspace, named in settings.notes_roots and shown by a space section.
const hash = (text) => createHash('sha256').update(text).digest('hex');
const ICM = 'IC' + 'M';
const BUILDER = { waiting: ICM + '/_tyler', registry: ICM + '/personal-projects/workspace-hub/registry.json', primary: ICM + '/personal-projects/AGENTS.md' };
async function seed(paths) {
  const w = paths.workspace, vault = path.join(paths.directory, 'vault');
  for (const file of [BUILDER.registry, BUILDER.primary]) await mkdir(path.join(w, path.dirname(file)), { recursive: true });
  await mkdir(path.join(w, BUILDER.waiting), { recursive: true });
  await writeFile(path.join(w, BUILDER.registry), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(w, BUILDER.primary), '# Projects\n');
  // ghost is named by a section but not in settings; spare is in settings but no section names it
  await writeFile(path.join(w, 'space.json'), JSON.stringify({ sections: [{ title: 'Journal', notes: 'vault' }, { title: 'Ghost', notes: 'ghost' },
    { title: 'Wide', notes: 'wide' }, { title: 'Ws', notes: 'ws' }] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ ...BUILDER, space: 'space.json',
    notes_roots: { vault, spare: vault, wide: paths.directory, ws: w } }));
  for (const dir of ['sub', '.obsidian', 'secrets', '_private']) await mkdir(path.join(vault, dir), { recursive: true });
  await writeFile(path.join(vault, 'old.md'), '# Old\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(vault, 'sub', 'today.md'), '# Today\n');
  await writeFile(path.join(vault, '.obsidian', 'workspace.md'), 'hidden');
  await writeFile(path.join(vault, 'secrets', 'keys.md'), 'locked');
  await writeFile(path.join(vault, '_private', 'diary.md'), 'locked');
  await writeFile(path.join(vault, 'picture.png'), 'not a note');
  await writeFile(path.join(paths.directory, 'outside.md'), 'outside the vault');
  await symlink(path.join(paths.directory, 'outside.md'), path.join(vault, 'link.md'));
  await symlink(paths.directory, path.join(vault, 'linkdir'));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
const start = (t) => daemon(t, undefined, false, seed);
const call = async (instance, route, method = 'GET', body) => {
  const result = await http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: result.status, body: JSON.parse(result.text || '{}') };
};
const read = (instance, root, file) => call(instance, '/mission/notes/file?' + new URLSearchParams({ root, path: file }));
const vaultOf = (instance) => path.join(instance.directory, 'vault');

test('notes: the list is the root\'s .md files, newest first, without dot folders or locked names', async (t) => {
  const instance = await start(t);
  const space = (await call(instance, '/mission')).body.space;
  assert.deepEqual(space.find((s) => s.title === 'Journal').notes, 'vault');
  const list = await call(instance, '/mission/notes?root=vault');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.files.map((f) => f.path), ['sub/today.md', 'old.md']);
  assert.deepEqual([list.body.total, list.body.shown, list.body.partial], [2, 500, false]);
  const note = await read(instance, 'vault', 'sub/today.md');
  assert.deepEqual([note.status, note.body.content, note.body.hash], [200, '# Today\n', hash('# Today\n')]);
  console.log('PASS notes list: newest first; .obsidian, secrets, _private, .png and links left out; read returns content and hash');
});

test('notes: a path outside the root is refused', async (t) => {
  const instance = await start(t);
  for (const file of ['../outside.md', 'sub/../../outside.md', '/etc/passwd.md']) assert.equal((await read(instance, 'vault', file)).status, 400, file);
  console.log('PASS notes outside: ../ and absolute paths refused (400)');
});

test('notes: a link out of the root is refused', async (t) => {
  const instance = await start(t);
  for (const file of ['link.md', 'linkdir/outside.md']) assert.equal((await read(instance, 'vault', file)).status, 400, file);
  const save = await call(instance, '/mission/notes/save', 'POST', { root: 'vault', path: 'link.md', hash: hash('outside the vault'), content: 'x' });
  assert.notEqual(save.status, 200);
  assert.equal(await readFile(path.join(instance.directory, 'outside.md'), 'utf8'), 'outside the vault');
  console.log('PASS notes links: a file link and a folder link out of the vault refused; the outside file unchanged');
});

test('notes: only .md files, and no dot names', async (t) => {
  const instance = await start(t);
  for (const file of ['picture.png', '.obsidian/workspace.md', 'old.md.txt']) assert.equal((await read(instance, 'vault', file)).status, 400, file);
  assert.equal((await call(instance, '/mission/notes/create', 'POST', { root: 'vault', path: 'run.sh', content: 'x' })).status, 400);
  console.log('PASS notes .md: .png, a .obsidian note and .md.txt refused; create refuses run.sh');
});

test('notes: a root must be in settings and named by a space section, and may not hold the workspace or home', async (t) => {
  const instance = await start(t);
  assert.deepEqual((await call(instance, '/mission/notes?root=ghost')).body.error, 'unknown-root');
  assert.deepEqual((await call(instance, '/mission/notes?root=spare')).body.error, 'unknown-root');
  assert.equal((await read(instance, 'ghost', 'old.md')).status, 404);
  for (const root of ['wide', 'ws']) assert.deepEqual([(await call(instance, '/mission/notes?root=' + root)).status, (await read(instance, root, 'outside.md')).status], [403, 403], root);
  console.log('PASS notes roots: not in settings 404, in settings but no section 404, a root holding home or the workspace 403');
});

test('notes: File protection refuses locked names inside a notes root', async (t) => {
  const instance = await start(t);
  for (const file of ['secrets/keys.md', '_' + 'private/diary.md']) assert.equal((await read(instance, 'vault', file)).status, 400, file);
  assert.equal((await call(instance, '/mission/notes/create', 'POST', { root: 'vault', path: 'secrets/new.md', content: 'x' })).status, 400);
  assert.equal((await call(instance, '/mission/notes/save', 'POST', { root: 'vault', path: '_' + 'private/diary.md', hash: hash('locked'), content: 'x' })).status, 400);
  assert.equal(await readFile(path.join(vaultOf(instance), '_private', 'diary.md'), 'utf8'), 'locked');
  console.log('PASS notes protection: secrets/ and _' + 'private/ refused for read, create and save');
});

test('notes: a save over a change on disk is a 409 with the disk version, and the disk is unchanged', async (t) => {
  const instance = await start(t);
  const file = path.join(vaultOf(instance), 'old.md');
  const opened = (await read(instance, 'vault', 'old.md')).body;
  const saved = await call(instance, '/mission/notes/save', 'POST', { root: 'vault', path: 'old.md', hash: opened.hash, content: '# Old\nmine\n' });
  assert.deepEqual([saved.status, saved.body.hash], [200, hash('# Old\nmine\n')]);
  await writeFile(file, '# Old\nfrom the notes app\n');
  const stale = await call(instance, '/mission/notes/save', 'POST', { root: 'vault', path: 'old.md', hash: saved.body.hash, content: '# Old\nmine again\n' });
  assert.deepEqual([stale.status, stale.body.kind, stale.body.diskContent, stale.body.diskHash], [409, 'conflict', '# Old\nfrom the notes app\n', hash('# Old\nfrom the notes app\n')]);
  assert.equal(await readFile(file, 'utf8'), '# Old\nfrom the notes app\n');
  // "Save mine over it" sends the disk hash it was shown
  assert.equal((await call(instance, '/mission/notes/save', 'POST', { root: 'vault', path: 'old.md', hash: stale.body.diskHash, content: '# Old\nmine again\n' })).status, 200);
  assert.equal(await readFile(file, 'utf8'), '# Old\nmine again\n');
  console.log('PASS notes conflict: 409 with diskContent and diskHash, disk unchanged; saving with the disk hash then writes');
});

test('notes: create and rename never replace a note that exists', async (t) => {
  const instance = await start(t);
  const vault = vaultOf(instance);
  assert.deepEqual(await call(instance, '/mission/notes/create', 'POST', { root: 'vault', path: 'sub/new.md', content: '# New\n' }), { status: 201, body: { path: 'sub/new.md', hash: hash('# New\n') } });
  assert.deepEqual((await call(instance, '/mission/notes/create', 'POST', { root: 'vault', path: 'sub/new.md', content: 'again' })).body.error, 'exists');
  assert.deepEqual((await call(instance, '/mission/notes/create', 'POST', { root: 'vault', path: 'nope/new.md', content: 'x' })).body.error, 'no-such-folder');
  const onto = await call(instance, '/mission/notes/rename', 'POST', { root: 'vault', path: 'sub/new.md', name: 'today.md' });
  assert.deepEqual([onto.status, onto.body.error], [409, 'exists']);
  assert.deepEqual([await readFile(path.join(vault, 'sub', 'new.md'), 'utf8'), await readFile(path.join(vault, 'sub', 'today.md'), 'utf8')], ['# New\n', '# Today\n']);
  assert.equal((await call(instance, '/mission/notes/rename', 'POST', { root: 'vault', path: 'sub/new.md', name: '../moved.md' })).status, 400);
  assert.deepEqual(await call(instance, '/mission/notes/rename', 'POST', { root: 'vault', path: 'sub/new.md', name: 'renamed.md' }), { status: 200, body: { path: 'sub/renamed.md' } });
  assert.equal(await readFile(path.join(vault, 'sub', 'renamed.md'), 'utf8'), '# New\n');
  await assert.rejects(access(path.join(vault, 'sub', 'new.md')));
  console.log('PASS notes create/rename: create twice 409, missing folder 404, rename onto a name 409 with both intact, ../ 400, rename moves it');
});

test('notes: HTML in a note is not rendered as HTML', () => {
  const html = md.parse('# Title\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) and <https://example.com>\n\n![pic](https://example.com/a.png)\n\n- item\n');
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<li>item<\/li>/);
  assert.doesNotMatch(html, /<script|<img|<a\b|<iframe|<[^>]*\son\w+=/i);
  assert.match(html, /&lt;script&gt;/);
  console.log('PASS notes preview: script, img onerror, a javascript: link, an autolink and a remote image render as text');
});

// The phone: Mission → the section's Notes row → a note opens in Files as a preview → edit → a change on disk is a conflict,
// not an overwrite → "Load disk version" and "Save mine over it" both do what they say.
test('notes on the phone: list, preview, and the conflict box', { timeout: 60000, skip: process.platform === 'win32' && 'Windows CI has no Playwright Chromium' }, async (t) => {
  const server = await remoteDaemon(t, { setup: seed });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-notes');
  const session = await enrollDevice(server, device);
  const page = device.page;
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  // ponytail: the dev space has no network, so Chromium says offline and Save stays disabled (phone.test.mjs, Issue #11 case).
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { get: () => true }); dispatchEvent(new Event('online')); });
  const file = path.join(server.directory, 'vault', 'old.md');
  await page.click('[data-nav="mission"]');
  await page.locator('#mission [data-open]', { has: page.locator('span', { hasText: /^Journal$/ }) }).click();
  await page.click('#mission dialog[open] summary:has-text("Notes")');
  await page.locator('#mission dialog[open] button[data-note="old.md"]').waitFor({ timeout: 10000 });
  assert.deepEqual(await page.locator('#mission dialog[open] button[data-note]').evaluateAll((b) => b.map((x) => x.dataset.note)), ['sub/today.md', 'old.md']);
  // Files opens with the note already set, so it lists no workspace folder (whose "Pick a file" could land over "Loaded").
  let listed = 0;
  page.on('request', (request) => { if (request.url().includes('/files/list')) listed++; });
  await page.click('#mission dialog[open] button[data-note="old.md"]');
  await page.locator('#rendered h1', { hasText: 'Old' }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#openPath').innerText(), 'old.md');
  assert.equal(await page.locator('#fileState').innerText(), 'Loaded');
  assert.equal(listed, 0, 'no folder list over the note');
  const edit = async (text) => {
    if (await page.locator('#editor').isHidden()) { await page.click('#moreFile'); await page.click('#sheetBody [data-file="preview"]'); }
    await page.click('#editor .cm-content');
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
  };
  // Load disk version: the draft gives way to what is on disk now
  await edit('draft\n');
  await writeFile(file, '# Old\nfrom the notes app\n');
  await page.click('#save');
  await page.locator('#conflict').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await readFile(file, 'utf8'), '# Old\nfrom the notes app\n');
  await page.click('#loadDisk');
  assert.equal(await page.evaluate(() => document.querySelector('#editor .cm-content').innerText.trim()), '# Old\nfrom the notes app');
  // Save mine over it: a second outside change, then the draft wins only when asked
  await edit('mine\n');
  await writeFile(file, '# Old\nchanged again\n');
  await page.click('#save');
  await page.locator('#conflict').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.locator('#fileState').innerText(), 'Conflict');
  assert.equal(await readFile(file, 'utf8'), '# Old\nchanged again\n');
  await page.click('#saveMine');
  await page.locator('#fileState', { hasText: 'Saved' }).waitFor({ timeout: 10000 });
  assert.equal(await readFile(file, 'utf8'), '# Old\nfrom the notes app\nmine\n');
  await page.click('#closeFile');
  await page.locator('section[data-view="mission"]').waitFor({ state: 'visible' });
  console.log('PASS notes phone: Journal → Notes lists newest first; a note opens as a preview; Load disk version and Save mine over it after a change on disk');
});
