// N1 step 2 (points 9-11): New project with its three places for the work, the project page, MC-18, and a chat's Rename,
// Archive and Delete. Real Electron, the real daemon and the fake agent; the native folder dialog is stubbed in main.
// The dialog offers the chats already started in a picked folder (never ticked for you) and names a project already using
// it; the page edits name, about and instructions in place, adds and removes files, shows the folder's own AGENTS.md;
// delete leaves a folder the user chose alone and moves the chats to Chats; a gone folder shows Locate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root, shellReady } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + (typeof what === 'function' ? await what() : what));
};
const conv = async (instance, id) => (await call(instance, '/chat')).conversations.find((c) => c.id === id);
const ended = (instance, id) => until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.some((e) => e.type === 'turn-end'), id + ' answered');
const project = async (instance, name) => (await call(instance, '/projects')).projects.find((p) => p.name === name);

async function launch(t, instance) {
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-projects-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  // The native folder dialog answers with the folder the test names next.
  const pickNext = (folder) => app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
  return { app, page, errors, pickNext };
}
const zoneOf = (page, id) => page.evaluate((id) => document.querySelector(`#navList .row[data-chat="${id}"]`)?.closest('[data-zone]')?.dataset.zone ?? null, id);
const treeRoot = (page) => page.evaluate(() => document.querySelector('#tree .where')?.textContent ?? null);

test('projects: New project (three places, adopt offer, shared folder), the page, MC-18', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace;
  await mkdir(path.join(ws, 'garden'), { recursive: true }); await mkdir(path.join(ws, 'other'), { recursive: true });
  await writeFile(path.join(ws, 'garden', 'AGENTS.md'), '# the folder\'s own\n');
  // Another project already uses garden (two may share one); two chats were started there in no project.
  assert.equal((await call(instance, '/projects', 'POST', { name: 'Old garden', work: { kind: 'linked', folder: 'garden' } })).status, 201);
  const create = async (body, text) => {
    const r = await call(instance, '/chat', 'POST', { provider: 'claude', ...body });
    assert.equal(r.status, 201, JSON.stringify(r));
    if (text) { await call(instance, '/chat/' + r.conversation + '/prompt', 'POST', { text }); await ended(instance, r.conversation); }
    return r.conversation;
  };
  const g1 = await create({ folder: 'garden' }, 'title Bed layout'), g2 = await create({ folder: 'garden' }, 'title Drip line');
  const elsewhere = await create({ folder: 'other' }, 'title Elsewhere');
  const moved = await create({ folder: 'other' }, 'title Moved in');

  const { page, errors, pickNext } = await launch(t, instance);
  await page.locator('#navList [data-newproj]').first().click();
  const dlg = page.locator('#pjNew');
  await dlg.waitFor({ state: 'visible', timeout: 5000 });
  await dlg.locator('input[name=name]').fill('Garden');
  await dlg.locator('textarea[name=about]').fill('Beds and watering');
  await dlg.locator('#pjW2').check();
  await pickNext(path.join(ws, 'garden'));
  await dlg.locator('[data-pick=linked]').click();
  await dlg.locator('[data-show=linked]', { hasText: 'garden' }).waitFor({ timeout: 5000 });
  await dlg.locator('.shared', { hasText: 'Old garden already uses this folder' }).waitFor({ timeout: 5000 });
  await dlg.locator('.found', { hasText: '2 chats were started in this folder' }).waitFor({ timeout: 5000 });
  assert.equal(await dlg.locator('#pjAdopt').isChecked(), false, 'the offer is never ticked for you');
  await dlg.locator('#pjAdopt').check();
  await dlg.locator('button[type=submit]').click();
  await page.locator('#projPage h1', { hasText: 'Garden' }).waitFor({ timeout: 10000 });
  const garden = await project(instance, 'Garden');
  assert.deepEqual(garden.work, { kind: 'linked', folder: 'garden' });
  assert.equal(garden.about, 'Beds and watering');
  for (const id of [g1, g2]) assert.equal((await conv(instance, id)).project, garden.id, 'the offered chats moved in');
  assert.equal((await conv(instance, elsewhere)).project, null);
  assert.ok(await page.locator('#chats').isHidden(), 'the page shows in place of the chats');

  // The page: chats first, the folder's own AGENTS.md noted, Open on the work folder.
  await until(async () => (await page.locator('#projPage .sec').first().locator('.crow').count()) === 2, 'the two chats on the page');
  await page.locator('#projPage .ownfile', { hasText: 'AGENTS.md' }).waitFor({ timeout: 5000 });
  await page.locator('#projPage .wf .mono', { hasText: 'garden' }).waitFor({ timeout: 5000 });
  await page.locator('#projPage [data-pj=open]').click();
  await until(async () => (await treeRoot(page)) === 'garden', 'Open shows the work folder in the Files pane (' + await treeRoot(page) + ')');

  // Rename, about and instructions, in place.
  await page.locator('#pjName').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('Garden beds'); await page.keyboard.press('Enter');
  await until(async () => (await project(instance, 'Garden beds'))?.id === garden.id, 'renamed on the daemon');
  await page.locator(`#navList [data-proj="${garden.id}"]`, { hasText: 'Garden beds' }).waitFor({ timeout: 5000 });
  await page.locator('#pjAbout').click(); await page.keyboard.press('Control+a'); await page.keyboard.type('Raised beds'); await page.keyboard.press('Tab');
  await until(async () => (await project(instance, 'Garden beds'))?.about === 'Raised beds', 'about saved');
  await page.locator('#projPage [data-pj=edit]').click();
  await page.locator('#pjInstr').fill('Use metric.\nKeep it short.\nCite the plan.\nOne more line.');
  await until(async () => (await call(instance, '/projects/' + garden.id)).project.instructions.startsWith('Use metric.'), 'instructions saved while typing');
  await page.locator('#projPage [data-pj=edit]').click();
  await page.locator('#projPage .instr-all', { hasText: 'Show 1 more line' }).waitFor({ timeout: 5000 });

  // Added files: add, listed with a size, removed.
  await page.locator('#projPage ~ input[type=file]').setInputFiles({ name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from('# Plan\n') });
  await page.locator('#projPage .crow.file', { hasText: 'plan.md' }).waitFor({ timeout: 10000 });
  assert.deepEqual((await call(instance, '/projects/' + garden.id)).project.files, [{ name: 'plan.md', size: 7 }]);
  await page.locator('#projPage .crow.file [data-pj=rm]').click();
  await until(async () => !(await call(instance, '/projects/' + garden.id)).project.files.length, 'file removed');

  // A1, A4: Sprint setup. A refused address says so and saves nothing; a good one and a setup command are saved.
  await page.locator('#pjSpSource').fill('ext::sh -c id');
  await page.locator('#projPage [data-pj=spset]').click();
  await page.locator('.toast', { hasText: 'P9 clones only from' }).first().waitFor({ timeout: 5000 });
  assert.deepEqual((await call(instance, '/projects/' + garden.id)).project.sprint, { source: '', setup: '' });
  await page.locator('#pjSpSource').fill(' https://example.com/garden/beds.git ');
  await page.locator('#pjSpSetup').fill('pnpm install');
  await page.locator('#pjSpSetup').press('Enter');
  await until(async () => (await call(instance, '/projects/' + garden.id)).project.sprint.setup === 'pnpm install', 'sprint setup saved');
  assert.deepEqual((await call(instance, '/projects/' + garden.id)).project.sprint, { source: 'https://example.com/garden/beds.git', setup: 'pnpm install' });
  await page.locator('#pjSpSetup').scrollIntoViewIfNeeded();
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-setup ' + (await page.screenshot({ type: 'png' })).toString('base64'));

  // MC-18: a chat moved into the project shows the project's work folder, not its own; a chat in no project keeps its own.
  assert.equal((await call(instance, '/chat/' + moved + '/project', 'POST', { project: garden.id })).status, 200);
  // The chat in no project first, so the tree is off 'garden' (Open left it there) before the project's chat is checked.
  await page.locator(`#navList .row[data-chat="${elsewhere}"]`).click();
  await page.locator(`#chats .pane[data-id="${elsewhere}"]`).waitFor({ timeout: 10000 });
  assert.ok(await page.locator('#projPage').isHidden(), 'opening a chat leaves the page');
  await until(async () => (await treeRoot(page)) === 'other', async () => 'the chat in no project: its own folder (' + await treeRoot(page) + ')');
  await page.locator(`#navList .row[data-chat="${moved}"]`).click();
  await until(async () => (await treeRoot(page)) === 'garden', async () => 'the chat in the project: its work folder, not its own (' + await treeRoot(page) + ')');

  // A new folder somewhere else: P9 makes it under the picked parent, named from the project.
  await page.locator('#navList [data-newproj]').first().click();
  await dlg.locator('input[name=name]').fill('Holiday cards');
  await dlg.locator('#pjW3').check();
  await dlg.locator('[data-show=new]', { hasText: 'holiday-cards' }).waitFor({ timeout: 5000 });
  await pickNext(path.join(ws, 'other'));
  await dlg.locator('[data-pick=new]').click();
  await dlg.locator('[data-show=new]', { hasText: 'other/holiday-cards' }).waitFor({ timeout: 5000 });
  await dlg.locator('button[type=submit]').click();
  await page.locator('#projPage h1', { hasText: 'Holiday cards' }).waitFor({ timeout: 10000 });
  assert.ok((await stat(path.join(ws, 'other', 'holiday-cards'))).isDirectory(), 'the new folder exists');
  await page.locator('#projPage .wf .mono', { hasText: 'other/holiday-cards' }).waitFor({ timeout: 5000 });

  // In P9: nothing to pick; the page names P9's own folder.
  await page.locator('#navList [data-newproj]').first().click();
  await dlg.locator('input[name=name]').fill('Notes');
  assert.equal(await dlg.locator('#pjW1').isChecked(), true, 'In P9 is the default');
  await dlg.locator('button[type=submit]').click();
  await page.locator('#projPage h1', { hasText: 'Notes' }).waitFor({ timeout: 10000 });
  await page.locator('#projPage .wf .tag', { hasText: 'In P9' }).waitFor({ timeout: 5000 });
  assert.equal((await project(instance, 'Notes')).work.kind, 'p9');
  await page.locator('#projPage [data-pj=open]').click();
  await until(async () => (await treeRoot(page)) === 'Notes / files', 'Open shows the In P9 files folder');
  assert.deepEqual(errors, []);
});

test('projects: delete leaves the folder, Locate, archive and back, a chat\'s Rename, Archive and Delete', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace;
  await mkdir(path.join(ws, 'site'), { recursive: true }); await mkdir(path.join(ws, 'moveme'), { recursive: true });
  await writeFile(path.join(ws, 'site', 'index.html'), 'mine\n');
  const site = (await call(instance, '/projects', 'POST', { name: 'Site', work: { kind: 'linked', folder: 'site' } })).project.id;
  const gone = (await call(instance, '/projects', 'POST', { name: 'Moving', work: { kind: 'linked', folder: 'moveme' } })).project.id;
  const chat = async (body, text) => { const r = await call(instance, '/chat', 'POST', { provider: 'claude', ...body }); await call(instance, '/chat/' + r.conversation + '/prompt', 'POST', { text }); await ended(instance, r.conversation); return r.conversation; };
  const a = await chat({ project: site }, 'title Landing copy'), b = await chat({ project: site }, 'title Footer');
  const plain = await chat({}, 'title Scratch');
  await rename(path.join(ws, 'moveme'), path.join(ws, 'moved'));

  const { page, errors, pickNext } = await launch(t, instance);
  // Delete: asks once, names what goes and what stays, moves the chats to Chats; the user's folder is untouched.
  await page.locator(`#navList [data-proj="${site}"]`).click();
  await page.locator('#projPage h1', { hasText: 'Site' }).waitFor({ timeout: 10000 });
  await page.locator('#projPage [data-pj=more]').click();
  await page.locator('.lp-menu [data-pjm=delete]').click();
  const ask = page.locator('#pjAsk');
  await ask.locator('h2', { hasText: 'Delete “Site”?' }).waitFor({ timeout: 5000 });
  const said = await ask.locator('.body2').textContent();
  assert.match(said, /Your folder at site is not touched\./); assert.match(said, /Its 2 chats move to Chats\./);
  await ask.locator('[value=yes]').click();
  await until(async () => !(await call(instance, '/projects')).projects.some((p) => p.id === site), 'deleted on the daemon');
  assert.equal((await stat(path.join(ws, 'site', 'index.html'))).isFile(), true, 'the folder the user chose is untouched');
  await until(async () => (await zoneOf(page, a)) === '' && (await zoneOf(page, b)) === '', 'its chats are in Chats');
  assert.equal((await conv(instance, a)).project, null);

  // Folder not found, then Locate.
  await page.locator(`#navList [data-proj="${gone}"]`).click();
  await page.locator('#projPage .missing', { hasText: 'Folder not found' }).waitFor({ timeout: 10000 });
  await pickNext(path.join(ws, 'moved'));
  await page.locator('#projPage [data-pj=locate]').click();
  await page.locator('#projPage .wf .mono', { hasText: 'moved' }).waitFor({ timeout: 10000 });
  assert.equal((await call(instance, '/projects/' + gone)).project.work.folder, 'moved');

  // Archive hides the project; the Archived page puts it back.
  await page.locator('#projPage [data-pj=more]').click();
  await page.locator('.lp-menu [data-pjm=archive]').click();
  await page.locator(`#navList [data-proj="${gone}"]`).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal((await call(instance, '/projects/' + gone)).project.archived, true);
  await page.locator('#navList [data-archived]').click();
  // The Files pane drawn while the Archived page shows (no project, no chat in view): it used to throw in renderTree.
  const palette = async (cmd) => { await page.keyboard.press('Control+k'); await page.fill('#palIn', cmd); await page.locator('#palList li[data-i]', { hasText: cmd }).first().waitFor({ timeout: 5000 }); await page.keyboard.press('Enter'); };
  await palette('Toggle files pane'); if (await page.locator('#files').isHidden()) await palette('Toggle files pane');
  await page.locator('#tree .where').waitFor({ timeout: 5000 });
  assert.deepEqual(errors, [], 'the file tree draws on the Archived page');
  await page.locator(`#projPage [data-pj=unproj][data-id="${gone}"]`).click();
  await page.locator(`#navList [data-proj="${gone}"]`).waitFor({ timeout: 5000 });

  // A chat's row menu: Rename, Archive (with the Archived page), Delete after one question.
  const menu = async (id) => { await page.locator(`#navList .row[data-chat="${id}"]`).hover(); await page.locator(`#navList [data-more="${id}"]`).click(); };
  await menu(plain); await page.locator('.lp-menu [data-pjchat=rename]').click();
  await ask.locator('input').fill('Scratch pad'); await ask.locator('[value=yes]').click();
  await until(async () => (await conv(instance, plain)).title === 'Scratch pad', 'renamed on the daemon');
  await page.locator(`#navList .row[data-chat="${plain}"]`, { hasText: 'Scratch pad' }).waitFor({ timeout: 5000 });
  // Peer help: the menu opens a chat to other chats' questions and closes it again; the daemon keeps it.
  await menu(b);
  assert.equal((await page.locator('.lp-menu [data-pjchat=askable]').textContent()).trim(), 'Open to questions');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT peer-help-menu ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await page.locator('.lp-menu [data-pjchat=askable]').click();
  await until(async () => (await conv(instance, b)).askable === true, 'opened to questions on the daemon');
  await menu(b);
  assert.equal((await page.locator('.lp-menu [data-pjchat=askable]').textContent()).trim(), 'Close to questions');
  await page.locator('.lp-menu [data-pjchat=askable]').click();
  await until(async () => (await conv(instance, b)).askable === false, 'closed again');
  await menu(b); await page.locator('.lp-menu [data-pjchat=archive]').click();
  await page.locator(`#navList .row[data-chat="${b}"]`).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal((await conv(instance, b)).archived, true);
  await page.locator('#navList [data-archived]').click();
  await page.locator(`#projPage [data-pj=unchat][data-id="${b}"]`).click();
  await page.locator(`#navList .row[data-chat="${b}"]`).waitFor({ timeout: 5000 });
  await menu(a); await page.locator('.lp-menu [data-pjchat=delete]').click();
  await ask.locator('h2', { hasText: 'Delete “Landing copy”?' }).waitFor({ timeout: 5000 });
  // O35: one sentence says what goes (the chat, what P9 remembered, its photos no other chat uses) and what stays.
  assert.match(await ask.locator('p').innerText(), /^Deletes the chat, what P9 remembered from it and its photos no other chat uses; its files and what it spent stay\. (It stops first\. )?This can't be undone\.$/);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT o35-delete-chat ' + (await ask.screenshot({ type: 'png' })).toString('base64'));
  await ask.locator('[value=yes]').click();
  await until(async () => !(await conv(instance, a)), 'deleted on the daemon');
  await page.locator(`#navList .row[data-chat="${a}"]`).waitFor({ state: 'detached', timeout: 5000 });
  assert.deepEqual(errors, []);
});

// Nightly 3: the New project dialog was cut off. A long linked path must not widen the New project dialog:
// nothing scrolls sideways and Create stays inside the dialog, in a small window and a desktop one.
test('projects: the New project dialog fits a long folder path', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const long = path.join('personal-projects', 'a-folder-with-a-rather-long-name-for-this-check', 'and-another-long-part-under-it', 'event-horizon-app');
  await mkdir(path.join(instance.workspace, long), { recursive: true });
  const c = (await call(instance, '/chat', 'POST', { provider: 'claude', folder: long })).conversation;
  assert.ok(c);
  const { app, page, errors, pickNext } = await launch(t, instance);
  await page.locator('#navList [data-newproj]').first().click();
  const dlg = page.locator('#pjNew');
  await dlg.waitFor({ state: 'visible', timeout: 5000 });
  await dlg.locator('input[name=name]').fill('P9 - Event Horizon');
  await dlg.locator('#pjW2').check();
  await pickNext(path.join(instance.workspace, long));
  await dlg.locator('[data-pick=linked]').click();
  await dlg.locator('.found', { hasText: '1 chat was started in this folder' }).waitFor({ timeout: 5000 });
  for (const width of [540, 1280]) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(320, 400));
    await page.setViewportSize({ width, height: 760 });
    await until(async () => Math.abs(await page.evaluate(() => window.innerWidth) - width) <= 20, async () => `window ${width} wide (is ${await page.evaluate(() => window.innerWidth)})`, 5000);
    const m = await page.evaluate(() => { const d = document.querySelector('#pjNew'), r = d.getBoundingClientRect(), b = d.querySelector('[type=submit]').getBoundingClientRect();
      return { scroll: d.scrollWidth, client: d.clientWidth, formScroll: d.querySelector('form').scrollWidth, formClient: d.querySelector('form').clientWidth, right: r.right, createRight: b.right, createLeft: b.left, left: r.left }; });
    if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, `nightly3-new-project-${width}.png`) });
    assert.ok(m.scroll <= m.client && m.formScroll <= m.formClient, `${width} wide: the dialog scrolls sideways ${JSON.stringify(m)}`);
    assert.ok(m.createLeft >= m.left && m.createRight <= m.right, `${width} wide: Create is outside the dialog ${JSON.stringify(m)}`);
  }
  assert.deepEqual(errors, []);
});

// Nightly 3: "moving a chat to a project changes the edited last timer". Only a message or a turn is activity: a move,
// a rename and an archive leave a closed chat's last-used time and place alone, live and after a reload.
test('projects: move, rename and archive do not count as use', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const make = async (text) => { const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
    await call(instance, '/chat/' + id + '/prompt', 'POST', { text }); await ended(instance, id); return id; };
  const older = await make('title Older'), newer = await make('title Newer');
  for (const id of [older, newer]) await call(instance, '/chat/' + id + '/stop', 'POST', {});
  const used = async (id) => (await conv(instance, id)).used;
  const before = await used(older);
  const p = (await call(instance, '/projects', 'POST', { name: 'Kept', work: { kind: 'p9' } })).project.id;
  const { page, errors } = await launch(t, instance);
  const order = (zone) => page.evaluate((zone) => [...document.querySelectorAll(`#navList [data-zone="${zone}"] .row[data-chat]`)].map((r) => r.dataset.chat), zone);
  await until(async () => (await order('')).join() === [newer, older].join(), 'newest first in Chats');
  await call(instance, '/chat/' + older + '/rename', 'POST', { title: 'Older renamed' });
  await page.locator(`#navList .row[data-chat="${older}"]`, { hasText: 'Older renamed' }).waitFor({ timeout: 10000 });
  await call(instance, '/chat/' + older + '/archive', 'POST', { archived: true });
  await page.locator(`#navList .row[data-chat="${older}"]`).waitFor({ state: 'detached', timeout: 10000 });
  await call(instance, '/chat/' + older + '/archive', 'POST', { archived: false });
  await page.locator(`#navList .row[data-chat="${older}"]`).waitFor({ timeout: 10000 });
  assert.deepEqual(await order(''), [newer, older], 'a rename and an archive keep the place');
  for (const id of [newer, older]) { await call(instance, '/chat/' + id + '/project', 'POST', { project: p }); await until(async () => (await zoneOf(page, id)) === p, 'moved in'); }
  assert.deepEqual(await order(p), [newer, older], 'a move keeps the place');
  assert.equal(await used(older), before, 'the daemon\'s last used time is unchanged');
  await page.reload(); await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await until(async () => (await order(p)).join() === [newer, older].join(), async () => 'after a reload ' + JSON.stringify(await order(p)));
  assert.deepEqual(errors, []);
});

// Nightly 3: "new prject detected chats made in that prject but didnt move the chat like it offered to". His steps: a
// chat started in a folder from the app, then New project, In a folder I already have, that folder, tick, Create. The
// chat shows under the project in the panel, also after a reload; a chat that can't be moved is named in the dialog.
test('projects: the offered chat moves in and shows under the project', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'site'), { recursive: true });
  const other = (await call(instance, '/projects', 'POST', { name: 'Other', work: { kind: 'p9' } })).project.id;
  // His real case: a chat opened in that folder and stopped before anything was sent. The panel hides it, so the offer
  // must not count it (on nightly 3 it was the one chat offered, and it moved out of sight).
  const ghost = (await call(instance, '/chat', 'POST', { provider: 'claude', folder: 'site' })).conversation;
  await call(instance, '/chat/' + ghost + '/stop', 'POST', {});
  const { page, errors, pickNext } = await launch(t, instance);
  // Builder has projects closed in the panel: the open/closed choice is kept.
  await page.locator(`#navList [data-toggle="${other}"]`).click();
  await page.locator(`#navList [data-proj="${other}"][aria-expanded=false]`).waitFor({ timeout: 5000 });
  await page.click('#newBtn');
  await pickNext(path.join(instance.workspace, 'site'));
  await page.locator('.pane [data-chat-folder]').click();
  await page.locator('.pane [data-chat-folder]').filter({ hasText: path.join(instance.workspace, 'site') }).waitFor({ timeout: 10000 });
  await page.locator('.pane .welcome', { hasText: 'site' }).waitFor({ timeout: 10000 });
  const chat = (await call(instance, '/chat')).conversations.find((c) => c.folder === 'site').id;
  await call(instance, '/chat/' + chat + '/prompt', 'POST', { text: 'title Site notes' }); await ended(instance, chat);

  const dlg = page.locator('#pjNew');
  const start = async (name) => {
    await page.locator('#navList [data-newproj]').first().click();
    await dlg.waitFor({ state: 'visible', timeout: 5000 });
    await dlg.locator('input[name=name]').fill(name);
    await dlg.locator('#pjW2').check();
    await pickNext(path.join(instance.workspace, 'site'));
    await dlg.locator('[data-pick=linked]').click();
  };
  await start('Site');
  await dlg.locator('.found', { hasText: '1 chat was started in this folder: “Site notes”. Add it to the project?' }).waitFor({ timeout: 5000 });
  await dlg.locator('#pjAdopt').check();
  await dlg.locator('button[type=submit]').click();
  await page.locator('#projPage h1', { hasText: 'Site' }).waitFor({ timeout: 10000 });
  const site = (await project(instance, 'Site')).id;
  assert.equal((await conv(instance, chat)).project, site, 'moved on the daemon');
  assert.equal((await conv(instance, ghost)).project, null, 'the hidden chat was not offered');
  await until(async () => (await zoneOf(page, chat)) === site, async () => 'the chat under the project in the panel (' + await zoneOf(page, chat) + ')');
  await page.reload(); await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await until(async () => (await zoneOf(page, chat)) === site, async () => 'after a reload, under the project (' + await zoneOf(page, chat) + ')');

  // A chat that goes between the offer and Create (here: deleted) is named in the dialog, not dropped in silence.
  await call(instance, '/chat/' + chat + '/project', 'POST', { project: null });
  const second = (await call(instance, '/chat', 'POST', { provider: 'claude', folder: 'site' })).conversation;
  await call(instance, '/chat/' + second + '/prompt', 'POST', { text: 'title Second' }); await ended(instance, second);
  for (const name of ['Third', 'Fourth']) { const id = (await call(instance, '/chat', 'POST', { provider: 'claude', folder: 'site' })).conversation; await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'title ' + name }); await ended(instance, id); }
  await start('Site two');
  // Newest first, up to three named, then the count of the rest.
  await dlg.locator('.found', { hasText: '4 chats were started in this folder: “Fourth”, “Third”, “Second” and 1 more. Add them to the project?' }).waitFor({ timeout: 5000 });
  await call(instance, '/chat/' + second + '/delete', 'POST', {});
  await dlg.locator('#pjAdopt').check();
  await dlg.locator('button[type=submit]').click();
  await dlg.locator('.err', { hasText: '“Site two” is made, but 1 chat could not be added. That chat is no longer there.' }).waitFor({ timeout: 10000 });
  assert.equal(await dlg.locator('.err').textContent(), '“Site two” is made, but 1 chat could not be added. That chat is no longer there.', 'no drag hint for a chat that is gone');
  assert.equal(await page.locator('.toast', { hasText: 'moveChat' }).count(), 0, 'the dialog says it once, no raw toast');
  assert.equal((await call(instance, '/chat')).conversations.filter((c) => c.project && c.folder === 'site').length, 3, 'the three that could move, moved');
  const two = (await project(instance, 'Site two')).id;
  assert.equal((await conv(instance, chat)).project, two, 'the one that could move, moved');
  await dlg.locator('button[type=submit]', { hasText: 'Open the project' }).click();
  await page.locator('#projPage h1', { hasText: 'Site two' }).waitFor({ timeout: 10000 });
  assert.equal((await call(instance, '/projects')).projects.filter((p) => p.name === 'Site two').length, 1, 'no second project');
  assert.deepEqual(errors.filter((e) => !/unknown-conversation/.test(e)), []);
});

// The project row's count is the chats it lists: a chat closed before anything was sent (hidden) and an archived chat are
// in the project on the daemon but not listed, so not counted (nightly 3: the row said one more than it showed).
test('projects: the project row counts only the chats it lists', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Counted', work: { kind: 'p9' } })).project.id;
  const make = async (title) => { const id = (await call(instance, '/chat', 'POST', { provider: 'claude', project: p })).conversation;
    await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'title ' + title }); await ended(instance, id); return id; };
  const shown = await make('Shown'), archived = await make('Archived');
  await call(instance, '/chat/' + archived + '/archive', 'POST', { archived: true });
  const hidden = (await call(instance, '/chat', 'POST', { provider: 'claude', project: p })).conversation;
  await call(instance, '/chat/' + hidden + '/stop', 'POST', {});
  assert.equal((await call(instance, '/projects')).projects.find((x) => x.id === p).chats, 3, 'the daemon has three in the project');
  const { page, errors } = await launch(t, instance);
  const rows = () => page.evaluate((p) => [...document.querySelectorAll(`#navList [data-zone="${p}"] .row[data-chat]`)].map((r) => r.dataset.chat), p);
  const count = () => page.locator(`#navList [data-proj="${p}"] .n`).textContent();
  await until(async () => (await rows()).join() === shown, async () => 'only the sent chat listed ' + JSON.stringify(await rows()));
  assert.equal(await count(), '1', 'the row counts what it lists');
  await page.reload(); await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await until(async () => (await rows()).join() === shown && await count() === '1', async () => 'after a reload ' + await count());
  assert.deepEqual(errors, []);
});

test('MC-18: In P9 chat lists and opens its project file', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Notes', work: { kind: 'p9' } })).project;
  assert.equal((await call(instance, '/projects/' + p.id + '/files', 'POST', { name: 'notes.txt', data: Buffer.from('Project note').toString('base64') })).status, 201);
  assert.equal((await call(instance, '/projects/' + p.id + '/files', 'POST', { name: 'picture.png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' })).status, 201);
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', project: p.id })).conversation;
  await call(instance, '/chat/' + chat + '/prompt', 'POST', { text: 'title Notes chat' }); await ended(instance, chat);
  const { page } = await launch(t, instance);
  await page.locator(`#navList .row[data-chat="${chat}"]`).click({ timeout: 10000 });
  if (await page.locator('#files').isHidden()) await page.locator('[data-tool=files]').click();
  await page.locator('#fileScope').selectOption('project');
  await page.locator('#tree [data-lfile]', { hasText: 'notes.txt' }).waitFor({ timeout: 12000 });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT mc18 ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await page.locator('#tree [data-lfile]', { hasText: 'notes.txt' }).click();
  await page.locator('#mdlBody textarea').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#mdlBody textarea').inputValue(), 'Project note');
  const traversal = await call(instance, '/files?' + new URLSearchParams({ project: p.id, path: '../project.json' }));
  assert.equal(traversal.status, 400); assert.equal(traversal.error, 'locked-path');
  assert.equal((await call(instance, '/files/list?' + new URLSearchParams({ project: '../x', path: '' }))).status, 404);
  await page.locator('#mdlX').click();
  await page.locator('#tree [data-lfile]', { hasText: 'picture.png' }).click();
  await page.locator('#mdlBody img').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#mdlT').textContent(), 'picture.png');
  assert.equal(await page.locator('#mdlFoot').innerText(), 'picture.png\nRead-only');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT mc18-image ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  assert.equal((await call(instance, '/files/list?' + new URLSearchParams({ project: randomUUID(), path: '' }))).status, 404);
});

test('MC-18: switching chats switches the In P9 project files both ways', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const chats = [];
  for (const name of ['Alpha', 'Beta']) {
    const p = (await call(instance, '/projects', 'POST', { name, work: { kind: 'p9' } })).project;
    assert.equal((await call(instance, '/projects/' + p.id + '/files', 'POST', { name: name + '.txt', data: Buffer.from(name).toString('base64') })).status, 201);
    const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', project: p.id })).conversation;
    await call(instance, '/chat/' + chat + '/prompt', 'POST', { text: 'title ' + name + ' chat' }); await ended(instance, chat);
    chats.push(chat);
  }
  const { page } = await launch(t, instance);
  if (await page.locator('#files').isHidden()) await page.locator('[data-tool=files]').click();
  await page.locator('#fileScope').selectOption('project');
  for (const [index, name] of [[0, 'Alpha'], [1, 'Beta'], [0, 'Alpha']]) {
    await page.locator(`#navList .row[data-chat="${chats[index]}"]`).click({ timeout: 10000 });
    await page.locator('#tree [data-lfile]', { hasText: name + '.txt' }).waitFor({ timeout: 12000 });
    assert.equal(await page.locator('#tree [data-lfile]').count(), 1);
  }
});

test('project New chat stays clickable with notification cards at narrow widths', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const id = (await call(instance, '/projects', 'POST', { name: 'Garden', work: { kind: 'p9' } })).project.id;
  const { page, errors } = await launch(t, instance);
  await shellReady(page, { timeout: 15000 });
  await page.locator(`#navList [data-proj="${id}"]`).click();
  await page.locator('#projPage h1', { hasText: 'Garden' }).waitFor({ timeout: 10000 });
  for (const width of [960, 720]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(600);
    const button = page.locator('#projPage [data-pj=new]');
    const box = await button.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width, 'button fits within viewport');
    const png = await page.screenshot({ type: 'png' });
    if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT o49-' + width + ' ' + png.toString('base64'));
    await button.click({ timeout: 5000 });
    await page.locator(`.pane:visible [data-goproj="${id}"]`).waitFor({ state: 'attached', timeout: 10000 });
    if (width === 960) {
      await page.locator(`.pane [data-goproj="${id}"]`).click();
      await page.locator('#projPage h1', { hasText: 'Garden' }).waitFor();
    }
  }
  assert.deepEqual(errors, []);
});

// D1 D3 D4 (SECURITY.md § Sprint files): the project page lists a lead chat's sprint files; one opens in a text box that saves.
test('projects: the project page lists a sprint\'s files and edits one', { timeout: 90000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'site'));
  const p = (await call(instance, '/projects', 'POST', { name: 'Site', work: { kind: 'linked', folder: 'site' } })).project;
  const lead = (await call(instance, '/chat', 'POST', { provider: 'claude', project: p.id })).conversation;
  await call(instance, '/chat/' + lead + '/prompt', 'POST', { text: 'title Lead chat' }); await ended(instance, lead);
  // The sprint folder sits beside projects/ in P9's own folder (open_chat makes it; the sprint-files test covers that).
  const bases = [path.join(path.dirname(instance.workspace), '.local', 'state', 'p9-foundation'), instance.state];
  const base = (await Promise.all(bases.map((b) => stat(path.join(b, 'projects', p.id)).then(() => b, () => null)))).find(Boolean);
  assert.ok(base, 'found P9\'s projects folder');
  const sprint = path.join(base, 'sprints', lead);
  await mkdir(path.join(sprint, 'roles'), { recursive: true, mode: 0o700 }); await mkdir(path.join(sprint, 'notes'), { mode: 0o700 });
  await writeFile(path.join(sprint, 'sprint.md'), '# Plan\n\nGoal: the docs site.\n\n## Items\n- [ ] w1: the install page\n- [ ] w2: the FAQ\n\n## What I will need from you\n- A review of the FAQ wording\n');
  await writeFile(path.join(sprint, 'rules.md'), 'Only touch docs/.');
  // A guarded save sets the old file aside before it places the new one, so for that instant sprint.md is absent (sprint-files.mjs): polls read that as ''.
  const sprintText = () => readFile(path.join(sprint, 'sprint.md'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  await writeFile(path.join(sprint, 'roles', 'w1.instructions.md'), 'You write the install page.');
  await writeFile(path.join(sprint, 'notes', 'w1.md'), '## Now\nDoing: install page\nNext:\nBlocked on:\nNot yet checked:\n\n## Log\n');
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); await page.locator('[data-pj="spopen"]').click();
  const row = page.locator('[data-pj="spfile"]', { hasText: 'sprint.md' });
  await row.waitFor({ timeout: 10000 });
  assert.equal(await page.locator('[data-pj="spfile"]').count(), 5); // sprint.md, rules.md, the role file, the notes file, and hooks.json (listed before it is made)
  // O207: a chat running outside Start has Start sprint too, which adopts it as the lead (the press, sprint-start.test.mjs).
  const adopt = page.locator('[data-pj="spstart"]');
  assert.deepEqual([(await adopt.textContent()).trim(), /keeps this chat as the lead/.test(await adopt.getAttribute('title'))], ['Start sprint', true]);
  await row.click();
  const box = page.locator('[data-sp-box]');
  await box.waitFor({ timeout: 5000 });
  assert.match(await box.inputValue(), /Goal: the docs site\./);
  await box.press('Control+End'); await box.pressSequentially('- [ ] w3: the changelog\n');
  await until(async () => (await sprintText()).includes('w3: the changelog'), 'the edit saved to sprint.md');
  assert.match(await readFile(path.join(sprint, 'sprint.md'), 'utf8'), /FAQ wording\n- \[ \] w3: the changelog\n$/);
  // The lead edits the plan after the page opened it; the user types, then opens another file. The save is refused: the
  // lead's text stays on disk, sprint.md stays open with the user's text, and the page says so with a way on.
  await writeFile(path.join(sprint, 'sprint.md'), '# Plan\n\nGoal: the lead\'s.\n');
  await box.press('Control+End'); await box.pressSequentially('- [ ] w4: mine\n');
  await page.locator('[data-pj="spfile"]', { hasText: 'rules.md' }).click();
  const note = page.locator('[data-sp-note]');
  await note.getByText('changed in P9 after you opened it').waitFor({ timeout: 10000 });
  assert.equal(await row.getAttribute('aria-expanded'), 'true', 'a refused save switched files');
  assert.match(await box.inputValue(), /w4: mine\n$/);
  assert.equal(await readFile(path.join(sprint, 'sprint.md'), 'utf8'), '# Plan\n\nGoal: the lead\'s.\n');
  await note.getByRole('button', { name: 'Save mine over it' }).click();
  await until(async () => (await sprintText()).endsWith('w4: mine\n'), 'Save mine over it saved');
  // The file lands before the reply reaches the page, and the page clears the note on the reply: wait for it.
  await until(async () => (await note.textContent()) === '', 'the note cleared after Save mine over it');
  // Two saves started at once: the second goes after the first and names the file the first wrote, so it is not refused.
  await box.evaluate(async (b) => { for (const text of ['first save\n', 'second save\n']) { b.value = text; b.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); } });
  await until(async () => (await sprintText()) === 'second save\n', 'the second of two overlapping saves landed');
  await page.locator('[data-pj="spfile"]', { hasText: 'rules.md' }).click();
  await until(async () => (await page.locator('[data-sp-box]').getAttribute('data-name')) === 'rules.md', 'a saved file switches');
  assert.equal(await page.locator('[data-sp-box]').inputValue(), 'Only touch docs/.');
  await page.locator('[data-pj="spfile"]', { hasText: 'sprint.md' }).click();
  await until(async () => (await page.locator('[data-sp-box]').getAttribute('data-name')) === 'sprint.md', 'back to sprint.md');
  await page.locator('[data-sprint]').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-files ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // A worker deletes its notes file while the user has it open and types: the save is refused twice (two switches), the
  // file stays listed and open with the user's text, and Save it again makes it again; away and back, the text is there.
  const notesRow = page.locator('[data-pj="spfile"]', { hasText: 'notes/w1.md' }), notesFile = path.join(sprint, 'notes', 'w1.md');
  const rulesRow = page.locator('[data-pj="spfile"]', { hasText: 'rules.md' });
  await notesRow.click();
  await until(async () => (await page.locator('[data-sp-box]').getAttribute('data-name')) === 'notes/w1.md', 'notes open');
  await rm(notesFile);
  await box.press('Control+End'); await box.pressSequentially('Doing: kept\n');
  for (const attempt of [1, 2]) {
    await rulesRow.click();
    await note.getByText('deleted in P9 after you opened it').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-sp-box]').getAttribute('data-name'), 'notes/w1.md', 'refused save ' + attempt + ' switched files');
    assert.match(await box.inputValue(), /Doing: kept\n$/);
    assert.match(await notesRow.textContent(), /deleted, your text not saved/);
  }
  assert.equal(existsSync(notesFile), false);
  await note.getByRole('button', { name: 'Save it again' }).click();
  await until(async () => existsSync(notesFile) && (await readFile(notesFile, 'utf8')).endsWith('Doing: kept\n'), 'Save it again made the file');
  await rulesRow.click();
  await until(async () => (await page.locator('[data-sp-box]').getAttribute('data-name')) === 'rules.md', 'saved: it switches');
  await notesRow.click();
  await until(async () => (await page.locator('[data-sp-box]').getAttribute('data-name')) === 'notes/w1.md', 'back to notes');
  assert.match(await box.inputValue(), /Doing: kept\n$/);
  // Deleted again, typed again: Discard my text drops the draft and the row.
  await rm(notesFile);
  await box.press('Control+End'); await box.pressSequentially('more\n');
  await rulesRow.click();
  await note.getByRole('button', { name: 'Discard my text' }).click();
  await until(async () => (await notesRow.count()) === 0, 'discarded: the deleted file is no longer listed');
  assert.deepEqual(errors, []);
});

// SECURITY.md § Worker folders, "Who cleans up": the sprint's section has Clean up worker folders. It refuses while the
// lead is in a turn, then removes the merged worker folder and keeps the unmerged one, and the page says which and why.
test('projects: Clean up worker folders on the sprint section says what it removed and what it kept', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  const repo = path.join(instance.workspace, 'site');
  await mkdir(repo); g(repo, 'init', '-q', '-b', 'main'); await writeFile(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const p = (await call(instance, '/projects', 'POST', { name: 'Site', work: { kind: 'linked', folder: 'site' } })).project;
  const lead = (await call(instance, '/chat', 'POST', { provider: 'claude', project: p.id })).conversation;
  await call(instance, '/chat/' + lead + '/prompt', 'POST', { text: 'title Lead chat' }); await ended(instance, lead);
  const bases = [path.join(path.dirname(instance.workspace), '.local', 'state', 'p9-foundation'), instance.state];
  const base = (await Promise.all(bases.map((b) => stat(path.join(b, 'projects', p.id)).then(() => b, () => null)))).find(Boolean);
  // A sprint's folder as open_chat leaves it (worker-folders.test.mjs covers the making): a clone, two worker folders on
  // their sprint branches, one with nothing of its own (merged) and one with a commit not in the main line.
  const sprint = path.join(base, 'sprints', lead), clone = path.join(sprint, 'clone'), branch = (item) => 'sprint/' + lead.slice(0, 8) + '/' + item;
  await mkdir(sprint, { recursive: true, mode: 0o700 }); await writeFile(path.join(sprint, 'sprint.md'), '# Plan\n');
  g(sprint, 'clone', '-q', '--no-checkout', '--', repo, clone);
  for (const item of ['done', 'open']) g(clone, 'worktree', 'add', '-q', '-b', branch(item), path.join(sprint, 'workers', item), 'origin/main');
  const open = path.join(sprint, 'workers', 'open');
  await writeFile(path.join(clone, '.git', 'info', 'exclude'), 'local.env\n'); await writeFile(path.join(sprint, 'workers', 'done', 'local.env'), 'KEY=1\n');
  await writeFile(path.join(open, 'o.txt'), 'o\n'); g(open, 'add', 'o.txt'); g(open, 'commit', '-qm', 'not merged');
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); await page.locator('[data-pj="spopen"]').click();
  const button = page.getByRole('button', { name: 'Clean up worker folders' }), said = page.locator('[data-sp-clean]');
  await button.waitFor({ timeout: 10000 });
  assert.equal(await page.locator('[data-sp-ignored]').textContent(), 'Clean up removes a finished worker\'s whole folder, including files git ignores, such as build output or a local .env.', 'it says ignored files go too');
  assert.ok(await page.locator('[data-sp-ignored]').isVisible(), 'beside the button, on screen');
  await call(instance, '/chat/' + lead + '/prompt', 'POST', { text: 'slow' });
  await until(async () => (await conv(instance, lead)).state === 'turn', 'the lead is in a turn');
  await button.click();
  await said.getByText('Not cleaned: Its lead is working').waitFor({ timeout: 10000 });
  assert.ok(existsSync(path.join(sprint, 'workers', 'done')), 'nothing removed while the lead works');
  await call(instance, '/chat/' + lead + '/cancel', 'POST', {});
  await until(async () => (await conv(instance, lead)).state !== 'turn', 'the turn ended');
  await page.getByRole('button', { name: 'Clean up worker folders' }).click();
  await said.getByText('Removed: done.').waitFor({ timeout: 20000 });
  assert.match(await said.textContent(), /^Removed: done\. Kept: open \(not in the main line, [\d.]+ (B|KB|MB)\)\.$/);
  assert.equal(existsSync(path.join(sprint, 'workers', 'done')), false, 'the merged folder is gone');
  assert.ok(existsSync(open), 'the unmerged folder is kept');
  assert.ok(existsSync(path.join(sprint, 'sprint.md')), 'the sprint files stay');
  await page.locator('[data-sprint]').evaluate((e) => e.scrollIntoView({ block: 'start' }));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-clean ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  assert.deepEqual(errors, []);
});

// H1-H3, I1 (Start sprint's prep): New sprint on the project page makes a prep; its section
// shows each role of roles.json as a row with the same Agent / Model / Effort picks as Settings > Delegation, adds and
// removes workers, lists every role's files before they are written, and a roles.json the lead wrote meanwhile wins.
test('projects: New sprint makes a prep whose roles and role files are edited on the page', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'site'));
  const p = (await call(instance, '/projects', 'POST', { name: 'Site', work: { kind: 'linked', folder: 'site' } })).project;
  const { profile } = await call(instance, '/profiles', 'POST', { name: 'Far Cloud', baseUrl: 'https://models.example.test/api/', models: ['glm-5.3', 'kimi-k3:cloud'], key: 'sk-profile-test-0f3a9c71d2e84b56' });
  const { app, page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await page.locator('[data-pj="spnew"]').click();
  await page.locator('#pjAsk input').fill('Docs sprint');
  await page.locator('#pjAsk [value=yes]').click();
  const section = page.locator('[data-sprint]');
  await section.locator('[data-sp-prep]').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('[data-sp-title]').textContent(), 'Sprint Setup', 'New sprint lands in its Sprint Setup page');
  const lead = await section.getAttribute('data-sprint');
  assert.match(await section.locator('h2').textContent(), /Docs sprint/);
  assert.equal(await section.locator('[data-pj="spclean"]').count(), 0, 'a prep has no worker folders to clean up');
  const bases = [path.join(path.dirname(instance.workspace), '.local', 'state', 'p9-foundation'), instance.state];
  const folder = (await Promise.all(bases.map((b) => stat(path.join(b, 'sprints', lead)).then(() => path.join(b, 'sprints', lead), () => null)))).find(Boolean);
  assert.ok(folder, 'found the prep\'s folder');
  // As a click does: the pick has the focus when it changes (the page does not redraw under a focused text box).
  const pick = async (role, value) => { const s = page.locator(`[data-spr="agent"][data-role="${role}"]`); await s.focus(); await s.selectOption(value); };
  const roles = async () => JSON.parse(await readFile(path.join(folder, 'roles.json'), 'utf8')).roles;
  // A guarded save sets roles.json aside before it places the new one, so for that instant it is absent (sprint-files.mjs
  // swap): a poll reads that as null, which no check below takes as done.
  const polled = () => roles().catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  assert.deepEqual(await page.locator('[data-role-row]').evaluateAll((r) => r.map((x) => x.dataset.roleRow)), ['lead', 'review']);
  assert.deepEqual(await page.locator('[data-spr="agent"][data-role="lead"] option').evaluateAll((o) => o.map((x) => x.value)), ['', 'claude', 'codex', 'profile:' + profile.id], 'the same agents Settings > Delegation offers, empty first');
  // The lead's agent: written to roles.json, the model and effort it had cleared.
  await pick('lead', 'codex');
  await until(async () => (await polled())?.[0]?.provider === 'codex', 'the lead\'s agent saved to roles.json');
  assert.deepEqual((await roles())[0], { key: 'lead', provider: 'codex', model: '', effort: '' });
  await page.locator('[data-spr="model"][data-role="lead"]').waitFor({ timeout: 5000 });
  // O170: a role put on a provider profile, Model left alone, holds the profile's first model, and the pick shows it.
  await pick('review', 'profile:' + profile.id);
  await until(async () => (await polled())?.[1]?.provider === 'profile:' + profile.id, 'the review role\'s profile saved to roles.json');
  assert.deepEqual((await roles())[1], { key: 'review', provider: 'profile:' + profile.id, model: 'glm-5.3', effort: '' });
  await until(async () => (await page.locator('[data-spr="model"][data-role="review"]').inputValue()) === 'glm-5.3', 'the review role\'s Model shows the saved model');
  // A worker: a name P9 refuses changes nothing; a good one adds its row, and its three files are listed before they exist.
  const keyBox = page.locator('[data-sp-newkey]');
  await keyBox.fill('Bad Key'); await page.locator('[data-pj="sprole-add"]').click();
  assert.equal((await roles()).length, 2, 'a refused name added a role');
  await keyBox.fill('docs'); await page.locator('[data-pj="sprole-add"]').click();
  await until(async () => (await polled())?.some((r) => r.key === 'docs'), 'the worker saved to roles.json');
  await page.locator('[data-role-row="docs"]').waitFor({ timeout: 5000 });
  const work = page.locator('[data-pj="spfile"]', { hasText: 'roles/docs.work.md' });
  assert.match(await work.textContent(), /its first message at Start · empty/);
  assert.equal(existsSync(path.join(folder, 'roles', 'docs.work.md')), false);
  await work.click();
  const box = page.locator('[data-sp-box]');
  await until(async () => (await box.getAttribute('data-name')) === 'roles/docs.work.md', 'the work file open');
  await box.pressSequentially('Write the install page.');
  await page.locator('[data-pj="spfile"]', { hasText: 'sprint.md' }).click();
  await until(async () => existsSync(path.join(folder, 'roles', 'docs.work.md')) && (await readFile(path.join(folder, 'roles', 'docs.work.md'), 'utf8')) === 'Write the install page.', 'the work file made by its first save');
  // The lead writes roles.json meanwhile (with a mode): the page's next change is refused, the rows show the lead's file,
  // and the change made again keeps the lead's mode.
  const theirs = { roles: [{ key: 'lead', provider: 'claude', model: '', effort: '' }, { key: 'review', provider: '', model: '', effort: '' }, { key: 'docs', provider: 'codex', model: '', effort: '', mode: 'Read-only' }] };
  // The work file's save answers with every sprint file as the daemon reads them after the write: the lead writes only
  // once that answer is on the page (the work file's row no longer empty), and in one step, a whole file put in place.
  // A reader between a truncate and its write reads roles.json as empty, and the page shows no rows to pick.
  await until(async () => !/· empty/.test(await work.textContent()), 'the work file\'s save answered on the page');
  await writeFile(path.join(folder, 'roles.json.new'), JSON.stringify(theirs, null, 2) + '\n');
  await rename(path.join(folder, 'roles.json.new'), path.join(folder, 'roles.json'));
  await pick('review', 'claude');
  await until(async () => (await page.locator('[data-spr="agent"][data-role="lead"]').inputValue()) === 'claude', async () => 'the rows show the lead\'s roles.json; seen ' + JSON.stringify({ disk: await polled(), html: await page.locator('[data-sp-roles]').innerHTML().catch((e) => e.message), toasts: await page.locator('body').evaluate(() => [...document.querySelectorAll('[class*=toast]')].map((x) => x.textContent).join(' | ')) }));
  assert.deepEqual(await roles(), theirs.roles, 'a refused change wrote over the lead\'s file');
  assert.equal(await page.locator('[data-spr="agent"][data-role="review"]').inputValue(), '');
  await pick('review', 'claude');
  await until(async () => (await polled())?.[1]?.provider === 'claude', 'the change made again saved');
  assert.equal((await roles())[2].mode, 'Read-only', 'the lead\'s mode kept');
  // A second pick made while the first one's save is still out: the first save's redraw sets every pick back to the file,
  // and the second save, queued behind it, still writes the second pick. The next roles.json save is held in the main
  // process until the test lets it go.
  await app.evaluate(({ ipcMain }) => {
    const h = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat');
    let hold = true; globalThis.letGo = null;
    ipcMain.handle('p9:chat', async (e, action, body, ...rest) => {
      if (hold && action === 'sprintFile' && body?.name === 'roles.json') { hold = false; await new Promise((go) => { globalThis.letGo = go; }); }
      return h(e, action, body, ...rest);
    });
  });
  await pick('lead', 'codex');
  await until(() => app.evaluate(() => !!globalThis.letGo), 'the first save held');
  await pick('review', 'codex');
  await app.evaluate(() => globalThis.letGo());
  await until(async () => (await polled())?.[1]?.provider === 'codex', async () => 'the second pick, made while the first save was held, saved; on disk ' + JSON.stringify(await polled()));
  assert.deepEqual((await roles()).slice(0, 2).map((r) => r.provider), ['codex', 'codex'], 'both picks on disk');
  await section.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-prep ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  assert.match(await page.locator('[data-pj="spfile"]', { hasText: /^rules\.md/ }).textContent(), /none yet, P9's defaults are sent/);
  assert.match(await page.locator('[data-pj="spfile"]', { hasText: 'roles/lead.work.md' }).textContent(), /· empty/);
  await page.setViewportSize({ width: 900, height: 900 }); await page.waitForTimeout(600); // the panel settles at the new width
  await section.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  // Nothing in the section reaches past its right edge (each element's box, so a clipped one counts too), beyond the 8 px
  // a row's hover background reaches out on each side by design (projects.css .crow).
  const wide = await section.evaluate((e) => { const r = e.getBoundingClientRect().right + 9; return [...e.querySelectorAll('*')].filter((x) => x.getBoundingClientRect().right > r).map((x) => x.tagName + '.' + x.className + ' ' + Math.round(x.getBoundingClientRect().right - r + 1) + 'px ' + (x.textContent || '').slice(0, 40)); });
  assert.deepEqual(wide, [], 'past the sprint section\'s edge at 900 wide');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-prep-narrow ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await page.setViewportSize({ width: 1400, height: 900 });
  // O110: a writer that empties roles.json, pauses, then writes. A save answered in the pause read roles.json empty: the
  // rows stay (the last good ones) and show the written file once it is there, without a reload. A second sprint torn at
  // the same time, met only in the first one's fresh read, keeps its rows too and shows its own file when written.
  // Each sprint has its own page now: New sprint is on the project's page, and it lands in the new sprint's Setup.
  const openSprint = async (l) => { await page.locator('[data-pj="spback"]').click(); await page.locator(`[data-pj="spopen"][data-lead="${l}"]`).click(); await page.locator(`[data-sp-page="${l}"]`).waitFor({ timeout: 5000 }); };
  await page.locator('[data-pj="spback"]').click();
  await page.locator('[data-pj="spnew"]').click();
  await page.locator('#pjAsk input').fill('Site sprint');
  await page.locator('#pjAsk [value=yes]').click();
  await until(async () => (await page.locator('[data-sp-page]').getAttribute('data-sp-page', { timeout: 1000 }).catch(() => lead)) !== lead, 'the second prep, on its own page');
  const lead2 = await page.locator('[data-sp-page]').getAttribute('data-sp-page');
  assert.equal(await page.locator('[data-sprint]').count(), 1, 'one sprint to a page');
  const file = path.join(folder, 'roles.json'), file2 = path.join(path.dirname(folder), lead2, 'roles.json');
  const written = JSON.parse(await readFile(file, 'utf8')), written2 = JSON.parse(await readFile(file2, 'utf8'));
  written.roles[0].provider = 'claude'; written2.roles[0].provider = 'codex';
  const leadPick = (l) => page.locator(`[data-sprint="${l}"] [data-spr="agent"][data-role="lead"]`);
  const seen = async (l) => (await leadPick(l).inputValue({ timeout: 1000 }).catch(() => null));
  await until(async () => (await seen(lead2)) === '', 'the second prep\'s rows');
  await openSprint(lead);
  await page.evaluate(() => { window.notReloaded = true; });
  await writeFile(file, ''); await writeFile(file2, '');
  await page.locator('[data-pj="spfile"]', { hasText: 'roles/docs.work.md' }).click();
  await until(async () => (await box.getAttribute('data-name')) === 'roles/docs.work.md', 'the work file open again');
  await box.pressSequentially(' Then the FAQ.');
  await page.locator(`[data-sprint="${lead}"] [data-pj="spfile"]`, { hasText: /^sprint\.md/ }).click();
  // This save is guarded (the file exists now), so for the instant of its swap the file is absent: not yet, like polled.
  await until(async () => (await readFile(path.join(folder, 'roles', 'docs.work.md'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; })).includes(' Then the FAQ.'), 'the work file saved while roles.json is empty');
  // The daemon writes the work file, then reads every sprint file for its answer. roles.json written between the two is
  // read whole: no row is ever missing, the page starts no read of its own, and the second sprint's torn file is never
  // met. So the file is written only once that answer is on the page: the click opens sprint.md's box after the save.
  await until(async () => (await box.getAttribute('data-name')) === 'sprint.md', 'the save answered while roles.json is empty');
  await writeFile(file,JSON.stringify(written, null, 2) + '\n');
  await until(async () => (await seen(lead)) === 'claude', async () => 'the rows show the written roles.json without a reload; seen ' + await page.locator(`[data-sprint="${lead}"] [data-sp-roles]`).innerHTML({ timeout: 1000 }).catch((e) => e.message));
  // The second sprint was off screen while it was torn: its page, opened now, still has its rows, and shows its file once written.
  await openSprint(lead2);
  assert.equal(await seen(lead2), '', 'the second sprint, still torn, keeps its rows');
  await writeFile(file2, JSON.stringify(written2, null, 2) + '\n');
  await until(async () => (await seen(lead2)) === 'codex', async () => 'the second sprint\'s rows show its written roles.json; seen ' + await page.locator(`[data-sprint="${lead2}"]`).innerHTML({ timeout: 1000 }).catch((e) => e.message));
  assert.equal(await page.evaluate(() => window.notReloaded), true, 'the page reloaded');
  await openSprint(lead);
  // Remove: workers only; the lead and the reviewer have no Remove.
  assert.equal(await page.locator('[data-pj="sprole-rm"][data-role="lead"], [data-pj="sprole-rm"][data-role="review"]').count(), 0);
  await page.locator('[data-pj="sprole-rm"][data-role="docs"]').click();
  await until(async () => (await polled())?.some((r) => r.key === 'docs') === false, 'the worker removed from roles.json');
  await page.locator('[data-role-row="docs"]').waitFor({ state: 'detached', timeout: 5000 });
  assert.deepEqual(errors, []);
});

// window-10 (row "Start sprint", the button): the prep's Start sprint press calls the daemon's start; a press while one is
// out does nothing; a failure halfway says what was made and leaves Start again, which keeps it and makes the rest; the
// press shows as the approval record P9 kept (when, by you, the plan's sha256).
test('projects: Start sprint on the sprint section starts the prep, says a failure halfway, Start again makes the rest, and shows the approval record', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
  await mkdir(path.join(ws, 'repo')); g(path.join(ws, 'repo'), 'init', '-q', '-b', 'main'); await writeFile(path.join(ws, 'repo', 'a.txt'), 'a\n'); g(path.join(ws, 'repo'), 'add', 'a.txt'); g(path.join(ws, 'repo'), 'commit', '-qm', 'a');
  await mkdir(path.join(ws, 'plain')); // not a repository: the worker's folder fails, after the lead is made
  const p = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).project;
  // P9 learns claude's model and effort lists when it first runs.
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await ended(instance, first);
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'S1' });
  assert.equal(prep.status, 201, JSON.stringify(prep));
  const sprint = prep.sprint, folder = prep.folder;
  const roles = (dir) => JSON.stringify({ folder: dir, roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'w2', provider: 'claude', model: 'default', effort: 'low' }] });
  await writeFile(path.join(folder, 'roles.json'), roles('plain'));
  await writeFile(path.join(folder, 'roles', 'lead.work.md'), 'config'); await writeFile(path.join(folder, 'roles', 'w2.work.md'), 'config');
  // S19: a script in hooks.json (at a point P9 does not fire yet, so nothing runs here). The page lists it before the
  // press, the press names the file it showed (the daemon refuses one that does not), and the record shows it approved.
  const script = { name: 'tidy <b>up</b>', command: '/usr/bin/true --sprint "$(id)"', point: 'after-close' };
  await writeFile(path.join(folder, 'hooks.json'), JSON.stringify({ scripts: [script] }));
  const planOf = async () => createHash('sha256').update(await readFile(path.join(folder, 'sprint.md'), 'utf8') + '\0' + await readFile(path.join(folder, 'roles.json'), 'utf8')).digest('hex');
  const { app, page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); await page.locator('[data-pj="spopen"]').click();
  const section = page.locator(`[data-sprint="${sprint}"]`), start = section.locator('[data-pj="spstart"]'), said = section.locator('[data-sp-start]'), record = section.locator('[data-sp-started]');
  await section.locator('[data-sp-prep]').waitFor({ timeout: 10000 });
  assert.equal((await start.textContent()).trim(), 'Start sprint');
  assert.equal(await record.count(), 0, 'a prep shows a start record');
  const pendingScripts = section.locator('[data-sp-scripts="pending"]');
  assert.match(await pendingScripts.textContent(), /^Start sprint approves this script\. P9 will run it as you, outside every agent's mode:tidy <b>up<\/b> \(after-close\): \/usr\/bin\/true --sprint "\$\(id\)"$/);
  assert.equal(await pendingScripts.locator('b').count(), 0, 'a script name was drawn as HTML');
  assert.equal(await section.locator('[data-sp-scripts="approved"]').count(), 0);
  // The press is held in the main process: the button says so and is off, and a second press sends nothing.
  await app.evaluate(({ ipcMain }) => {
    const h = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat');
    globalThis.presses = 0; globalThis.letGo = null;
    ipcMain.handle('p9:chat', async (e, action, ...rest) => {
      if (action === 'sprintFile' && globalThis.saves) await new Promise((go) => globalThis.saves.push(go));
      if (action === 'startSprint' && ++globalThis.presses === 1) await new Promise((go) => { globalThis.letGo = go; });
      const r = await h(e, action, ...rest); if (action === 'startSprint') (globalThis.answers ||= []).push(JSON.stringify(r).slice(0, 600)); return r;
    });
  });
  // S19: hooks.json is changed by someone else while this press's draft saves (the save's reply carries every file).
  // The press approved the scripts drawn with its button, so it is not sent: the new list shows and waits for a press.
  const hooksFile = async () => (await call(instance, '/projects/' + p.id)).project.sprints.find((x) => x.lead === sprint).files.find((f) => f.name === 'hooks.json');
  const putHooks = async (rows) => assert.equal((await call(instance, '/projects/' + p.id + '/sprint-file', 'POST', { lead: sprint, name: 'hooks.json', hash: (await hooksFile()).hash, text: JSON.stringify({ scripts: rows }) })).status, 200);
  await section.locator('[data-pj="spfile"]', { hasText: 'sprint.md' }).click();
  await app.evaluate(() => { globalThis.saves = []; });
  const box = section.locator('[data-sp-box]'); await box.fill((await box.inputValue()) + '\nFirst draft.\n');
  await start.click();
  await until(() => app.evaluate(() => globalThis.saves.length > 0), 'the first draft\'s save held');
  await putHooks([script, { name: 'inject', command: '/usr/bin/false', point: 'before-start', blocking: true }]);
  await app.evaluate(() => { const held = globalThis.saves; globalThis.saves = null; held.forEach((go) => go()); });
  await said.waitFor({ timeout: 10000 });
  assert.match(await said.textContent(), /^Not started: hooks\.json changed before your press went out\./);
  assert.equal(await app.evaluate(() => globalThis.presses), 0, 'a press went out for scripts its owner never saw');
  assert.match(await pendingScripts.textContent(), /inject \(before-start, blocking\): \/usr\/bin\/false$/);
  assert.equal((await start.textContent()).trim(), 'Start sprint'); assert.equal(await start.isDisabled(), false);
  assert.equal((await call(instance, '/projects/' + p.id)).project.sprints.find((x) => x.lead === sprint).started, undefined);
  await putHooks([script]);
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); await page.locator('[data-pj="spopen"]').click(); // the page reads a project's files when it is opened
  await until(async () => !/inject/.test(await pendingScripts.textContent()), 'the page shows the restored hooks.json');
  console.log('PASS S19 page held save: a hooks.json that arrived while the draft saved is shown, not approved');
  // An open plan with a draft: its save is held first. A second press while it is held sends nothing either.
  const box0 = section.locator('[data-sp-box]'); if (!await box0.count()) await section.locator('[data-pj="spfile"]', { hasText: 'sprint.md' }).click();
  await app.evaluate(() => { globalThis.saves = []; });
  await box.fill((await box.inputValue()) + '\nApproved as edited.\n');
  await start.click();
  await until(() => app.evaluate(() => globalThis.saves.length > 0), 'the draft\'s save held');
  assert.equal(await start.isDisabled(), true, 'the button is on while its draft saves');
  await start.click({ force: true }); await page.waitForTimeout(300);
  assert.equal(await app.evaluate(() => globalThis.presses), 0, 'a press went out before its draft saved');
  await app.evaluate(() => { const held = globalThis.saves; globalThis.saves = null; held.forEach((go) => go()); });
  await until(() => app.evaluate(() => !!globalThis.letGo), 'the press held');
  assert.match(await readFile(path.join(folder, 'sprint.md'), 'utf8'), /Approved as edited\.\n$/, 'the press started before its draft was on disk');
  assert.equal(await start.isDisabled(), true, 'the button is on while its press is out');
  assert.equal((await start.textContent()).trim(), 'Starting…');
  await start.click({ force: true });
  assert.equal(await app.evaluate(() => globalThis.presses), 1, 'a second press went out while the first was');
  await app.evaluate(() => globalThis.letGo());
  // Halfway: the lead is made, the worker's folder is refused. The page says so and what was made.
  await said.waitFor({ timeout: 90000 }).catch(async (err) => { throw new Error(`no result line. main got: ${await app.evaluate(() => JSON.stringify(globalThis.answers ?? null))}; errors: ${JSON.stringify(errors).slice(0, 800)}; section: ${(await section.innerHTML().catch(() => 'gone')).slice(0, 1500)}`, { cause: err }); });
  assert.match(await said.textContent(), /^Not started: .*Made so far: lead\.$/s);
  await until(async () => await section.locator('[data-sp-prep]').count() === 0, 'the section is no longer a prep');
  assert.equal((await start.textContent()).trim(), 'Start again');
  assert.match(await record.textContent(), new RegExp('^Started .+ by you: your approval of its plan, sha256 ' + (await planOf()).slice(0, 12) + '\\.$'));
  await section.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT start-halfway ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  const made = (await call(instance, '/chat')).conversations.filter((c) => c.id === sprint || c.parent === sprint);
  assert.deepEqual(made.map((c) => c.id), [sprint], 'halfway made more than the lead');
  // Fixed, Start again keeps the lead and makes the worker; the record is the new press, of the plan as it is now.
  await writeFile(path.join(folder, 'roles.json'), roles('repo'));
  await start.click();
  await until(async () => /^Started: /.test(await said.textContent()), async () => 'the second press answered; said ' + await said.textContent(), 90000);
  assert.equal(await said.textContent(), 'Started: lead (kept), w2.');
  const all = (await call(instance, '/chat')).conversations.filter((c) => c.id === sprint || c.parent === sprint);
  assert.deepEqual(all.map((c) => c.title).sort(), ['S1', 'w2'], 'the lead was made twice or the worker not at all');
  assert.match(await record.textContent(), new RegExp('sha256 ' + (await planOf()).slice(0, 12) + '\\.$'));
  assert.equal(await app.evaluate(() => globalThis.presses), 2);
  assert.equal(await start.isDisabled(), false);
  assert.match(await section.locator('[data-sp-scripts="approved"]').textContent(), /^Scripts you approved at Start\. P9 runs these as you, outside every agent's mode, and only these:tidy <b>up<\/b> \(after-close\): /);
  assert.equal(await pendingScripts.count(), 0, 'the approved file still reads as pending');
  assert.deepEqual((await call(instance, '/projects/' + p.id)).project.sprints.find((x) => x.lead === sprint).started.scripts, [{ ...script, blocking: false }]);
  // The file changed after Start (an agent can write it): the page says so and shows what the next press would approve.
  const was = (await call(instance, '/projects/' + p.id)).project.sprints.find((x) => x.lead === sprint).files.find((f) => f.name === 'hooks.json').hash;
  assert.equal((await call(instance, '/projects/' + p.id + '/sprint-file', 'POST', { lead: sprint, name: 'hooks.json', hash: was, text: JSON.stringify({ scripts: [script, { name: 'gate', command: 'node gate.mjs', point: 'before-new-worker', blocking: true }] }) })).status, 200);
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); await page.locator('[data-pj="spopen"]').click(); // the page reads a project's files when it is opened
  await pendingScripts.waitFor({ timeout: 10000 });
  assert.match(await pendingScripts.textContent(), /^hooks\.json has changed since\. Not run until you press Start again, which approves these scripts\..*gate \(before-new-worker, blocking\): node gate\.mjs$/);
  console.log('PASS S19 page: the sprint section lists the scripts Start approves, the approved copy after it, and a file changed since');
  await section.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT start-again ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // S13 (SECURITY.md § Pause sprint): the started sprint's Pause and Resume, the owner's press.
  const pause = section.locator('[data-pj="sppause"], [data-pj="spresume"]'), pausedTag = section.locator('[data-sp-paused]');
  assert.equal((await pause.textContent()).trim(), 'Pause sprint'); assert.equal(await pausedTag.count(), 0);
  await pause.click();
  await pausedTag.waitFor({ timeout: 10000 });
  assert.equal((await pause.textContent()).trim(), 'Resume sprint');
  await section.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT s13-paused ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await pause.click();
  await until(async () => await pausedTag.count() === 0, 'Resume cleared the Paused mark');
  assert.equal((await pause.textContent()).trim(), 'Pause sprint');
  console.log('PASS S13 page: Pause sprint marks the started sprint Paused and turns into Resume sprint; Resume clears it');
  assert.deepEqual(errors, []);
  console.log('PASS window-10: Start sprint held shows Starting… and sends one press; halfway says what was made; Start again keeps the lead and makes w2; the record shows by you and the plan\'s sha256');
});

// S18 (SECURITY.md § Sprint scripts, "The library"): the Sprint scripts window writes the rows the agent's tools write.
test('projects: Sprint scripts S18 window makes, removes, keeps in the library, adds to a sprint and runs an approved script', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'plain'));
  const p = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).project;
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await ended(instance, first);
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'S1' });
  assert.equal(prep.status, 201, JSON.stringify(prep));
  const sprint = prep.sprint, folder = prep.folder;
  await writeFile(path.join(folder, 'roles.json'), JSON.stringify({ folder: 'plain', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  await writeFile(path.join(folder, 'roles', 'lead.work.md'), 'config');
  const onDisk = async () => JSON.parse(await readFile(path.join(folder, 'hooks.json'), 'utf8')).scripts, library = async () => (await call(instance, '/sprint-scripts')).library;
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); await page.locator('[data-pj="spopen"]').click();
  const section = page.locator(`[data-sprint="${sprint}"]`), dlg = page.locator('#pjScripts'), said = dlg.locator('[data-ss-said]');
  const rows = (where) => dlg.locator(`[data-ss-row="${where}"]`).evaluateAll((all) => all.map((li) => li.querySelector('.mono').textContent));
  const press = (k, where, name) => (where ? dlg.locator(`[data-ss-row="${where}"]`, { hasText: name }) : dlg).locator(`[data-ss="${k}"]`).click();
  const says = (re) => until(async () => re.test(await said.textContent()), async () => 'the window said ' + re + '; it says ' + await said.textContent());
  await section.locator('[data-pj="spscripts"]').click();
  await dlg.locator('h2', { hasText: 'Sprint scripts: S1' }).waitFor({ timeout: 10000 });
  assert.deepEqual([await rows('approved'), await rows('sprint'), await rows('library')], [[], [], []]);
  // Blocking is offered only at the points that can refuse a step.
  const blocking = dlg.locator('[name=blocking]');
  assert.equal(await blocking.isDisabled(), false, 'before-start cannot be blocking');
  await blocking.check(); await dlg.locator('[name=point]').selectOption('after-close');
  assert.deepEqual([await blocking.isDisabled(), await blocking.isChecked()], [true, false], 'after-close kept Blocking');
  // A row P9 refuses is said and saved nowhere.
  await dlg.locator('[name=name]').fill('mark <b>it</b>');
  await press('save'); await says(/^Not done: .*command: 1 to 200 characters/);
  assert.equal(await said.evaluate((e) => e.classList.contains('err')), true);
  assert.equal(existsSync(path.join(folder, 'hooks.json')), false, 'a refused row made hooks.json');
  // Save to sprint: in hooks.json, listed here and on the page behind as waiting for Start. What was typed stays.
  await dlg.locator('[name=command]').fill('/usr/bin/touch ran-now.txt');
  await press('save'); await says(/^In this sprint: mark <b>it<\/b>\. Not run until you press Start sprint, which approves it\.$/);
  const script = { name: 'mark <b>it</b>', command: '/usr/bin/touch ran-now.txt', point: 'after-close', blocking: false };
  assert.deepEqual(await onDisk(), [script]);
  assert.deepEqual(await rows('sprint'), ['mark <b>it</b> (after-close): /usr/bin/touch ran-now.txt']);
  assert.equal(await dlg.locator('b').count(), 0, 'a script name was drawn as HTML');
  assert.equal(await dlg.locator('[name=command]').inputValue(), '/usr/bin/touch ran-now.txt');
  assert.match(await section.locator('[data-sp-scripts="pending"]').textContent(), /^Start sprint approves this script\..*touch ran-now\.txt$/);
  assert.equal(await dlg.locator('[data-ss="run"]').count(), 0, 'Run now is offered before any Start');
  // Its row's Save to library keeps it for other sprints; Remove takes it out of this one; Add to sprint brings it back.
  await press('tolib', 'sprint', 'mark'); await says(/^In your library: mark/);
  assert.deepEqual([await library(), await rows('library')], [[script], ['mark <b>it</b> (after-close): /usr/bin/touch ran-now.txt']]);
  await press('rm', 'sprint', 'mark'); await says(/^Removed from this sprint: mark/);
  assert.deepEqual([await onDisk(), await rows('sprint'), await section.locator('[data-sp-scripts]').count()], [[], [], 0]);
  await press('add', 'library', 'mark'); await says(/^In this sprint: mark .* Not run until you press Start sprint/);
  assert.deepEqual(await onDisk(), [script]);
  // Edit fills the form from the row; Save to library changes the library's copy and no sprint's.
  await dlg.locator('[name=command]').fill(''); await press('libedit', 'library', 'mark');
  assert.deepEqual([await dlg.locator('[name=name]').inputValue(), await dlg.locator('[name=command]').inputValue(), await dlg.locator('[name=point]').inputValue()], [script.name, script.command, 'after-close']);
  await dlg.locator('[name=command]').fill('/usr/bin/touch other.txt'); await press('savelib'); await says(/^In your library: mark/);
  assert.deepEqual([(await library())[0].command, (await onDisk())[0].command], ['/usr/bin/touch other.txt', script.command], 'a library edit changed the sprint, or did not save');
  // O189: Every (minutes) is offered at the point every alone; P9 refuses a number out of range; the row says it repeats.
  const every = dlg.locator('[name=every]');
  assert.equal(await every.isDisabled(), true, 'Every offered at after-close');
  await dlg.locator('[name=name]').fill('tick'); await dlg.locator('[name=command]').fill('/usr/bin/true'); await dlg.locator('[name=point]').selectOption('every');
  assert.equal(await every.isDisabled(), false, 'Every not offered at every');
  await every.fill('5'); await press('savelib'); await says(/^Not done: .*every: .*10 to 120/);
  await every.fill('15'); await press('savelib'); await says(/^In your library: tick\.$/);
  assert.deepEqual((await library()).find((s) => s.name === 'tick'), { name: 'tick', command: '/usr/bin/true', point: 'every', blocking: false, every: 15 });
  assert.ok((await rows('library')).includes('tick (repeats every 15 minutes): /usr/bin/true'), 'the library row does not say it repeats');
  await dlg.locator('[name=point]').selectOption('after-close'); await press('libedit', 'library', 'tick');
  assert.deepEqual([await every.inputValue(), await every.isDisabled()], ['15', false], 'Edit did not bring back the minutes');
  await press('librm', 'library', 'tick'); await says(/^Removed from your library: tick/);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-scripts ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // Start approves the sprint's copy: only then is Run now offered, and it runs that copy in the sprint's folder.
  await press('close'); assert.equal(await dlg.evaluate((d) => d.open), false);
  await section.locator('[data-pj="spstart"]').click();
  await until(async () => /^Started: lead\.$/.test(await section.locator('[data-sp-start]').textContent().catch(() => '')), async () => 'Start answered; it says ' + await section.locator('[data-sp-start]').textContent().catch(() => 'nothing'), 90000);
  await section.locator('[data-pj="spscripts"]').click();
  await dlg.locator('[data-ss-row="approved"]').waitFor({ timeout: 10000 });
  assert.deepEqual(await rows('approved'), ['mark <b>it</b> (after-close): /usr/bin/touch ran-now.txt']);
  assert.equal(existsSync(path.join(folder, 'ran-now.txt')), false, 'the script ran before it was asked to');
  await press('run', 'approved', 'mark'); await says(/^Ran mark <b>it<\/b>: exit 0 in \d+ ms\. The run is in hooks\.log\.$/);
  assert.equal(existsSync(path.join(folder, 'ran-now.txt')), true, 'Run now did not run the approved command in the sprint folder');
  assert.equal(existsSync(path.join(folder, 'other.txt')), false, 'the library\'s copy ran');
  assert.match(await readFile(path.join(folder, 'hooks.log'), 'utf8'), / \| after-close \(run now\) \| mark <b>it<\/b> \| exit 0 \| /);
  assert.equal(await section.locator('[data-pj="spfile"]', { hasText: 'hooks.log' }).count(), 1, 'the page behind does not list the run\'s log');
  // Out of the library: the sprint keeps its copy.
  await press('librm', 'library', 'mark'); await says(/^Removed from your library: mark/);
  assert.deepEqual([await library(), await rows('library'), (await onDisk()).length], [[], [], 1]);
  assert.deepEqual(errors, []);
  console.log('PASS S18 page: the Sprint scripts window saved a row to the sprint and the library, refused a bad one, removed and added it back, edited the library alone, and ran only the copy Start approved');
});

test('projects: Sprint scripts S20 window lists the scripts added after Start, approves one or all, refuses a list that changed, and asks before the switch is turned on', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'plain'));
  const p = (await call(instance, '/projects', 'POST', { name: 'Later', work: { kind: 'new', parent: '', name: 'later' } })).project;
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await ended(instance, first);
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'S2' });
  const sprint = prep.sprint, folder = prep.folder;
  await writeFile(path.join(folder, 'roles.json'), JSON.stringify({ folder: 'plain', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  await writeFile(path.join(folder, 'roles', 'lead.work.md'), 'config');
  const started = await call(instance, `/sprints/${sprint}/start`, 'POST', {}); assert.equal(started.status, 200, JSON.stringify(started));
  const line = (n) => `${n} (after-close): /usr/bin/touch ${n}.txt`;
  const add = async (name) => assert.equal((await call(instance, '/sprint-scripts', 'POST', { sprint, save: { name, command: `/usr/bin/touch ${name}.txt`, point: 'after-close' } })).status, 200);
  const stands = async () => { const b = await call(instance, '/sprint-scripts?sprint=' + sprint), n = (rows) => rows.map((r) => r.name); return [b.allowed, n(b.additional), n(b.waiting)]; };
  await add('one');
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); await page.locator('[data-pj="spopen"]').click();
  const section = page.locator(`[data-sprint="${sprint}"]`), dlg = page.locator('#pjScripts'), said = dlg.locator('[data-ss-said]'), sw = dlg.locator('[data-ss="allow"]'), warn = dlg.locator('[data-ss-warn]');
  const rows = (where) => dlg.locator(`[data-ss-row="${where}"]`).evaluateAll((all) => all.map((li) => li.querySelector('.mono').textContent));
  const press = (k, where, name) => (where ? dlg.locator(`[data-ss-row="${where}"]`, { hasText: name }) : dlg).locator(`[data-ss="${k}"]`).click();
  const says = (re) => until(async () => re.test(await said.textContent()), async () => 'the window said ' + re + '; it says ' + await said.textContent());
  await section.locator('[data-pj="spscripts"]').click();
  await dlg.locator('[data-ss-sec="later"]').waitFor({ timeout: 10000 });
  // Off: the row added after Start waits, with Approve and no Run now. One row: no Approve all.
  assert.deepEqual([await sw.isChecked(), await rows('additional'), await rows('waiting')], [false, [], [line('one')]]);
  assert.deepEqual([await dlg.locator('[data-ss-row="waiting"] [data-ss="run"]').count(), await dlg.locator('[data-ss="approveall"]').count()], [0, 0]);
  await press('approve', 'waiting', 'one'); await says(/^Approved: one\. It runs at its point from now on\.$/);
  assert.deepEqual([await rows('additional'), await rows('waiting'), await stands()], [[line('one')], [], [false, ['one'], []]]);
  await press('run', 'additional', 'one'); await says(/^Ran one: exit 0 in \d+ ms/);
  assert.equal(existsSync(path.join(folder, 'one.txt')), true, 'Run now did not run the row approved after Start');
  // A row saved here waits and says so. The list then changes behind the window: its Approve approves nothing and shows the list as it is.
  await dlg.locator('[name=name]').fill('two'); await dlg.locator('[name=command]').fill('/usr/bin/touch two.txt'); await dlg.locator('[name=point]').selectOption('after-close');
  await press('save'); await says(/^In this sprint: two\. It waits under Added after Start until you approve it\.$/);
  await add('three');
  assert.deepEqual(await rows('waiting'), [line('two')]);
  await press('approve', 'waiting', 'two'); await says(/^Not done: hooks\.json changed since it was shown\. Look again\.$/);
  assert.deepEqual([await said.evaluate((e) => e.classList.contains('err')), await rows('waiting'), await stands()], [true, [line('two'), line('three')], [false, ['one'], ['two', 'three']]]);
  await press('approveall'); await says(/^Approved: two, three\. They run at their points from now on\.$/);
  assert.deepEqual([await rows('waiting'), await stands()], [[], [false, ['one', 'two', 'three'], []]]);
  // The switch: on is asked first, in the window. Keep off changes nothing.
  await sw.click(); await warn.waitFor({ timeout: 5000 });
  assert.match(await warn.textContent(), /any script an agent adds to a started sprint runs as you.*without asking you first/);
  assert.deepEqual([await sw.isChecked(), (await stands())[0]], [false, false], 'the switch turned on before the warning was answered');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-scripts-later ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await press('allowno'); assert.deepEqual([await warn.count(), await sw.isChecked(), (await stands())[0]], [0, false, false]);
  await sw.click(); await press('allowon'); await says(/^Allow additional scripts is on, for every sprint\.$/);
  assert.deepEqual([await sw.isChecked(), (await stands())[0]], [true, true]);
  // On: a row saved now runs with no Approve. Off is not asked: the row then waits.
  await dlg.locator('[name=name]').fill('four'); await dlg.locator('[name=command]').fill('/usr/bin/touch four.txt');
  await press('save'); await says(/^In this sprint: four\. It runs from now on\.$/);
  assert.deepEqual([await rows('waiting'), (await rows('additional')).includes(line('four')), await dlg.locator('[data-ss="approve"], [data-ss="approveall"]').count()], [[], true, 0]);
  await sw.click(); await says(/^Allow additional scripts is off\./);
  assert.deepEqual([await warn.count(), await sw.isChecked(), await rows('waiting'), await stands()], [0, false, [line('four')], [false, ['one', 'two', 'three'], ['four']]]);
  assert.deepEqual(errors, []);
  console.log('PASS S20 page: a row added after Start waited with Approve and no Run now; Approve ran it; a changed list approved nothing; Approve all; the switch asked first, Keep off kept it off, on ran a new row with no Approve, off made it wait');
});

// Sprint screens, the first: the project's page lists its sprints, one button each; the button opens that sprint's own page,
// Sprint Setup until it is started, with a way back. New sprint lands in the new sprint's Sprint Setup.
test('projects: Sprint Setup page opens from the sprint\'s button on the project page, one sprint to a page, with Back', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'plain'));
  const p = (await call(instance, '/projects', 'POST', { name: 'Pages', work: { kind: 'new', parent: '', name: 'pages' } })).project;
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await ended(instance, first);
  const run = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Running one' });
  await writeFile(path.join(run.folder, 'roles.json'), JSON.stringify({ folder: 'plain', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  await writeFile(path.join(run.folder, 'roles', 'lead.work.md'), 'config');
  const started = await call(instance, `/sprints/${run.sprint}/start`, 'POST', {}); assert.equal(started.status, 200, JSON.stringify(started));
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Docs prep' });
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  const btn = (lead) => page.locator(`[data-pj="spopen"][data-lead="${lead}"]`), title = page.locator('[data-sp-title]'), back = page.locator('[data-pj="spback"]');
  await btn(prep.sprint).waitFor({ timeout: 10000 });
  // The project page: one button per sprint, saying which is started; no sprint's files on it.
  assert.equal(await page.locator('[data-pj="spopen"]').count(), 2);
  assert.match(await btn(prep.sprint).textContent(), /^Docs prepNot started$/);
  assert.match(await btn(run.sprint).textContent(), /^Running oneStarted \S/);
  assert.deepEqual([await page.locator('[data-sprint]').count(), await page.locator('[data-pj="spfile"]').count(), await title.count()], [0, 0, 0], 'the project page shows a sprint\'s files');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprints-list ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // The prep's button: its Sprint Setup, that sprint only, with Start sprint, its roles and its files.
  await btn(prep.sprint).click();
  await page.locator(`[data-sp-page="${prep.sprint}"]`).waitFor({ timeout: 5000 });
  assert.equal(await title.textContent(), 'Sprint Setup');
  assert.deepEqual(await page.locator('[data-sprint]').evaluateAll((e) => e.map((x) => x.dataset.sprint)), [prep.sprint]);
  assert.equal(await page.locator('[data-sprint] h2').textContent(), 'Docs prep');
  assert.equal((await page.locator('[data-pj="spstart"]').textContent()).trim(), 'Start sprint');
  assert.deepEqual(await page.locator('[data-role-row]').evaluateAll((r) => r.map((x) => x.dataset.roleRow)), ['lead', 'review']);
  assert.ok(await page.locator('[data-pj="spfile"]', { hasText: /^sprint\.md/ }).count(), 'the plan file is on Sprint Setup');
  assert.deepEqual([await page.locator('[data-pj="spnew"]').count(), await page.locator('#pjName').count()], [0, 0], 'the project page\'s own parts are on a sprint page');
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-setup-page ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // Back: the project page again.
  assert.match(await back.textContent(), /Pages/);
  await back.click();
  await page.locator('#pjName').waitFor({ timeout: 5000 });
  assert.deepEqual([await title.count(), await page.locator('[data-sprint]').count(), await page.locator('[data-pj="spopen"]').count()], [0, 0, 2]);
  // A started sprint's button: its page, named Sprint View, with its approval record and Start again.
  await btn(run.sprint).click();
  await page.locator(`[data-sp-page="${run.sprint}"]`).waitFor({ timeout: 5000 });
  assert.equal(await title.textContent(), 'Sprint View');
  assert.deepEqual([await page.locator('[data-sprint] h2').textContent(), (await page.locator('[data-pj="spstart"]').textContent()).trim(), await page.locator('[data-sp-started]').count()], ['Running one', 'Start again', 1]);
  // The project's row in the panel is a way back too.
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await page.locator('#pjName').waitFor({ timeout: 5000 });
  assert.equal(await title.count(), 0);
  // New sprint lands in the new sprint's Sprint Setup, and Back then lists three.
  await page.locator('[data-pj="spnew"]').click();
  await page.locator('#pjAsk input').fill('Third');
  await page.locator('#pjAsk [value=yes]').click();
  await until(async () => (await page.locator('[data-sprint] h2').textContent({ timeout: 1000 }).catch(() => '')) === 'Third', 'New sprint landed on its own page');
  assert.equal(await title.textContent(), 'Sprint Setup');
  await back.click();
  await until(async () => (await page.locator('[data-pj="spopen"]').count()) === 3, 'three sprints listed');
  assert.deepEqual(errors, []);
  console.log('PASS Sprint Setup page: the project page listed two sprints as buttons and no sprint files; the prep opened as Sprint Setup with its Start, roles and files; Back returned; the started one opened as Sprint View; New sprint landed in its Sprint Setup');
});

// Instructions are saved 600 ms after the last key. A sprint's button pressed inside that time replaces the page, so the
// typed text is saved first; a save the daemon refuses keeps the box, its text and the project page.
test('projects: Instructions typed just before a sprint\'s button are saved first, and a refused save keeps the page', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Typed', work: { kind: 'new', parent: '', name: 'typed' } })).project;
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Docs prep' });
  const { page } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  const btn = page.locator(`[data-pj="spopen"][data-lead="${prep.sprint}"]`), saved = async () => (await call(instance, '/projects/' + p.id)).project.instructions ?? '';
  await btn.waitFor({ timeout: 10000 });
  await page.locator('#projPage [data-pj=edit]').click();
  await page.locator('#pjInstr').fill('Typed and left at once.');
  await btn.click(); // no wait: the 600 ms save has not run
  await page.locator(`[data-sp-page="${prep.sprint}"]`).waitFor({ timeout: 5000 });
  assert.equal(await saved(), 'Typed and left at once.', 'the text typed just before the sprint\'s button was lost');
  await page.locator('[data-pj="spback"]').click();
  await page.locator('#pjName').waitFor({ timeout: 5000 });
  // Refused (longer than the daemon takes): the box and its text stay, no sprint page opens, the saved text is the old one.
  if (!await page.locator('#pjInstr').count()) await page.locator('#projPage [data-pj=edit]').click();
  const long = 'x'.repeat(32001);
  await page.locator('#pjInstr').evaluate((box) => box.removeAttribute('maxlength')); // the box stops at what the daemon takes
  await page.locator('#pjInstr').fill(long);
  await btn.click();
  await new Promise((go) => setTimeout(go, 1500));
  assert.equal(await page.locator('#pjInstr').count(), 1, 'the box left the page after a refused save: ' + JSON.stringify([await page.locator('[data-sp-title]').count(), await page.locator('#projPage [data-pj=edit]').allTextContents(), await page.locator('#toasts').textContent(), (await saved()).length]));
  assert.deepEqual([await page.locator('[data-sp-title]').count(), (await page.locator('#pjInstr').inputValue()).length, await saved()], [0, 32001, 'Typed and left at once.']);
  console.log('PASS Instructions before a sprint button: the text typed just before the click was on the daemon when the sprint page opened; a refused save kept the box, its 32001 characters and the project page');
});

// Sprint View: a started sprint's page opens on where the sprint stands. Its numbers are the daemon's status answer
// (the one the sprint_status tool gives an agent), and they follow the plan file with no reload.
test('projects: Sprint View shows a started sprint\'s items, time and chats from the status answer, and follows the plan file', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'plain'));
  const p = (await call(instance, '/projects', 'POST', { name: 'Views', work: { kind: 'new', parent: '', name: 'views' } })).project;
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await ended(instance, first);
  const run = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Watched one' });
  const plan = (two) => `# Plan\n\n- [x] A1: draw the page; role lead\n- [${two ? 'x' : ' '}] A2: test the page; role lead\n- [ ] B1: write it up; role docs\n`;
  await writeFile(path.join(run.folder, 'sprint.md'), plan(false));
  await writeFile(path.join(run.folder, 'roles.json'), JSON.stringify({ folder: 'plain', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  await writeFile(path.join(run.folder, 'roles', 'lead.work.md'), 'config');
  const script = (name) => ({ name, command: `/usr/bin/touch ${name}.txt`, point: 'after-close', blocking: false });
  await writeFile(path.join(run.folder, 'hooks.json'), JSON.stringify({ scripts: [script('base')] }));
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Not yet' });
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  const btn = (lead) => page.locator(`[data-pj="spopen"][data-lead="${lead}"]`), view = page.locator('[data-sv]'), fact = (k) => page.locator(`[data-sv-fact="${k}"]`).textContent();
  // Sprint Setup has no Sprint View: nothing runs yet.
  await btn(prep.sprint).click();
  await page.locator(`[data-sp-page="${prep.sprint}"]`).waitFor({ timeout: 5000 });
  await new Promise((go) => setTimeout(go, 1200));
  assert.deepEqual([await page.locator('[data-sp-title]').textContent(), await view.count()], ['Sprint Setup', 0]);
  await page.locator('[data-pj="spback"]').click();
  await btn(run.sprint).waitFor({ timeout: 5000 });
  const started = await call(instance, `/sprints/${run.sprint}/start`, 'POST', { hooks: (await call(instance, '/sprint-scripts?sprint=' + run.sprint)).hash }); assert.equal(started.status, 200, JSON.stringify(started));
  await page.locator(`#navList [data-proj="${p.id}"]`).click(); // the page reads the project again: the sprint is started now
  await until(async () => /Started/.test(await btn(run.sprint).textContent().catch(() => '')), 'the started sprint\'s button');
  await btn(run.sprint).click();
  await view.waitFor({ timeout: 10000 });
  const st = await call(instance, `/sprints/${run.sprint}/status`);
  assert.deepEqual([st.status, st.done, st.items.length, st.workers.map((w) => w.key)], [200, { merged: 0, ticked: 1, unproven: 0, total: 3 }, 3, ['lead']], JSON.stringify(st).slice(0, 600));
  assert.equal(await page.locator('[data-sp-title]').textContent(), 'Sprint View');
  assert.equal(await page.locator('[data-sv-done]').textContent(), `${st.done.merged} of ${st.done.total} items merged`);
  assert.deepEqual([await fact('ticked'), await fact('chats'), await fact('scripts')], [`${st.done.ticked} of ${st.done.total}`, String(st.workers.length), '1']);
  assert.equal(await fact('rate'), String(st.prs_per_hour), 'PRs an hour, from the status answer'); // O162
  await writeFile(path.join(run.folder, 'hooks.json'), JSON.stringify({ scripts: [script('base'), script('later'), script('unseen')] }));
  assert.match(await fact('time'), /^(under a minute|\d+ min)$/);
  assert.equal(await page.locator('.sv-ring.big b').textContent(), '0/3');
  // Each item of the plan, in the plan's order, with its role and that a tick is not a review.
  assert.deepEqual(await page.locator('[data-sv-item]').evaluateAll((rows) => rows.map((r) => [r.dataset.svItem, r.querySelector('.box').textContent, r.querySelector('.muted').textContent, r.querySelector('.tag').textContent])),
    [['A1', '☑', 'lead', 'Ticked, not reviewed'], ['A2', '☐', 'lead', 'Open'], ['B1', '☐', 'docs', 'Open']]);
  // Each chat of the sprint by its role, with its model and effort and what it is doing.
  const lead = page.locator('[data-sv-worker="lead"]'), w = st.workers[0];
  assert.deepEqual([await page.locator('[data-sv-worker]').count(), await lead.getAttribute('data-chat')], [1, run.sprint]);
  assert.ok((await lead.textContent()).includes(`${w.model} · ${w.effort}`), await lead.textContent());
  assert.match(await lead.locator('[data-sv-state]').textContent(), /^(Working|Idle)$/);
  // The lead's own two items (A1, A2) are its ring, and the big ring is drawn at its size (a 15 px page icon rule once shrank it).
  assert.deepEqual([w.work, await lead.locator('.sv-ring b').textContent(), await page.locator('.sv-ring.big svg').evaluate((el) => el.getBoundingClientRect().width)], [{ done: 0, total: 2 }, '0/2', 76]);
  // The Setup parts are still below: the roles and the files.
  assert.deepEqual([await page.locator('[data-role-row]').count() > 0, await page.locator('[data-pj="spfile"]').count() > 0, (await page.locator('[data-pj="spstart"]').textContent()).trim()], [true, true, 'Start again']);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-view ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // The plan changes on disk (an agent ticks a box): the page follows with no click.
  await writeFile(path.join(run.folder, 'sprint.md'), plan(true));
  await until(async () => (await fact('ticked')) === '2 of 3', async () => 'the page never followed the plan: ' + await fact('ticked'), 12000);
  assert.equal(await page.locator('[data-sv-item="A2"] .tag').textContent(), 'Ticked, not reviewed');
  // I1's plan line: no "## Phase" heading so far, so no line; headings give "N of N steps in <phase>, N of N phases".
  assert.equal(await page.locator('[data-sv-phase]').count(), 0, 'a plan with no phase heading has no phase line');
  await writeFile(path.join(run.folder, 'sprint.md'), '# Plan\n\n## Phase 1: the page\n- [x] A1: draw the page; role lead\n- [x] A2: test the page; role lead\n\n## Phase 2: the docs\n- [ ] B1: write it up; role docs\n');
  await until(async () => (await page.locator('[data-sv-phase]').textContent().catch(() => '')) === '0 of 2 steps in Phase 1: the page, 0 of 2 phases', async () => 'phase line: ' + await page.locator('[data-sv-phase]').textContent().catch(() => 'none'), 12000);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-view-phases ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  await writeFile(path.join(run.folder, 'sprint.md'), plan(true));
  await until(async () => (await page.locator('[data-sv-phase]').count()) === 0, 'the phase line left with the headings', 12000);
  // Scripts are counted once each: one approved at Start, one approved after it, one still waiting is "2 running, 1 waiting".
  const hash = (await call(instance, '/sprint-scripts?sprint=' + run.sprint)).hash;
  const ok = await call(instance, `/sprints/${run.sprint}/approve-scripts`, 'POST', { hash, names: ['later'] });
  assert.deepEqual([ok.status, ok.approved?.map((r) => r.name)], [200, ['later']], JSON.stringify(ok));
  const counts = (await call(instance, `/sprints/${run.sprint}/status`)).scripts;
  assert.deepEqual(counts, { running: 2, additional: 1, waiting: 1 });
  await until(async () => (await fact('scripts')) === '2 running, 1 waiting for you', async () => 'the scripts fact: ' + await fact('scripts'), 12000);
  // A chat's row opens that chat.
  await lead.click();
  await until(async () => await page.locator('#projPage').isHidden(), 'the lead\'s row never opened its chat');
  assert.deepEqual(errors, []);
  console.log('PASS Sprint View: Sprint Setup had none; scripts counted once each (2 running, 1 waiting); the started sprint opened as Sprint View with 0 of 3 items merged, 1 of 3 ticked, its time, the three items with their roles, the lead with its model, effort and state, all equal to the status route; the page followed a box ticked on disk; the lead\'s row opened its chat');
});

// Close sprint (sprint spec S16): the Sprint View's button asks once, a script that refuses is said beside it, and a
// closed sprint's page is its record: no Close, no Start, the same numbers as the status route keeps.
test('projects: Close sprint on the Sprint View asks first, says a refusal, then shows the closed sprint\'s record', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'plain'));
  const p = (await call(instance, '/projects', 'POST', { name: 'Ends', work: { kind: 'new', parent: '', name: 'ends' } })).project;
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await ended(instance, first);
  const run = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Ending one' });
  const gate = path.join(instance.workspace, 'gate.mjs');
  await writeFile(gate, 'console.log("the gate says not yet"); process.exit(1);');
  const hooksFile = path.join(run.folder, 'hooks.json');
  await writeFile(path.join(run.folder, 'sprint.md'), '# Plan\n\n- [x] A1: draw the page; role lead\n- [ ] A2: test the page; role lead\n');
  await writeFile(path.join(run.folder, 'roles.json'), JSON.stringify({ folder: 'plain', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  await writeFile(path.join(run.folder, 'roles', 'lead.work.md'), 'config');
  await writeFile(hooksFile, JSON.stringify({ scripts: [{ name: 'gate', command: `${process.execPath} ${gate}`, point: 'before-close', blocking: true }] }));
  const row = async () => (await call(instance, '/projects/' + p.id)).project.sprints.find((x) => x.lead === run.sprint);
  const started = await call(instance, `/sprints/${run.sprint}/start`, 'POST', { hooks: (await row()).files.find((f) => f.name === 'hooks.json').hash });
  assert.equal(started.status, 200, JSON.stringify(started));
  const { page, errors } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  const btn = page.locator(`[data-pj="spopen"][data-lead="${run.sprint}"]`), view = page.locator('[data-sv]'), close = page.locator('[data-pj="spclose"]'), ask = page.locator('dialog[open] form');
  const status = () => call(instance, `/sprints/${run.sprint}/status`);
  await btn.click();
  await close.waitFor({ timeout: 10000 });
  assert.deepEqual([await view.getAttribute('data-sv'), await page.locator('[data-sp-title]').textContent()], ['open', 'Sprint View']);
  // The press asks first; Cancel closes nothing.
  await close.click();
  assert.match(await ask.textContent(), /Close this sprint\?.*Nothing is deleted/s);
  await ask.locator('[value="no"]').click();
  assert.deepEqual([(await status()).closed ?? null, await view.getAttribute('data-sv')], [null, 'open']);
  // A before-close script that exits 1 refuses the close: said beside the button, the sprint stays open.
  await close.click(); await ask.locator('[value="yes"]').click();
  await until(async () => /^Not closed: /.test(await page.locator('[data-sv-said]').textContent().catch(() => '')), 'the refusal beside the button');
  assert.deepEqual([(await status()).closed ?? null, await view.getAttribute('data-sv'), await close.isEnabled()], [null, 'open', true]);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-close-refused ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // The script's own file now passes (the approved command line is the same) and the press is made again: closed.
  await writeFile(gate, 'console.log("the gate says go"); process.exit(0);');
  await close.click(); await ask.locator('[value="yes"]').click();
  await until(async () => (await view.getAttribute('data-sv').catch(() => '')) === 'closed', async () => 'the closed page; beside the button: ' + await page.locator('[data-sv-said]').textContent().catch(() => 'nothing'), 20000);
  const st = await status();
  assert.deepEqual([st.status, st.closed?.by, st.workers.map((w) => [w.key, w.state])], [200, 'owner', [['lead', 'stopped']]], JSON.stringify(st).slice(0, 600));
  assert.equal(await page.locator('[data-sp-title]').textContent(), 'Closed sprint');
  assert.match(await page.locator('[data-sv-closed]').textContent(), /^Closed .+ by you\. This is its record/);
  assert.deepEqual([await close.count(), await page.locator('[data-pj="spstart"]').count()], [0, 0], 'a closed sprint has no Close and no Start');
  assert.deepEqual([await page.locator('.sv-facts dt').first().textContent(), await page.locator('[data-sv-fact="ticked"]').textContent(), await page.locator('[data-sv-worker="lead"] [data-sv-state]').textContent()],
    ['Ran', `${st.done.ticked} of ${st.done.total}`, 'Stopped']);
  // The record no longer changes: a box ticked after Close is not counted, on the page or by the route.
  await writeFile(path.join(run.folder, 'sprint.md'), '# Plan\n\n- [x] A1: draw the page; role lead\n- [x] A2: test the page; role lead\n');
  await new Promise((go) => setTimeout(go, 6500)); // longer than the page's 5 s re-read
  assert.deepEqual([await page.locator('[data-sv-fact="ticked"]').textContent(), (await status()).done.ticked], ['1 of 2', 1]);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sprint-closed ' + (await page.screenshot({ type: 'png' })).toString('base64'));
  // The project page says so on the sprint's button.
  await page.locator('[data-pj="spback"]').click();
  await until(async () => await btn.locator('[data-sp-closed]').count() === 1, 'the sprint\'s button says Closed');
  assert.match(await btn.locator('[data-sp-closed]').textContent(), /^Closed /);
  assert.deepEqual(errors, []);
  console.log('PASS Close sprint page: the press asked first and Cancel closed nothing; a before-close exit 1 was said beside the button and the sprint stayed open; the next press closed it: Closed sprint, by you, Ran, the lead Stopped, no Close and no Start, equal to the status route; a box ticked after Close changed nothing; the project page\'s button says Closed');
});

// Row 697 A: Instructions typed and then left by the side panel (a chat, another project) inside the 600 ms were dropped:
// the timer ran after the page was emptied and found no box. They are sent as the page is left. B, C: a role's row on
// Sprint Setup sets what it owns and its mode (permissions), both kept in roles.json with the rest of the file.
test('projects: Instructions left by the side panel are saved; Sprint Setup sets a role\'s owns and mode', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Leaving', work: { kind: 'new', parent: '', name: 'leaving' } })).project;
  const other = (await call(instance, '/projects', 'POST', { name: 'Elsewhere', work: { kind: 'new', parent: '', name: 'elsewhere' } })).project;
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Owned prep' });
  await writeFile(path.join(prep.folder, 'roles.json'), JSON.stringify({ folder: 'leaving', roles: [{ key: 'lead', provider: 'claude', model: '', effort: '' }, { key: 'review', provider: 'codex', model: '', effort: '', mode: 'Read-only' }] }, null, 2));
  const { page, app } = await launch(t, instance);
  const saved = async () => (await call(instance, '/projects/' + p.id)).project.instructions ?? '';
  const typeThenLeave = async (text, leave) => {
    await page.locator(`#navList [data-proj="${p.id}"]`).click();
    await page.locator('#pjName').waitFor({ timeout: 10000 });
    if (!await page.locator('#pjInstr').count()) await page.locator('#projPage [data-pj=edit]').click();
    await page.locator('#pjInstr').fill(text);
    await leave(); // no wait: the 600 ms save has not run
    await new Promise((go) => setTimeout(go, 1500));
    return saved();
  };
  assert.equal(await typeThenLeave('Left by a chat.', () => page.locator(`#navList .row[data-chat="${chat}"]`).click()), 'Left by a chat.', 'Instructions typed then a chat clicked in the side panel were lost');
  assert.equal(await typeThenLeave('Left by a project.', () => page.locator(`#navList [data-proj="${other.id}"]`).click()), 'Left by a project.', 'Instructions typed then another project clicked were lost');
  assert.equal((await call(instance, '/projects/' + other.id)).project.instructions ?? '', '', 'the text went to the project it was typed in, not the one opened');
  // A refused save on a side-panel leave: the exact text is kept for its project, shown again when that project opens, and
  // sent to that project only, not to the one opened meanwhile. A rename onto a folder that has a file in it fails, also as root.
  const bases = [path.join(path.dirname(instance.workspace), '.local', 'state', 'p9-foundation'), instance.state];
  const base = (await Promise.all(bases.map((b) => stat(path.join(b, 'projects', p.id)).then(() => b, () => null)))).find(Boolean);
  assert.ok(base, 'found P9\'s projects folder');
  const instrFile = path.join(base, 'projects', p.id, 'instructions.md');
  const otherSaved = async () => (await call(instance, '/projects/' + other.id)).project.instructions ?? '';
  let before = 'Left by a project.';
  for (const [text, leave] of [['Refused, then a chat.\nSecond line kept.', () => page.locator(`#navList .row[data-chat="${chat}"]`).click()], ['Refused, then a project.', () => page.locator(`#navList [data-proj="${other.id}"]`).click()]]) {
    await page.locator(`#navList [data-proj="${p.id}"]`).click();
    await page.locator('#pjName').waitFor({ timeout: 10000 });
    if (!await page.locator('#pjInstr').count()) await page.locator('#projPage [data-pj=edit]').click();
    await rm(instrFile, { force: true }); await mkdir(path.join(instrFile, 'blocked'), { recursive: true });
    await page.locator('#pjInstr').fill(text);
    await leave();
    await page.locator('#pjInstr').waitFor({ state: 'detached', timeout: 5000 });
    await new Promise((go) => setTimeout(go, 1500));
    assert.ok(existsSync(path.join(instrFile, 'blocked')), 'the save could not have landed: the block is still there');
    await rm(instrFile, { recursive: true, force: true }); await writeFile(instrFile, before); // the cause is gone, the saved text back; nothing has sent the new text again yet
    assert.deepEqual([await saved(), await otherSaved()], [before, ''], 'the save was refused, and nothing went to the project opened instead');
    await page.locator(`#navList [data-proj="${p.id}"]`).click();
    await until(async () => (await page.locator('#pjInstr').inputValue().catch(() => '')) === text, async () => 'the refused text was not shown again: ' + JSON.stringify(await page.locator('#pjInstr').inputValue().catch(() => 'no box')));
    await until(async () => (await saved()) === text, async () => 'the kept text was not sent again to its project: ' + JSON.stringify(await saved()));
    await until(async () => (await page.locator('[data-pj-draft]').count()) === 0, 'the not-saved line left after the save');
    assert.equal(await otherSaved(), '', 'the other project still has none');
    before = text;
  }

  // B, C on the sprint's page.
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await page.locator(`[data-pj="spopen"][data-lead="${prep.sprint}"]`).click();
  const owns = page.locator(`[data-sp-owns][data-role="lead"][data-lead="${prep.sprint}"]`), mode = (role) => page.locator(`select[data-spr="mode"][data-role="${role}"][data-lead="${prep.sprint}"]`);
  await owns.waitFor({ timeout: 10000 });
  assert.equal(await mode('review').inputValue(), 'Read-only', 'the review row shows the mode roles.json has');
  assert.deepEqual(await mode('review').locator('option').allTextContents(), ['Not set', 'Read-only', 'Workspace access', 'Auto review', 'Full access'], 'a codex row lists codex\'s modes');
  const rolesNow = async () => { for (;;) { try { return JSON.parse(await readFile(path.join(prep.folder, 'roles.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise((go) => setTimeout(go, 50)); } } }; // the hash-checked save moves the old file aside for a moment
  await owns.fill('the window, Settings'); await owns.press('Enter');
  await until(async () => (await rolesNow()).roles[0].owns === 'the window, Settings', 'owns saved to roles.json');
  await mode('lead').selectOption('Plan');
  await until(async () => (await rolesNow()).roles[0].mode === 'Plan', 'mode saved to roles.json');
  await mode('review').selectOption('');
  await until(async () => !('mode' in (await rolesNow()).roles[1]), 'Not set removes the mode');
  const r = await rolesNow();
  assert.deepEqual([r.folder, r.roles.map((x) => x.key), r.roles[0].owns, r.roles[0].mode], ['leaving', ['lead', 'review'], 'the window, Settings', 'Plan'], 'the rest of roles.json is kept');
  await owns.fill(''); await owns.press('Enter');
  await until(async () => !('owns' in (await rolesNow()).roles[0]), 'an emptied owns removes the key');
  await owns.fill('the window, Settings'); await owns.press('Enter');
  await until(async () => (await rolesNow()).roles[0].owns === 'the window, Settings', 'owns saved again');
  const shot = async (name) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + (await page.screenshot({ type: 'png' })).toString('base64')); };
  await shot('row697-roles');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.7)); // about 820 px of page in the test's 1400 px window
  await new Promise((go) => setTimeout(go, 400));
  await shot('row697-roles-820');
  const [over, wide] = await page.evaluate(() => [[...document.querySelectorAll('.sp-role')].filter((el) => el.scrollWidth > el.clientWidth + 1).length, innerWidth]);
  assert.ok(wide < 900, 'the zoom did not narrow the page: ' + wide);
  assert.equal(over, 0, 'a role row runs past its box at 820 px');
  console.log('PASS Instructions left by the side panel: saved after a chat click and after another project click, to the project typed in; a refused save on a chat leave and a project leave kept the exact text, showed it again on reopening and saved it to its own project only; Sprint Setup role rows: owns and mode saved to roles.json, Not set / empty remove the key, folder and rows kept, no row overflows at 820 px');
});

test('projects: a sprint page shows why its roles.json does not read, and follows the file when it changes', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Broken roles', work: { kind: 'new', parent: '', name: 'broken' } })).project;
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Roles prep' });
  const file = path.join(prep.folder, 'roles.json');
  const good = (keys) => JSON.stringify({ folder: 'broken', roles: keys.map((key) => ({ key, provider: 'claude', model: '', effort: '' })) });
  await writeFile(file, good(['lead']));
  const { page } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  const open = page.locator(`[data-pj="spopen"][data-lead="${prep.sprint}"]`), why = page.locator('[data-sp-roles-why]'), row = (k) => page.locator(`[data-role-row="${k}"]`);
  await open.waitFor({ timeout: 10000 }); // the project is read, with roles.json as it was then
  const parseError = (text) => page.evaluate((x) => { try { JSON.parse(x); return 'parsed'; } catch (error) { return error.message; } }, text);
  // Broken after the project was read, then the sprint opened from its button: the page reads it again and says why.
  const broken = '{ "roles": [ { "key": "lead",, } ] }';
  await writeFile(file, broken);
  await open.click();
  await until(async () => (await why.textContent().catch(() => '')) === await parseError(broken), async () => 'the parse error was not shown: ' + JSON.stringify([await why.textContent().catch(() => 'no hint'), await row('lead').count()]), 20000);
  assert.equal(await row('lead').count(), 0, 'no rows from a file that does not read');
  // Fixed on disk: the rows come back with no click.
  await writeFile(file, good(['lead', 'docs']));
  await until(async () => (await row('docs').count()) === 1 && (await why.count()) === 0, 'the fixed file\'s rows', 20000);
  // Broken while the page is open, then a valid file that is not a roles list: each says why.
  await writeFile(file, '{"roles": ');
  await until(async () => (await why.textContent().catch(() => '')) === await parseError('{"roles": '), async () => 'the cut-off file\'s error: ' + await why.textContent().catch(() => 'no hint'), 20000);
  await writeFile(file, '{"folder": "broken"}');
  await until(async () => (await why.textContent().catch(() => '')) === 'it has no "roles" list', async () => 'the no-list reason: ' + await why.textContent().catch(() => 'no hint'), 20000);
  await writeFile(file, good(['lead']));
  await until(async () => (await row('lead').count()) === 1 && (await row('docs').count()) === 0 && (await why.count()) === 0, 'the rows again', 20000);
  // FIX1: deleted, it says it is missing and stays listed as a file to make again; written back, the rows return.
  await rm(file);
  await until(async () => (await why.textContent().catch(() => '')) === 'it is missing', async () => 'the missing reason: ' + JSON.stringify([await why.textContent().catch(() => 'no hint'), await row('lead').count()]), 20000);
  assert.equal(await row('lead').count(), 0, 'no rows from a deleted file');
  assert.equal(await page.locator(`[data-sprint="${prep.sprint}"] [data-pj="spfile"]`, { hasText: /^roles\.json/ }).count(), 1, 'roles.json still listed while gone');
  await writeFile(file, good(['lead', 'docs']));
  await until(async () => (await row('docs').count()) === 1 && (await why.count()) === 0, 'the rows after the file was made again', 20000);
  if (!process.env.GITHUB_ACTIONS) { await writeFile(file, broken); await why.waitFor({ timeout: 20000 }); console.log('P9_SHOT o138-roles-error ' + (await page.screenshot({ type: 'png' })).toString('base64')); }
  console.log('PASS roles.json that does not read: opened from its button after a break, the parse error shown with no rows; fixed on disk, the rows back with no click; cut off while open and not a roles list, each reason shown; fixed again, the rows; deleted, it says missing and stays listed; written back, the rows');
});

// #235 review: the Roles rows load with sprint-view.mjs. With that chunk held while the owner types in a sprint file, the
// rows still come in when it lands, and the file box keeps its focus and its text.
test('projects: Sprint Setup roles come in when their late chunk lands, a focused file box kept as it was', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Held', work: { kind: 'new', parent: '', name: 'held' } })).project;
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Held prep' });
  await writeFile(path.join(prep.folder, 'roles.json'), JSON.stringify({ folder: 'held', roles: [{ key: 'lead', provider: 'claude', model: '', effort: '' }, { key: 'review', provider: 'codex', model: '', effort: '' }] }, null, 2));
  const { page, app } = await launch(t, instance);
  // The chunk is held until the test lets it go (the way sprint-copy-late.test.mjs holds its own); everything else loads.
  await app.evaluate(({ session }) => {
    globalThis.held = []; globalThis.release = () => { globalThis.held.splice(0).forEach((go) => go({})); };
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => { if (/\/sprint-view[.-]/.test(details.url)) globalThis.held.push(callback); else callback({}); });
  });
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await page.locator(`[data-pj="spopen"][data-lead="${prep.sprint}"]`).click();
  await page.locator('[data-sp-roles-wait]').waitFor({ timeout: 10000 });
  await page.locator(`[data-pj="spfile"][data-lead="${prep.sprint}"][data-name="sprint.md"]`).click();
  const box = page.locator(`[data-sp-box][data-lead="${prep.sprint}"]`);
  await box.waitFor({ timeout: 5000 });
  await box.press('End'); await box.pressSequentially(' typed while held');
  const typed = await box.inputValue();
  assert.ok(await app.evaluate(() => globalThis.held.length) >= 1, 'the chunk was requested and held');
  assert.equal(await page.locator('[data-sp-roles] [data-role-row]').count(), 0, 'no role rows before the chunk lands');
  await app.evaluate(() => globalThis.release());
  await until(async () => (await page.locator('[data-sp-roles] [data-role-row="lead"]').count()) === 1, async () => 'the role rows did not come in after the chunk landed: ' + JSON.stringify(await page.locator('[data-sprint]').innerText().catch(() => 'no section')));
  assert.equal(await page.locator('[data-sp-roles-wait]').count(), 0, 'the waiting heading is gone');
  assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-sp-box]') ?? false), true, 'the file box kept the focus');
  assert.equal(await box.inputValue(), typed, 'the file box kept the text typed while the chunk was held');
  console.log('PASS Sprint Setup late roles: with sprint-view.mjs held and sprint.md focused and typed in, the role rows came in when it landed; the box kept its focus and its text');
});

// O198: Show more on a project's Instructions stays open through the page's redraws (a chat in the project changing redraws
// the page, and that closed it again about every 30 s), until the user presses Show fewer lines or leaves the page.
test('O198 Show more on project instructions stays open through redraws until closed or left', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Long notes', work: { kind: 'p9' } })).project;
  assert.equal((await call(instance, '/projects/' + p.id, 'POST', { instructions: 'One.\nTwo.\nThree.\nFour.\nFive.' })).status, 200);
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', project: p.id })).conversation;
  await call(instance, '/chat/' + chat + '/prompt', 'POST', { text: 'title First title' }); await ended(instance, chat);
  const other = (await call(instance, '/projects', 'POST', { name: 'Other', work: { kind: 'p9' } })).project;
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Docs prep' }); assert.ok(prep.sprint, JSON.stringify(prep));
  const { page, errors } = await launch(t, instance);
  const rest = page.locator('#projPage [data-rest]'), more = page.locator('#projPage .instr-all');
  // The page's chat row shows the new title once the page has drawn again: that is the redraw.
  const redraw = async (title) => { await call(instance, '/chat/' + chat + '/prompt', 'POST', { text: 'title ' + title }); await ended(instance, chat);
    await page.locator('#projPage .crow', { hasText: title }).waitFor({ timeout: 10000 }); };
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await more.filter({ hasText: 'Show 2 more lines' }).click({ timeout: 10000 });
  await rest.waitFor({ state: 'visible', timeout: 3000 }); // opened
  await redraw('Second title');
  assert.equal(await rest.isVisible(), true, 'still open after the page drew again');
  assert.equal(await more.textContent(), 'Show fewer lines');
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  await more.click();
  assert.equal(await rest.isVisible(), false, 'Show fewer lines closes it');
  await redraw('Third title');
  assert.equal(await rest.isVisible(), false, 'and it stays closed through a redraw');
  assert.equal(await more.textContent(), 'Show 2 more lines');
  // Leaving the page (to the chat) and coming back shows it closed.
  await more.click(); assert.equal(await rest.isVisible(), true);
  await page.locator(`#projPage .crow[data-chat="${chat}"]`).click();
  await page.locator('#projPage').waitFor({ state: 'hidden', timeout: 10000 });
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await more.filter({ hasText: 'Show 2 more lines' }).waitFor({ timeout: 10000 });
  assert.equal(await rest.isVisible(), false, 'closed again after leaving the page');
  // The same through another project's page.
  await more.click(); assert.equal(await rest.isVisible(), true);
  await page.locator(`#navList [data-proj="${other.id}"]`).click({ timeout: 10000 });
  await page.locator('#pjName', { hasText: 'Other' }).waitFor({ timeout: 10000 });
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await more.filter({ hasText: 'Show 2 more lines' }).waitFor({ timeout: 10000 });
  assert.equal(await rest.isVisible(), false, 'closed again after another project was shown');
  // The same through the project's own Sprint Setup page and its Back.
  await more.click(); assert.equal(await rest.isVisible(), true);
  await page.locator(`[data-pj="spopen"][data-lead="${prep.sprint}"]`).click({ timeout: 10000 });
  await page.locator(`[data-sp-page="${prep.sprint}"]`).waitFor({ timeout: 10000 });
  await page.locator('[data-pj="spback"]').click();
  await more.waitFor({ timeout: 10000 });
  assert.equal(await more.textContent(), 'Show 2 more lines', 'closed again after the project\'s Sprint Setup page was shown');
  assert.equal(await rest.isVisible(), false);
  assert.deepEqual(errors, []);
});

// H2 part B: a Setup file changed outside P9's tools shows "Written by ... · not seen" on the sprint page; the owner's
// Seen press takes the mark away and P9 keeps it; written again, the mark comes back with no click.
test('projects: Sprint Setup marks a file written by someone else as not seen until the owner presses Seen', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const p = (await call(instance, '/projects', 'POST', { name: 'Marks', work: { kind: 'new', parent: '', name: 'marks' } })).project;
  const prep = await call(instance, '/projects/' + p.id + '/sprints', 'POST', { title: 'Marks prep' });
  await writeFile(path.join(prep.folder, 'rules.md'), 'OUTSIDE ONE\n');
  const unseen = async () => (await call(instance, '/projects/' + p.id)).project.sprints.find((x) => x.lead === prep.sprint).files.filter((f) => f.unseen).map((f) => f.name);
  const { page } = await launch(t, instance);
  await page.locator(`#navList [data-proj="${p.id}"]`).click();
  await page.locator(`[data-pj="spopen"][data-lead="${prep.sprint}"]`).click();
  const mark = page.locator(`[data-sprint="${prep.sprint}"] [data-sp-mark="rules.md"]`);
  await until(async () => (await mark.textContent().catch(() => '')).includes('rules.md: Written by someone outside P9\'s Setup tools · not seen'), async () => 'no mark: ' + await mark.textContent().catch(() => 'none'), 20000);
  assert.equal(await page.locator(`[data-sprint="${prep.sprint}"] [data-sp-mark]`).count(), 1, 'a file of New sprint was marked');
  await mark.locator('[data-sp-seen]').click();
  await until(async () => (await mark.count()) === 0, 'the Seen press left the mark', 10000);
  await until(async () => (await unseen()).length === 0, 'P9 did not keep the Seen press');
  await new Promise((r) => setTimeout(r, 6000)); // past the page's 5 s reread: the mark stays away
  assert.equal(await mark.count(), 0, 'the mark came back with no change to the file');
  await writeFile(path.join(prep.folder, 'rules.md'), 'OUTSIDE TWO\n');
  await until(async () => (await mark.count()) === 1, 'a later write did not mark it again', 20000);
  console.log('PASS H2 part B page: an outside write marked, the Seen press clears it and P9 keeps that, a later write marks it again');
});
