// N1 step 2 (points 1, 2, 5, 6, 7), the parts panel.test.mjs does not cover: the line of help with no project, Show more,
// Ctrl Tab to the chat shown before, Split on the last two chats shown, a drag onto a project (with Undo), the width kept
// over a restart, the fold to the strip under 1000 px, and each agent's icon from its one module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { agentIcon } from '../apps/web/src/agent-icons.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ status: r.status, ...JSON.parse(r.text) }));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const conv = async (instance, id) => (await call(instance, '/chat')).conversations.find((c) => c.id === id);
const ended = (instance, id) => until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.some((e) => e.type === 'turn-end'), id + ' answered');

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
const zoneOf = (page, id) => page.evaluate((id) => document.querySelector(`#navList .row[data-chat="${id}"]`)?.closest('[data-zone]')?.dataset.zone ?? null, id);
const panes = (page) => page.evaluate(() => [...document.querySelectorAll('#chats .pane')].map((p) => p.dataset.id));
const centre = async (locator) => { const b = await locator.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

test('panel: help with no project, Show more, Ctrl Tab, Split, drag with Undo, width kept, narrow fold, agent icons', { timeout: 240000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));

  // No project yet: one line of help in place of the list.
  const one = await launch(t, instance);
  await one.page.locator('#navList .pempty', { hasText: 'Projects keep chats, instructions and files together.' }).waitFor({ timeout: 10000 });
  await one.app.close();

  await mkdir(path.join(instance.workspace, 'big'), { recursive: true });
  const made = await call(instance, '/projects', 'POST', { name: 'Big', work: { kind: 'linked', folder: 'big' } });
  assert.equal(made.status, 201, JSON.stringify(made));
  const big = made.project.id;
  const create = async (body, text) => {
    const r = await call(instance, '/chat', 'POST', { provider: 'claude', ...body });
    assert.equal(r.status, 201, JSON.stringify(r));
    await call(instance, '/chat/' + r.conversation + '/prompt', 'POST', { text }); await ended(instance, r.conversation);
    return r.conversation;
  };
  for (let i = 1; i <= 7; i++) await create({ project: big }, 'title Big chat ' + i);
  const first = await create({}, 'title First chat'), second = await create({}, 'title Second chat');

  const two = await launch(t, instance, one.profile);
  const { page } = two;
  const kids = () => page.locator(`#navList [data-zone="${big}"] .row[data-chat]`).count();

  // Show more: five chats under a project, then the rest.
  await until(async () => (await kids()) === 5, 'five chats under Big');
  await page.locator(`#navList [data-showmore="${big}"]`, { hasText: 'Show 2 more' }).click();
  await until(async () => (await kids()) === 7, 'seven after Show more');
  await page.locator(`#navList [data-showmore="${big}"]`, { hasText: 'Show fewer' }).waitFor({ timeout: 5000 });

  // Ctrl Tab flips to the chat shown before; Split shows the last two shown.
  await page.locator(`#navList .row[data-chat="${first}"]`).click();
  await page.locator(`#chats .pane[data-id="${first}"]`).waitFor({ timeout: 10000 });
  await page.locator(`#navList .row[data-chat="${second}"]`).click();
  await page.locator(`#chats .pane[data-id="${second}"]`).waitFor({ timeout: 10000 });
  await page.locator('#chats .hist').first().click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Tab');
  await until(async () => (await panes(page)).join() === first, 'Ctrl Tab showed the first chat (' + (await panes(page)) + ')');
  await page.keyboard.press('Control+Tab');
  await until(async () => (await panes(page)).join() === second, 'Ctrl Tab back to the second chat');
  await page.locator(`#chats .pane[data-id="${second}"] [data-tool="split"]`).click();
  await until(async () => (await panes(page)).sort().join() === [first, second].sort().join(), 'Split shows the last two chats (' + (await panes(page)) + ')');
  await page.locator(`#chats .pane[data-id="${second}"] [data-tool="split"]`).click();
  await until(async () => (await panes(page)).length === 1, 'Split off');

  // Drag the first chat onto Big: it moves on the daemon; Undo puts it back.
  const [x0, y0] = await centre(page.locator(`#navList .row[data-chat="${first}"]`));
  const [x1, y1] = await centre(page.locator(`#navList .row.proj[data-proj="${big}"]`));
  await page.mouse.move(x0, y0); await page.mouse.down();
  await page.mouse.move(x0 + 10, y0 - 10, { steps: 3 }); await page.mouse.move(x1, y1, { steps: 8 });
  await page.locator('.lp-ghost .to', { hasText: 'Move to Big' }).waitFor({ timeout: 5000 });
  await page.mouse.up();
  await until(async () => (await conv(instance, first))?.project === big, 'the drag moved it on the daemon');
  await page.locator('.lp-toast button', { hasText: 'Undo' }).click();
  await until(async () => (await conv(instance, first))?.project == null, 'Undo moved it back');
  await until(async () => (await zoneOf(page, first)) === '', 'listed under Chats again');

  // Width: the grip's End key makes it widest; a restart keeps it.
  await page.locator('#nav .p-grip').focus();
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.querySelector('#nav').style.getPropertyValue('--pw')), '420px');
  await two.app.close();
  // A chat waiting on an approval says so in its header (Needs you, not Running).
  const asks = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + asks + '/prompt', 'POST', { text: 'permission' });
  await until(async () => (await call(instance, '/chat/events?after=0&only=' + asks)).events.some((e) => e.type === 'approval'), 'the chat asks for approval');
  const three = await launch(t, instance, one.profile);
  await three.page.locator(`#navList .row[data-chat="${asks}"]`).click();
  await three.page.locator(`#chats .pane[data-id="${asks}"] .ptool .state[data-s="needs"]`, { hasText: 'Needs you' }).waitFor({ timeout: 10000 });
  // Row marks by shape: a hand for the waiting chat, a ring for a running one; hovering a row shows its time beside Stop and ⋯.
  await three.page.locator(`#navList .row[data-chat="${asks}"] .mk-needs svg`).waitFor({ state: 'attached', timeout: 5000 }); // shown, it is in the time's place; the clicked row has focus, so the time shows
  const row = three.page.locator(`#navList .row[data-chat="${second}"]`);
  await row.locator('.mk-run').waitFor({ state: 'attached', timeout: 5000 });
  await row.hover();
  assert.ok(await row.locator('.when').isVisible(), 'the time shows on hover');
  const [when, stopAt] = [await row.locator('.when').boundingBox(), await three.page.locator(`#navList .rstop[data-stop="${second}"]`).boundingBox()];
  assert.ok(when.x + when.width <= stopAt.x, 'the time sits left of Stop, not under it');
  assert.equal(await three.page.evaluate(() => document.querySelector('#nav').style.getPropertyValue('--pw')), '420px', 'the width after a restart');

  // Under 1000 px it folds to the strip by itself, and opens again when the window is wide.
  await three.page.setViewportSize({ width: 960, height: 760 });
  await three.page.locator('#nav[data-collapsed]').waitFor({ timeout: 5000 });
  // On the strip, each chat's head is the agent's icon from agent-icons.mjs (the one place it is drawn).
  const same = await three.page.evaluate(([id, icon]) => {
    const b = document.querySelector(`#rBots .bot[data-chat="${id}"] > svg`), d = document.createElement('div'); d.innerHTML = icon;
    return !!b && b.outerHTML === d.firstElementChild.outerHTML;
  }, [second, agentIcon('claude')]);
  assert.ok(same, 'the strip head is agentIcon("claude")');
  await three.page.setViewportSize({ width: 1400, height: 900 });
  await three.page.locator('#nav:not([data-collapsed])').waitFor({ timeout: 5000 });

  assert.deepEqual([...one.errors, ...two.errors, ...three.errors], []);
  console.log('PASS panel-more: help line with no project, Show more 5 then 7, Ctrl Tab both ways, Split on the last two, drag onto a project and Undo agreed with the daemon, width kept over a restart, Needs you in the header, row marks and the time on hover, fold under 1000 px, strip head from agent-icons');
});
