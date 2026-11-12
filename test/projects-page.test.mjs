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

// Nightly 3 (Builder, 2026-11-09): "new prject gets cut off". A long linked path must not widen the New project dialog:
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
  await page.locator('#cards .card').first().waitFor({ timeout: 15000 });
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
