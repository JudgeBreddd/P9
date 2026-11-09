// N1 step 2 (points 9-11): New project with its three places for the work, the project page, MC-18, and a chat's Rename,
// Archive and Delete. Real Electron, the real daemon and the fake agent; the native folder dialog is stubbed in main.
// The dialog offers the chats already started in a picked folder (never ticked for you) and names a project already using
// it; the page edits name, about and instructions in place, adds and removes files, shows the folder's own AGENTS.md;
// delete leaves a folder the user chose alone and moves the chats to Chats; a gone folder shows Locate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';

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
  await menu(b); await page.locator('.lp-menu [data-pjchat=archive]').click();
  await page.locator(`#navList .row[data-chat="${b}"]`).waitFor({ state: 'detached', timeout: 5000 });
  assert.equal((await conv(instance, b)).archived, true);
  await page.locator('#navList [data-archived]').click();
  await page.locator(`#projPage [data-pj=unchat][data-id="${b}"]`).click();
  await page.locator(`#navList .row[data-chat="${b}"]`).waitFor({ timeout: 5000 });
  await menu(a); await page.locator('.lp-menu [data-pjchat=delete]').click();
  await ask.locator('h2', { hasText: 'Delete “Landing copy”?' }).waitFor({ timeout: 5000 });
  await ask.locator('[value=yes]').click();
  await until(async () => !(await conv(instance, a)), 'deleted on the daemon');
  await page.locator(`#navList .row[data-chat="${a}"]`).waitFor({ state: 'detached', timeout: 5000 });
  assert.deepEqual(errors, []);
});
