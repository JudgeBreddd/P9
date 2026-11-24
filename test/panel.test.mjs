// N1 step 2 (points 1-8): the left panel is the only chat switcher. Real Electron, the real daemon and the fake agent.
// A project's chats sit under it by the daemon's project id, never by folder; a running chat's Stop is on its row; a chat
// finished unseen stays on the strip until it is opened; collapse survives a restart; search finds a chat in a closed
// project; Move to project has Undo; Ctrl K opens a chat. (Replaces chat-close.test.mjs: the tab's x is gone.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
  assert.fail('timed out: ' + what);
};
const conv = async (instance, id) => (await call(instance, '/chat')).conversations.find((c) => c.id === id);
const ended = (instance, id, n = 1) => until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.filter((e) => e.type === 'turn-end').length >= n, id + ' answered');

async function launch(t, instance, profile) {
  profile ??= path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-panel-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  return { app, page, errors, profile };
}
// Where a chat's row is: the project id of the group it sits in, '' for Chats, null when it is not listed.
const zoneOf = (page, id) => page.evaluate((id) => document.querySelector(`#navList .row[data-chat="${id}"]`)?.closest('[data-zone]')?.dataset.zone ?? null, id);
const strip = (page) => page.evaluate(() => [...document.querySelectorAll('#rBots .bot')].map((b) => b.dataset.chat + ':' + b.dataset.s));

test('panel: project by id not folder, Stop on a running row, unseen stays on the strip, collapse kept, search opens closed projects, Move has Undo, Ctrl K', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  await mkdir(path.join(instance.workspace, 'site'), { recursive: true });
  const made = await call(instance, '/projects', 'POST', { name: 'Site', work: { kind: 'linked', folder: 'site' } });
  assert.equal(made.status, 201, JSON.stringify(made));
  const site = made.project.id, folder = made.project.work.folder;
  const create = async (body, text) => {
    const r = await call(instance, '/chat', 'POST', { provider: 'claude', ...body });
    assert.equal(r.status, 201, JSON.stringify(r));
    if (text) { await call(instance, '/chat/' + r.conversation + '/prompt', 'POST', { text }); await ended(instance, r.conversation); }
    return r.conversation;
  };
  const inSite = await create({ project: site }, 'title Landing copy');
  const general = await create({}, 'title Release notes');
  // In the project's folder but not in the project: it is listed under Chats (a folder never decides a project).
  const sameFolder = await create({ folder }, 'title Folder only');
  const later = await create({}, 'title Later');

  const one = await launch(t, instance);
  const { page } = one;
  await until(async () => (await zoneOf(page, inSite)) === site, 'the project chat under Site');
  assert.equal(await zoneOf(page, general), '');
  assert.equal(await zoneOf(page, sameFolder), '', 'a chat in the project folder without the project id is listed under Chats');

  // A running chat: its Stop is on its row (no tab x any more) and stops it on the daemon.
  await page.locator(`#navList .row[data-chat="${general}"]`).click();
  await page.locator(`#chats .pane[data-id="${general}"]`).waitFor({ timeout: 10000 });
  await call(instance, '/chat/' + general + '/prompt', 'POST', { text: 'slow' });
  const stop = page.locator(`#navList .rstop[data-stop="${general}"]`);
  await stop.waitFor({ timeout: 10000 });
  assert.ok(await page.locator(`#chats .pane[data-id="${general}"] .ptool [data-stop]`).isVisible(), 'the pane header has Stop too');
  await stop.click();
  await until(async () => (await conv(instance, general))?.state === 'stopped', 'the row Stop stopped the chat');
  await page.locator(`#navList .rstop[data-stop="${general}"]`).waitFor({ state: 'detached', timeout: 10000 });

  // A chat that finishes while not shown stays on the strip, unread, even once stopped; opening it takes it off.
  await call(instance, '/chat/' + later + '/prompt', 'POST', { text: 'again' });
  await ended(instance, later, 2);
  await call(instance, '/chat/' + later + '/stop', 'POST', {});
  await until(async () => (await conv(instance, later))?.state === 'stopped', 'later stopped');
  await page.keyboard.press('Control+b');
  await page.locator('#nav[data-collapsed]').waitFor({ timeout: 5000 });
  await until(async () => (await strip(page)).includes(later + ':unread'), 'the unseen chat on the strip (' + JSON.stringify(await strip(page)) + ')');
  await page.locator(`#rBots .bot[data-chat="${later}"]`).focus();
  await page.locator('.lp-tip', { hasText: 'Later' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Enter');
  await page.locator(`#chats .pane[data-id="${later}"]`).waitFor({ timeout: 10000 });
  await until(async () => !(await strip(page)).some((x) => x.startsWith(later + ':')), 'opened, it left the strip');
  // A chat whose agent fails while not shown: a cross on the strip, kept over the restart below until it is opened.
  await call(instance, '/chat/' + sameFolder + '/prompt', 'POST', { text: 'crash' });
  await until(async () => (await strip(page)).includes(sameFolder + ':failed'), 'the failed chat on the strip (' + JSON.stringify(await strip(page)) + ')');

  // Collapsed survives a restart (same profile); Ctrl B opens it again.
  await one.app.close();
  const two = await launch(t, instance, one.profile);
  assert.ok(await two.page.locator('#nav[data-collapsed]').count(), 'still collapsed after a restart');
  await until(async () => (await strip(two.page)).includes(sameFolder + ':failed'), 'still failed after a restart (' + JSON.stringify(await strip(two.page)) + ')');
  await two.page.locator('#chats').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await two.page.keyboard.press('Control+b');
  await two.page.locator('#nav:not([data-collapsed])').waitFor({ timeout: 5000 });

  // Search finds a chat in a closed project, and opens that project while it shows.
  const proj = two.page.locator(`#navList .row.proj[data-proj="${site}"]`);
  await until(async () => (await proj.count()) === 1, 'the Site row');
  if ((await proj.getAttribute('aria-expanded')) === 'true') await two.page.locator(`#navList [data-toggle="${site}"]`).click();
  await two.page.locator(`#navList .row[data-chat="${inSite}"]`).waitFor({ state: 'detached', timeout: 5000 });
  await two.page.fill('#navQ', 'landing');
  await two.page.locator(`#navList .row[data-chat="${inSite}"] mark`).waitFor({ timeout: 5000 });
  await two.page.fill('#navQ', '');

  // Move to project from the row menu, then Undo; the daemon agrees each time.
  await two.page.locator(`#navList .more[data-more="${general}"]`).click();
  await two.page.locator(`.lp-menu [data-moveto="${site}"]`).click();
  await until(async () => (await conv(instance, general))?.project === site, 'moved on the daemon');
  await until(async () => (await zoneOf(two.page, general)) === site, 'listed under Site');
  await two.page.locator('.lp-toast button', { hasText: 'Undo' }).click();
  await until(async () => (await conv(instance, general))?.project == null, 'Undo moved it back on the daemon');
  await until(async () => (await zoneOf(two.page, general)) === '', 'listed under Chats again');

  // Ctrl K: a chat by its title, with its project as the hint.
  await two.page.keyboard.press('Control+k');
  await two.page.fill('#palIn', 'landing');
  await two.page.locator('#palList li[data-i]', { hasText: 'Landing copy' }).locator('small', { hasText: 'Site' }).waitFor({ timeout: 5000 });
  await two.page.keyboard.press('Enter');
  await two.page.locator(`#chats .pane[data-id="${inSite}"] .crumb`, { hasText: 'Site' }).waitFor({ timeout: 10000 });

  assert.deepEqual([...one.errors, ...two.errors], []);
  console.log('PASS panel: project by id (folder-only chat under Chats), row Stop stopped a running chat, unseen chat kept on the strip until opened, collapse and a failed chat kept over a restart, search opened a closed project, Move + Undo agreed with the daemon, Ctrl K opened a project chat');
});

test('open chats keep their place and Stop follows the row during a reorder', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const make = async (name) => {
    const id = (await call(instance, '/chat', 'POST', { provider: 'claude', title: name })).conversation;
    await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' }); await ended(instance, id); return id;
  };
  const a = await make('Alpha'), b = await make('Beta'), c = await make('Gamma');
  for (const id of [a, b, c]) await call(instance, `/chat/${id}/stop`, 'POST', {});
  let { app, page, errors, profile } = await launch(t, instance);
  const rows = () => page.locator('#navList [data-zone=""] .row[data-chat]').evaluateAll((els) => els.map((el) => el.dataset.chat));
  const send = (id) => call(instance, `/chat/${id}/prompt`, 'POST', { text: 'slow' });
  await call(instance, `/chat/${a}/prompt`, 'POST', { text: 'background quiet' }); await ended(instance, a, 2);
  await until(async () => (await rows())[0] === a, 'idle Alpha stays open');
  await send(b); await until(async () => (await rows()).slice(0, 2).join() === [a, b].join(), 'Beta joins below Alpha');
  await send(c); await until(async () => (await rows()).slice(0, 3).join() === [a, b, c].join(), 'Gamma joins below Beta');
  await until(async () => (await call(instance, `/chat/events?after=0&only=${a}`)).events.some(e => e.type === 'update' && e.data.toolCallId === 'bg-1'), 'Alpha emits background activity');
  await page.waitForTimeout(1000);
  assert.deepEqual((await rows()).slice(0, 3), [a, b, c], 'new activity does not move Alpha');
  await app.close();
  ({ app, page, errors, profile } = await launch(t, instance, profile));
  await until(async () => (await rows()).slice(0, 3).join() === [a, b, c].join(), 'open order survives a window restart');
  await page.keyboard.press('Control+b');
  await until(async () => (await page.locator('#rBots .bot').evaluateAll((els) => els.map((el) => el.dataset.chat))).slice(0, 3).join() === [a, b, c].join(), 'strip keeps the same open order');
  await call(instance, `/chat/${a}/stop`, 'POST', {});
  await until(async () => (await conv(instance, a)).state === 'stopped' && (await page.locator('#rBots .bot').evaluateAll((els) => els.map((el) => el.dataset.chat))).slice(0, 2).join() === [b, c].join(), 'closed Alpha drops below the open chats');
  await send(a);
  await until(async () => (await page.locator('#rBots .bot').evaluateAll((els) => els.map((el) => el.dataset.chat))).slice(0, 3).join() === [b, c, a].join(), 'reopened Alpha joins the strip at the bottom');
  await page.keyboard.press('Control+b');
  await page.locator('#nav:not([data-collapsed])').waitFor({ timeout: 5000 });
  await call(instance, `/chat/${a}/stop`, 'POST', {});
  await until(async () => (await rows()).join() === [b, c, a].join(), 'closed Alpha drops below open chats');
  await send(a);
  await until(async () => (await rows()).join() === [b, c, a].join() && (await conv(instance, a)).state === 'turn', 'reopened Alpha joins the bottom');
  await page.locator(`#navList .row[data-chat="${c}"]`).click();
  await page.mouse.move(800, 600);
  assert.equal(await page.locator(`#navList .rstop[data-stop="${c}"]`).evaluate((el) => getComputedStyle(el).opacity), '1', 'selected chat shows Stop');
  const png = await page.screenshot({ type: 'png' });
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT sidebar-stable ' + png.toString('base64'));
  const stop = page.locator(`#navList .rstop[data-stop="${c}"]`);
  await stop.hover();
  const box = await stop.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // O247: Beta stops while Stop is pressed. The list keeps its order until the release, so the press stops Gamma, the chat
  // it was made on, at the first try, and never a row that moved under the pointer.
  await call(instance, `/chat/${b}/stop`, 'POST', {});
  await until(async () => (await conv(instance, b))?.state === 'stopped', 'Beta stopped');
  await page.waitForTimeout(500); // the event reaches the window (local socket)
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-stop]')?.dataset.stop, [box.x + box.width / 2, box.y + box.height / 2]), c, 'Gamma\'s Stop is still under the pointer');
  await page.mouse.up();
  await until(async () => (await conv(instance, c))?.state === 'stopped', 'the first press stops Gamma');
  assert.equal((await conv(instance, a)).state, 'turn', 'a pressed row never stops Alpha by accident');
  await until(async () => (await rows())[0] === a, 'the list re-sorts after the release: open Alpha first');
  assert.deepEqual(errors, []);
});

test('open project chats keep their place when activity arrives', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const project = (await call(instance, '/projects', 'POST', { name: 'Project', work: { kind: 'p9' } })).project.id;
  const make = async (title) => {
    const id = (await call(instance, '/chat', 'POST', { provider: 'claude', project, title })).conversation;
    await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' }); await ended(instance, id);
    await call(instance, `/chat/${id}/stop`, 'POST', {}); return id;
  };
  const a = await make('One'), b = await make('Two');
  const { page, errors } = await launch(t, instance);
  const rows = () => page.locator(`#navList [data-zone="${project}"] .row[data-chat]`).evaluateAll((els) => els.map(el => el.dataset.chat));
  await call(instance, `/chat/${a}/prompt`, 'POST', { text: 'hello' }); await ended(instance, a, 2);
  await call(instance, `/chat/${b}/prompt`, 'POST', { text: 'slow' });
  await until(async () => (await rows()).join() === [a, b].join(), 'idle project chat stays above newly opened chat');
  assert.deepEqual(errors, []);
});

// O247: a click on a sidebar row made while the list re-sorts still opens that chat. Before, a chat starting a turn moved to
// the top while the mouse was down: the rows under it were taken out and put back (or slid under the pointer), and the click
// went nowhere. Now the list waits for the press to end (press-hold.mjs), then re-sorts.
test('O247 a click on a sidebar row made while the list re-sorts still opens that chat', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const make = async (title) => {
    const id = (await call(instance, '/chat', 'POST', { provider: 'claude', title })).conversation;
    await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'hello' }); await ended(instance, id);
    await call(instance, `/chat/${id}/stop`, 'POST', {}); return id;
  };
  for (const name of ['One', 'Two', 'Three']) await make(name);
  const { page, errors } = await launch(t, instance);
  const rows = () => page.locator('#navList [data-zone=""] .row[data-chat]').evaluateAll((els) => els.map((el) => el.dataset.chat));
  const shown = () => page.evaluate(() => document.querySelector('#chats > .pane')?.dataset.id ?? null);
  await until(async () => (await rows()).length === 3, 'three rows');
  const [, pressed, last] = await rows();
  await page.locator(`#navList .row[data-chat="${last}"]`).click();
  await until(async () => (await shown()) === last, 'the last chat shown first');
  await page.evaluate(() => { const now = () => performance.now(); addEventListener('pointerdown', (e) => { window.__ids = { down: e.pointerId, downAt: now() }; }, true); addEventListener('click', (e) => { Object.assign(window.__ids, { click: e.pointerId, at: now() }); }, true); addEventListener('pointerup', (e) => { Object.assign(window.__ids, { upAt: now() }); }, true); addEventListener('pointercancel', (e) => { Object.assign(window.__ids, { cancel: e.pointerId, cancelAt: now() }); }, true); window.__watch = (sel, attr, value) => { delete window.__ids.seen; const mo = new MutationObserver(() => { if (document.querySelector(sel)?.getAttribute(attr) === value) { window.__ids.seen = now(); mo.disconnect(); } }); mo.observe(document.body, { subtree: true, childList: true, attributes: true }); }; });
  const box = await page.locator(`#navList .row[data-chat="${pressed}"]`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // The bottom chat starts a turn: it goes to the top, and the pressed row (second) would move down one.
  await call(instance, `/chat/${last}/prompt`, 'POST', { text: 'slow' });
  // The window has the update when the shown chat draws the prompt; the list holds its order while the button is down.
  await until(async () => page.locator('#chats > .pane').evaluate((el) => el.textContent.includes('slow')), 'the window got the turn');
  await page.waitForTimeout(300);
  assert.notEqual((await rows())[0], last, 'the list waits while the row is pressed');
  const top = '#navList [data-zone=""] .row[data-chat]';
  await page.evaluate(([sel, id]) => window.__watch(sel, 'data-chat', id), [top, last]);
  await page.mouse.up();
  await until(async () => (await shown()) === pressed, 'the pressed chat opened, not ' + await shown());
  await until(async () => (await rows())[0] === last, 'the list re-sorts once the press ends');
  // The click ended the hold, not the 500 ms fallback after the release: the list re-sorted right after the click.
  let ids = await page.evaluate(() => window.__ids);
  assert.equal(ids.click, ids.down, 'the click carries its press\'s pointer id');
  assert.ok(ids.seen >= ids.at && ids.seen - ids.upAt < 500, 're-sorted ' + Math.round(ids.seen - ids.upAt) + ' ms after the release, after its click and before the fallback');

  // More, pressed while the list re-sorts: its menu opens, the redraw after keeps it drawn expanded, and a second click closes it.
  const more = page.locator(`#navList [data-more="${pressed}"]`);
  await page.locator(`#navList .row[data-chat="${pressed}"]`).hover(); // More shows on the row's hover
  const mb = await more.boundingBox();
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  const row = `#navList .row[data-chat="${pressed}"]`, state = () => page.locator(row).getAttribute('data-s');
  await page.evaluate((sel) => window.__watch(sel, 'data-s', 'running'), row);
  await call(instance, `/chat/${pressed}/prompt`, 'POST', { text: 'slow too' }); // its row turns to Running (and moves up)
  await until(async () => page.locator('#chats > .pane').evaluate((el) => el.textContent.includes('slow too')), 'the window got the second turn');
  await page.waitForTimeout(300);
  assert.notEqual(await state(), 'running', 'the list waits while More is pressed');
  await page.mouse.up();
  await page.locator('.lp-menu').waitFor({ timeout: 5000 });
  await until(async () => (await state()) === 'running', 'the list redraws after the More click');
  ids = await page.evaluate(() => window.__ids);
  assert.ok(ids.seen >= ids.at && ids.seen - ids.upAt < 500, 'More: redrawn after its click and before the fallback');
  assert.equal(await more.getAttribute('aria-expanded'), 'true', 'the redraw keeps More drawn expanded while its menu is open');
  await more.click();
  await until(async () => (await page.locator('.lp-menu').count()) === 0, 'a second click on More closes its menu');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(errors, []);
  console.log('PASS O247: a press held while the sidebar re-sorted still opened the pressed chat; the list re-sorted after');
});
