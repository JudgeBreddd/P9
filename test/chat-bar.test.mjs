// The chat bar's Mode, Model and Effort pills and Settings' default model and effort (0.1.8). Real Electron, the real daemon
// and the fake agent, as composer.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, restart, http, authenticated, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...JSON.parse(result.text) }));
const events = async (instance, id) => {
  const all = [];
  for (let after = 0, page; (page = await call(instance, '/chat/events?after=' + after + '&only=' + id)).events.length; after = page.cursor) all.push(...page.events);
  return all;
};
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
// The pills (chat-view.mjs pillMenu): a pill's value is in its aria-label; its menu is #pillMenu (no submenus, Builder, 2026-11-05).
const pillOf = (pane, kind) => pane.locator(`[data-pill="${kind}"]`);
const pillValue = async (pane, kind) => (await pillOf(pane, kind).getAttribute('aria-label')).replace(kind + ': ', '');
const menuItem = (page, label) => page.locator('#pillMenu .item').filter({ has: page.locator(`.truncate:text-is("${label}")`) });
const listed = (page, where = '#pillMenu') => page.locator(where + ' .item').evaluateAll((l) => l.map((b) => b.firstElementChild.textContent + (b.getAttribute('aria-checked') === 'true' ? ' ✓' : '')));
const pillItems = async (page, pane, kind) => { await pillOf(pane, kind).click(); await page.locator('#pillMenu:not([hidden])').waitFor(); const items = await listed(page); await page.keyboard.press('Escape'); return items; };
const choose = async (page, pane, kind, ...labels) => { await pillOf(pane, kind).click(); for (const label of labels) await menuItem(page, label).click(); };
// The focused element: a pill by its aria-label, a menu item by its text.
const focused = (page) => page.evaluate(() => { const a = document.activeElement; return a?.hasAttribute('data-pill') ? a.getAttribute('aria-label') : a?.firstElementChild?.textContent ?? a?.tagName; });
const menuState = async (page) => [await page.evaluate(() => document.querySelector('#pillMenu').hidden), await focused(page)];
// The bar with a menu open: a file under P9_EVIDENCE, else (the dev space keeps no files) a "P9_SHOT <name> <base64>" log line; none in CI.
const shot = async (page, name) => { await page.evaluate(() => Promise.all(document.getElementById('pillMenu').getAnimations({ subtree: true }).map((x) => x.finished))); const png = await page.screenshot({ type: 'png' }); if (process.env.P9_EVIDENCE) fs.writeFileSync(path.join(process.env.P9_EVIDENCE, name + '.png'), png); else if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const heading = (page) => page.locator('#pillMenu .hd').first().evaluate((h) => h.textContent); // textContent: the eyebrow style may upper-case it

async function launch(t, instance, profile) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.locator('#rChat').waitFor();
  return { app, page, errors };
}
// One chat with the given agent, answered "hello" once (so its config is known), and a window on it.
async function setup(t, name, provider = 'claude') {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-' + name + '-')), 'profile');
  const id = (await call(instance, '/chat', 'POST', { provider })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'hello' });
  await until(async () => (await events(instance, id)).some((e) => e.type === 'turn-end'), 'hello answered');
  const { app, page, errors } = await launch(t, instance, profile);
  await page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  const pane = page.locator('.pane[data-id="' + id + '"]');
  const idle = () => page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  const send = async (text) => { await pane.locator('.composer textarea').click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
  const said = (text) => pane.locator('.hist', { hasText: text }).waitFor({ timeout: 15000 });
  return { app, instance, id, page, pane, send, said, idle, errors };
}

test('pills: Mode, Model and Effort are menus in the message bar; keyboard and roles; an open menu survives streaming; a mode picked mid-turn queues; the narrowest pane keeps one line', { timeout: 180000 }, async (t) => {
  const { app, instance, id, pane, page, send, said, idle, errors } = await setup(t, 'pills');
  // The toolbar's selects are gone; the bar has one pill each in place of the hint text.
  await pane.locator('[data-pill="Model"][aria-label="Model: Default (recommended)"]').waitFor({ timeout: 10000 });
  assert.equal(await pane.locator('select').count(), 0, 'no selects left in the pane');
  assert.equal(await pane.locator('.composer .bar .hint').count(), 0, 'the hint text is gone while idle');
  assert.deepEqual(await pane.locator('.composer .bar .pills [data-pill]').evaluateAll((l) => l.map((b) => [b.tagName, b.getAttribute('aria-haspopup'), b.getAttribute('aria-label')])),
    [['BUTTON', 'menu', 'Agent: Claude'], ['BUTTON', 'menu', 'Mode: Auto'], ['BUTTON', 'menu', 'Model: Default (recommended)'], ['BUTTON', 'menu', 'Effort: Medium (Default)']]); // MC-16: the closed pill names the default
  // Keyboard: Enter on a pill opens its menu (role=menu, menuitemradio items, the current one checked and focused); arrows move;
  // Enter picks and puts focus back on the pill; Escape closes and does the same.
  await pillOf(pane, 'Mode').focus(); await page.keyboard.press('Enter');
  const menu = page.locator('#pillMenu');
  await menu.waitFor();
  assert.deepEqual(await menu.evaluate((m) => [m.getAttribute('role'), [...m.querySelectorAll('.item')].map((b) => b.getAttribute('role') + ':' + b.firstElementChild.textContent + ':' + b.getAttribute('aria-checked'))]),
    ['menu', ['menuitemradio:Manual:false', 'menuitemradio:Auto:true', 'menuitemradio:Accept edits:false', 'menuitemradio:Plan:false', 'menuitemradio:Bypass permissions:false']]);
  assert.equal(await focused(page), 'Auto', 'the current choice has the focus');
  await shot(page, 'menu-mode');
  await page.keyboard.press('ArrowDown'); assert.equal(await focused(page), 'Accept edits');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); assert.equal(await focused(page), 'Manual');
  await page.keyboard.press('Enter');
  await pane.locator('[data-pill="Mode"][aria-label="Mode: Manual"]').waitFor();
  assert.deepEqual(await menuState(page), [true, 'Mode: Manual'], 'picked: the menu closed and the pill has the focus');
  await page.keyboard.press('Enter'); await menu.waitFor(); await page.keyboard.press('Escape');
  assert.deepEqual(await menuState(page), [true, 'Mode: Manual'], 'Escape: closed, focus back on the pill');
  assert.equal(await pillOf(pane, 'Mode').getAttribute('aria-expanded'), 'false');
  await send('mode'); await said('mode:default'); await idle();
  // The Model menu: the agent's name as heading, its models listed directly (Builder, 2026-11-05: no "More" submenu), then Fast
  // mode's choices under their own heading.
  await pillOf(pane, 'Model').click(); await menu.waitFor();
  assert.equal(await heading(page), 'Claude');
  assert.deepEqual(await listed(page), ['Default (recommended) ✓', 'Opus', 'Haiku', 'On', 'Off ✓']);
  assert.deepEqual(await page.locator('#pillMenu .hd').evaluateAll((l) => l.map((h) => h.textContent)), ['Claude', 'Fast mode']);
  assert.equal(await page.locator('#pillMenu [aria-haspopup], #pillSub').count(), 0, 'no submenu');
  await shot(page, 'menu-model');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); assert.equal(await focused(page), 'Haiku');
  await page.keyboard.press('Enter');
  await pane.locator('[data-pill="Model"][aria-label="Model: Haiku"]').waitFor();
  assert.deepEqual(await menuState(page), [true, 'Model: Haiku']);
  await send('model'); await said('model:haiku'); await idle();
  // Review minor (2026-11-05): an open menu follows its chat. With the Model menu open, a prompt from elsewhere (the phone,
  // with its own model pick) changes the model: the check moves to Opus while the menu stays open with its focus.
  await pillOf(pane, 'Model').click(); await menu.waitFor();
  assert.deepEqual(await listed(page), ['Default (recommended)', 'Opus', 'Haiku ✓', 'On', 'Off ✓']);
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'model', model: 'opus' });
  await until(async () => (await listed(page)).includes('Opus ✓'), 'the open menu checks the model now in use', 10000);
  assert.deepEqual(await menuState(page), [false, 'Haiku'], 'still open, the focus kept');
  await page.keyboard.press('Escape'); await said('model:opus'); await idle();
  // Review minor (2026-11-05): the menu's window listeners (click outside, resize) exist only while it is open; DevTools counts them.
  const cdp = await page.context().newCDPSession(page);
  const winListeners = async () => { const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' }); const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId }); return listeners.filter((l) => l.type === 'click' || l.type === 'resize').length; };
  const base = await winListeners();
  await pillOf(pane, 'Effort').click(); await menu.waitFor();
  assert.equal(await winListeners(), base + 2, 'open: a click and a resize listener on the window');
  await page.keyboard.press('Escape');
  assert.equal(await winListeners(), base, 'closed: both removed');
  await pillOf(pane, 'Effort').click(); await menu.waitFor(); await pane.locator('.hist').click({ position: { x: 10, y: 10 } });
  assert.deepEqual([await menu.isHidden(), await winListeners()], [true, base], 'a click outside closes it and removes them too');
  // While the agent works the Steer / Queue / Cancel chip shows beside the pills, which stay.
  await send('long work');
  await pane.locator('.bar [data-when="steer"]').waitFor({ timeout: 10000 });
  assert.equal(await pane.locator('.bar [data-pill]').count(), 4);
  // An open menu stays open, with its focus, while the chat streams (a tool step every 300 ms re-renders the pane).
  await pillOf(pane, 'Effort').click(); await menu.waitFor();
  const steps = () => pane.locator('.hist details[data-ev]').count();
  const before = await steps();
  await page.waitForTimeout(1500);
  assert.ok(await steps() > before, 'the chat streamed meanwhile: ' + before + ' -> ' + await steps());
  await shot(page, 'menu-effort-streaming');
  assert.deepEqual(await menuState(page), [false, 'Medium (Default)'], 'the menu is open and focused through the streaming');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await pane.locator('[data-pill="Effort"][aria-label="Effort: High"]').waitFor();
  // A mode picked mid-turn shows at once, labelled queued; it applies when the turn ends.
  await choose(page, pane, 'Mode', 'Plan');
  await pane.locator('[data-pill="Mode"][aria-label="Mode: Plan"] .mode-q').waitFor();
  await pane.locator('.bar [data-cancel]').click();
  await said('Mode is now Plan.');
  await until(async () => (await pane.locator('[data-pill="Mode"] .mode-q').count()) === 0, 'queued label gone', 5000);
  assert.equal(await pillValue(pane, 'Mode'), 'Plan');
  await idle();
  await send('mode'); await said('mode:plan'); await idle();
  // The narrowest pane P9 allows (the split bar's 280 px) in a small window: the row stays one line, the send arrow in view, nothing overflows.
  const second = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await page.locator('#nav .row[data-chat="' + second + '"]').waitFor({ timeout: 10000 });
  // Under 721 px the split folds to one pane (shell.css), so 760 is the smallest window with two; the split bar's floor is 280 px.
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(760, 600); });
  await page.waitForFunction(() => innerWidth <= 800, null, { timeout: 5000 });
  await page.locator('#chats > .pane').first().locator('[data-tool=split]').click({ timeout: 5000 }); // Split is in the pane header now
  await page.locator('#chats[data-split="true"] .pane').nth(1).waitFor({ timeout: 10000 });
  await page.evaluate(() => document.querySelector('#chats').style.setProperty('--split-l', '280px'));
  await page.waitForTimeout(400);
  const fit = await page.locator('#chats .pane').evaluateAll((l) => l.map((p) => {
    const bar = p.querySelector('.composer .bar'), send = p.querySelector('.composer .send'), pr = p.getBoundingClientRect(), sr = send.getBoundingClientRect(), pills = [...bar.querySelectorAll('[data-pill]')];
    const mid = (r) => r.top + r.height / 2;
    return { width: Math.round(pr.width), oneLine: pills.every((b) => Math.abs(mid(b.getBoundingClientRect()) - mid(sr)) < 8), noOverflow: bar.scrollWidth <= bar.clientWidth + 1 && bar.scrollHeight <= bar.clientHeight + 1,
      sendIn: sr.width > 0 && sr.left >= pr.left && sr.right <= pr.right + 1, pillsShow: pills.every((b) => b.getBoundingClientRect().width >= 24) };
  }));
  assert.ok(fit.some((f) => f.width <= 300), 'one pane is at the narrowest: ' + JSON.stringify(fit));
  for (const f of fit) assert.deepEqual([f.oneLine, f.noOverflow, f.sendIn, f.pillsShow], [true, true, true, true], JSON.stringify(fit));
  await shot(page, 'pills-narrow');
  assert.deepEqual(errors, []);
  console.log('PASS pills: four menu pills in the bar, keyboard and roles as specified, open through streaming, queued mid-turn, one line at 280 px');
});

test('Codex: Plan in the Mode menu is the plan collaboration mode, on top of the sandbox mode picked before; any other mode turns it off; the separate picker is gone', { timeout: 150000 }, async (t) => {
  const { pane, page, send, said, idle, errors } = await setup(t, 'codex-plan', 'codex');
  await pane.locator('[data-pill="Mode"][aria-label="Mode: Auto review"]').waitFor({ timeout: 10000 });
  await pane.locator('[data-pill="Effort"][aria-label="Effort: Medium (Default)"]').waitFor({ timeout: 10000 }); // the config arrived
  assert.equal(await pane.locator('select').count(), 0, 'no selects: the separate plan picker is gone');
  assert.deepEqual(await pillItems(page, pane, 'Mode'), ['Read-only', 'Workspace access', 'Auto review ✓', 'Full access', 'Plan']);
  await choose(page, pane, 'Mode', 'Plan');
  await pane.locator('[data-pill="Mode"][aria-label="Mode: Plan"]').waitFor();
  await send('config'); await said('config:model=default,effort=medium,fast=off,collaboration_mode=plan,sandbox=on'); await idle();
  await send('mode'); await said('mode:agent'); await idle(); // the sandbox mode picked before (Auto review) stays
  assert.equal(await pillValue(pane, 'Mode'), 'Plan', 'plan stays on across turns');
  assert.deepEqual(await pillItems(page, pane, 'Mode'), ['Read-only', 'Workspace access', 'Auto review', 'Full access', 'Plan ✓']);
  await choose(page, pane, 'Mode', 'Read-only');
  await pane.locator('[data-pill="Mode"][aria-label="Mode: Read-only"]').waitFor();
  await send('config'); await said('collaboration_mode=default'); await idle();
  await send('mode'); await said('mode:read-only'); await idle();
  // The Model menu is Codex's own list under its name.
  await pillOf(pane, 'Model').click(); assert.equal(await heading(page), 'Codex'); await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('PASS Codex Plan: plan collaboration mode on with the sandbox kept, off again with Read-only, no separate picker');
});

test('Settings > New chats start in: Default model and Default effort per agent, from the lists P9 last saw; a new chat starts with them; a pick in a chat leaves them; they survive a restart', { timeout: 180000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-defaults-')), 'profile');
  let { app, page } = await launch(t, instance, profile);
  const settings = async () => { await page.click('#setBtn'); await page.locator('#setDlg[open]').waitFor(); await page.click('[data-set-page="Chat Focus"]'); };
  const closeSettings = async () => { await page.keyboard.press('Escape'); await page.locator('#setDlg').waitFor({ state: 'hidden', timeout: 5000 }); };
  const options = (sel) => page.locator(sel + ' option').allInnerTexts();
  await settings();
  // O47: the daemon read each agent's lists at its start, so they are here before any chat, for both agents; the first
  // option names the agent's own default (MC-16) unless that option's name already says it.
  const full = [["Agent's default", 'Default (recommended)', 'Opus', 'Haiku'], ["Agent's default (Medium)", 'Low', 'Medium', 'High'], ["Agent's default", 'Default (recommended)', 'Opus', 'Haiku']];
  for (const a of ['claude', 'codex']) await page.locator(`[data-default-model="${a}"] option`).nth(1).waitFor({ state: 'attached', timeout: 15000 }); // filled in with Settings already open
  assert.deepEqual([await options('[data-default-model="claude"]'), await options('[data-default-effort="claude"]'), await options('[data-default-model="codex"]')], full, 'the lists before any chat');
  assert.doesNotMatch(await page.locator('.set-defaults', { hasText: 'Claude' }).innerText(), /Start one Claude chat first/);
  await closeSettings();
  // One Claude chat: its own report leaves the lists as they are.
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + first + '/prompt', 'POST', { text: 'hello' });
  await page.locator('#nav .row[data-chat="' + first + '"]').click();
  await page.locator('.pane[data-id="' + first + '"] [data-pill="Model"][aria-label="Model: Default (recommended)"]').waitFor({ timeout: 15000 });
  await settings();
  assert.deepEqual([await options('[data-default-model="claude"]'), await options('[data-default-effort="claude"]'), await options('[data-default-model="codex"]')],
    full);
  await page.selectOption('[data-default-model="claude"]', 'haiku'); await page.selectOption('[data-default-effort="claude"]', 'high');
  await closeSettings();
  // A new chat from the New button starts with them before any message, and its first prompt carries them.
  const fresh = async () => {
    const had = await page.locator('#navList .row[data-chat]').evaluateAll((l) => l.map((x) => x.dataset.chat));
    await page.click('#newBtn'); await page.locator('#newPop [data-new="claude"]').first().click();
    await page.waitForFunction((had) => [...document.querySelectorAll('#navList .row[data-chat]')].some((x) => !had.includes(x.dataset.chat)), had, { timeout: 15000 });
    const id = await page.locator('#navList .row[data-chat]').evaluateAll((l, had) => l.map((x) => x.dataset.chat).find((x) => !had.includes(x)), had);
    await page.locator('#nav .row[data-chat="' + id + '"]').click();
    const pane = page.locator('#chats .pane[data-id="' + id + '"]');
    await pane.locator('[data-pill="Model"]').waitFor();
    return pane;
  };
  let pane = await fresh();
  await pane.locator('[data-pill="Model"][aria-label="Model: Haiku"]').waitFor({ timeout: 5000 });
  assert.equal(await pillValue(pane, 'Effort'), 'High');
  await pane.locator('.composer textarea').fill('config'); await pane.locator('.composer textarea').press('Enter');
  await pane.locator('.hist', { hasText: 'config:model=haiku,effort=high,fast=off,sandbox=on' }).waitFor({ timeout: 20000 });
  // A pick inside the chat changes only that chat.
  await choose(page, pane, 'Effort', 'Low');
  await pane.locator('[data-pill="Effort"][aria-label="Effort: Low"]').waitFor();
  assert.deepEqual(await page.evaluate(() => [localStorage.getItem('p9-model-default:claude'), localStorage.getItem('p9-effort-default:claude')]), ['haiku', 'high']);
  // A chat made elsewhere (the phone, a card) keeps the agent's own: only chats started here get the defaults.
  const other = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  await call(instance, '/chat/' + other + '/prompt', 'POST', { text: 'hello' });
  await until(async () => (await events(instance, other)).some((e) => e.type === 'turn-end'), 'the other chat answered');
  await page.locator('#nav .row[data-chat="' + other + '"]').click();
  const otherPane = page.locator('.pane[data-id="' + other + '"]');
  await otherPane.locator('[data-pill="Model"][aria-label="Model: Default (recommended)"]').waitFor({ timeout: 10000 });
  assert.equal(await pillValue(otherPane, 'Effort'), 'Medium (Default)');
  await otherPane.locator('.composer textarea').fill('config'); await otherPane.locator('.composer textarea').press('Enter');
  await otherPane.locator('.hist', { hasText: 'config:model=default,effort=medium,fast=off,sandbox=on' }).waitFor({ timeout: 20000 });
  // After a restart: Settings still lists and shows them, and a new chat starts with them.
  await app.close(); ({ app, page } = await launch(t, instance, profile));
  await settings();
  assert.deepEqual([await page.locator('[data-default-model="claude"]').inputValue(), await page.locator('[data-default-effort="claude"]').inputValue(), await options('[data-default-model="claude"]')],
    ['haiku', 'high', ["Agent's default", 'Default (recommended)', 'Opus', 'Haiku']]);
  await closeSettings();
  pane = await fresh();
  await pane.locator('[data-pill="Model"][aria-label="Model: Haiku"]').waitFor({ timeout: 5000 });
  assert.equal(await pillValue(pane, 'Effort'), 'High');
  console.log('PASS defaults: Default model and effort offered from the lists seen, applied to new chats here only, kept across a restart');
});

// O32: a chat on Opus, High and Plan is still on them after the daemon restarts and the app restarts (an update does both):
// the pills show the chat's own, and the next message runs on them. Since then another chat was last put in Manual, so a
// new chat would start in Manual: this one does not.
test('a resumed chat keeps its model, effort and mode after a daemon restart and an app restart, and the pills show them', { timeout: 180000 }, async (t) => {
  const { app, instance, id, pane, page, send, said, idle, errors } = await setup(t, 'resume');
  const profile = await app.evaluate(({ app }) => app.getPath('userData'));
  await choose(page, pane, 'Model', 'Opus'); await choose(page, pane, 'Effort', 'High'); await choose(page, pane, 'Mode', 'Plan');
  await send('config'); await said('config:model=opus,effort=high,fast=off,sandbox=on'); await idle();
  await page.evaluate(() => localStorage.setItem('p9-mode:claude', 'Manual'));
  assert.deepEqual(errors, []);
  await app.close();
  instance.child.kill('SIGTERM');
  await new Promise((resolve) => instance.child.exitCode !== null ? resolve() : instance.child.once('exit', resolve));
  const second = await restart(t, instance, 'state-2');
  const again = await launch(t, second, profile);
  await again.page.locator('#nav .row[data-chat="' + id + '"]').click();
  const p2 = again.page.locator('.pane[data-id="' + id + '"]');
  await p2.locator('[data-pill="Model"][aria-label="Model: Opus"]').waitFor({ timeout: 15000 });
  assert.deepEqual([await pillValue(p2, 'Mode'), await pillValue(p2, 'Effort')], ['Plan', 'High'], 'the pills show the chat\'s own');
  const type = async (text) => { await p2.locator('.composer textarea').fill(text); await p2.locator('.composer textarea').press('Enter'); };
  await type('config');
  await p2.locator('.hist', { hasText: /Resumed natively \(session\/resume\) on Opus/ }).waitFor({ timeout: 20000 });
  // The agent's replies (.msg.agent): the first config: reply is the one from before the restarts.
  const replies = (prefix) => p2.locator('.msg.agent').evaluateAll((l, prefix) => l.map((x) => x.textContent).filter((x) => x.includes(prefix)), prefix);
  await until(async () => (await replies('config:')).length === 2, 'a second config: reply');
  assert.match((await replies('config:'))[1], /config:model=opus,effort=high,fast=off,sandbox=on/, 'the resumed session runs on Opus and High');
  await again.page.locator('#navList .rowwrap[data-live]:not(:has([data-busy])) .row[data-chat="' + id + '"]').waitFor({ timeout: 15000 });
  await type('mode');
  await until(async () => (await replies('mode:')).length === 1, 'a mode: reply');
  assert.match((await replies('mode:'))[0], /mode:plan/, 'and in Plan');
  assert.deepEqual([await pillValue(p2, 'Model'), await pillValue(p2, 'Mode'), await pillValue(p2, 'Effort')], ['Opus', 'Plan', 'High']);
  await shot(again.page, 'o32-resumed');
  assert.deepEqual(again.errors, []);
  console.log('PASS resume (desktop): Opus, High and Plan shown and used after a daemon and an app restart');
});

test('resume shows settings that could not be restored', { timeout: 180000 }, async (t) => {
  const { app, instance, id, pane, page, send, said, idle } = await setup(t, 'resume-refused');
  const profile = await app.evaluate(({ app }) => app.getPath('userData'));
  await choose(page, pane, 'Model', 'Opus'); await choose(page, pane, 'Effort', 'High'); await choose(page, pane, 'Mode', 'Plan');
  await send('config'); await said('config:model=opus,effort=high'); await idle();
  fs.writeFileSync(path.join(instance.workspace, 'refuse-resume-settings'), '');
  await app.close(); instance.child.kill('SIGTERM');
  await new Promise((resolve) => instance.child.exitCode !== null ? resolve() : instance.child.once('exit', resolve));
  const second = await restart(t, instance, 'state-refused');
  const again = await launch(t, second, profile);
  await again.page.locator('#nav .row[data-chat="' + id + '"]').click();
  const p2 = again.page.locator('.pane[data-id="' + id + '"]');
  await p2.locator('.composer textarea').fill('hello'); await p2.locator('.composer textarea').press('Enter');
  await p2.locator('.hist', { hasText: 'Could not restore Model: Default (recommended), Effort: Medium, Mode: Manual' }).waitFor({ timeout: 20000 });
  await shot(again.page, 'o38-resume-refused');
  assert.deepEqual(again.errors, []);
});

// O29 (Builder, 2026-11-08): the chat that appears next in the list, made by this window; its pane, once shown.
const madeNext = async (page, had) => {
  await page.waitForFunction((had) => [...document.querySelectorAll('#navList .row[data-chat]')].some((x) => !had.includes(x.dataset.chat)), had, { timeout: 15000 });
  const id = await page.locator('#navList .row[data-chat]').evaluateAll((l, had) => l.map((x) => x.dataset.chat).find((x) => !had.includes(x)), had);
  const pane = page.locator('#chats .pane[data-id="' + id + '"]');
  await pane.locator('[data-pill="Mode"]').waitFor({ timeout: 15000 });
  return { id, pane };
};
const rows = (page) => page.locator('#navList .row[data-chat]').evaluateAll((l) => l.map((x) => x.dataset.chat));

// O29: New chat (+) opens on the agent used last on this computer, with that agent's saved mode: after a message in a Codex
// chat, + then Enter makes a Codex chat in Codex's last mode, and its first message runs in it.
test('New chat (+) opens on the agent used last here: + then Enter after a Codex chat makes a Codex chat in its saved mode', { timeout: 150000 }, async (t) => {
  const { page, pane, send, said, idle, errors } = await setup(t, 'agent-last', 'codex');
  await choose(page, pane, 'Mode', 'Read-only');
  await pane.locator('[data-pill="Mode"][aria-label="Mode: Read-only"]').waitFor();
  await send('mode'); await said('mode:read-only'); await idle();
  const had = await rows(page);
  await page.click('#newBtn'); await page.locator('#newPop:not([hidden])').waitFor();
  assert.deepEqual(await page.locator('#newPop .hd').evaluateAll((l) => l.filter((h) => h.offsetParent).map((h) => h.textContent).slice(-2)), ['New Codex', 'New Claude'], 'the last agent\'s section comes first');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.new), 'codex', 'its first row has the focus');
  await page.keyboard.press('Enter');
  const made = await madeNext(page, had);
  assert.deepEqual([await pillValue(made.pane, 'Agent'), await pillValue(made.pane, 'Mode')], ['Codex', 'Read-only'], 'a Codex chat, in Codex\'s saved mode');
  await made.pane.locator('.composer textarea').fill('mode'); await made.pane.locator('.composer textarea').press('Enter');
  await made.pane.locator('.hist', { hasText: 'mode:read-only' }).waitFor({ timeout: 20000 });
  assert.deepEqual(errors, []);
  console.log('PASS new chat: + opens on the agent used last, Enter starts it in that agent\'s saved mode');
});

// O29: the Agent pill, first in the bar. In an empty chat, picking the other agent makes the chat that agent's, with its saved
// defaults (mode, Default model, Default effort). A chat with messages keeps its agent: the other row is disabled and says why.
test('Agent pill: an empty chat switches agent and takes that agent\'s defaults; a chat with messages keeps its agent', { timeout: 150000 }, async (t) => {
  const { id, page, pane, errors } = await setup(t, 'agent-pill', 'claude');
  // Claude's lists are known (the chat's config came), so its Settings defaults can apply.
  await page.evaluate(() => { localStorage.setItem('p9-model-default:claude', 'haiku'); localStorage.setItem('p9-effort-default:claude', 'high'); localStorage.setItem('p9-mode:claude', 'Plan'); });
  assert.deepEqual(await pane.locator('.bar [data-pill]').evaluateAll((l) => l.map((b) => b.dataset.pill)), ['Agent', 'Mode', 'Model', 'Effort']);
  // A chat with messages: Codex is shown but disabled, with the reason; picking it changes nothing.
  assert.deepEqual(await pillItems(page, pane, 'Agent'), ['Claude ✓', 'Codex']);
  await pillOf(pane, 'Agent').click(); await page.locator('#pillMenu:not([hidden])').waitFor();
  assert.equal(await menuItem(page, 'Codex').getAttribute('aria-disabled'), 'true');
  assert.match(await page.locator('#pillMenu .pm-note').innerText(), /stays on its agent/);
  await menuItem(page, 'Codex').click({ force: true });
  assert.equal(await pillValue(pane, 'Agent'), 'Claude', 'still Claude');
  await page.keyboard.press('Escape');
  // An empty Codex chat from the New menu: its Agent menu offers Claude with what Claude would start on.
  let had = await rows(page);
  await page.click('#newBtn'); await page.locator('#newPop [data-new="codex"]').first().click();
  const empty = await madeNext(page, had);
  assert.equal(await pillValue(empty.pane, 'Agent'), 'Codex');
  await pillOf(empty.pane, 'Agent').click(); await page.locator('#pillMenu:not([hidden])').waitFor();
  assert.equal(await focused(page), 'Codex', 'the current agent has the focus');
  assert.equal(await menuItem(page, 'Claude').getAttribute('aria-disabled'), null);
  assert.equal(await menuItem(page, 'Claude').locator('.muted').innerText(), 'Plan · Haiku · High');
  await shot(page, 'o29-agent-picker');
  had = await rows(page);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  const switched = await madeNext(page, had);
  assert.deepEqual([await pillValue(switched.pane, 'Agent'), await pillValue(switched.pane, 'Mode'), await pillValue(switched.pane, 'Model'), await pillValue(switched.pane, 'Effort')],
    ['Claude', 'Plan', 'Haiku', 'High'], 'Claude, on Claude\'s defaults');
  await page.locator('#navList .row[data-chat="' + empty.id + '"]').waitFor({ state: 'detached', timeout: 10000 });
  assert.ok((await rows(page)).includes(id), 'the chat with messages is still there');
  await switched.pane.locator('.composer textarea').fill('config'); await switched.pane.locator('.composer textarea').press('Enter');
  await switched.pane.locator('.hist', { hasText: 'config:model=haiku,effort=high' }).waitFor({ timeout: 20000 });
  assert.deepEqual(errors, []);
  console.log('PASS agent pill: first in the bar; an empty chat switches with the agent\'s defaults; a chat with messages keeps its agent');
});

// O44: each New menu row starts the model it names. The rows are the agent's own list (the fake agent offers Default, Opus and
// Haiku) after the row that starts on the defaults; Codex, whose list this window has not seen, has only that row.
test('New menu: each row names a model the agent offers, and the chat it starts is on that model', { timeout: 150000 }, async (t) => {
  const { page, errors } = await setup(t, 'new-menu', 'claude');
  await page.click('#newBtn'); await page.locator('#newPop [data-new]').first().waitFor({ timeout: 10000 });
  const named = (a) => page.locator(`#newPop [data-sec="${a}"] [data-new]`).evaluateAll((l) => l.map((b) => [b.dataset.model ?? null, b.textContent]));
  assert.deepEqual(await named('claude'), [[null, 'Claude default model'], ['default', 'Claude · Default (recommended)'], ['opus', 'Claude · Opus'], ['haiku', 'Claude · Haiku']]);
  await until(async () => (await named('codex')).length === 4, 'the open menu fills in when the Codex list is read'); // O47: no reopen
  assert.deepEqual(await named('codex'), [[null, 'Codex default model'], ['default', 'Codex · Default (recommended)'], ['opus', 'Codex · Opus'], ['haiku', 'Codex · Haiku']], 'O47: listed before any Codex chat');
  await shot(page, 'o44-new-menu');
  const had = await rows(page);
  await page.locator('#newPop [data-new="claude"][data-model="haiku"]').click();
  const made = await madeNext(page, had);
  await until(async () => await pillValue(made.pane, 'Model') === 'Haiku', 'the chat shows the row\'s model', 5000);
  await made.pane.locator('.composer textarea').fill('model'); await made.pane.locator('.composer textarea').press('Enter');
  await made.pane.locator('.hist', { hasText: 'model:haiku' }).waitFor({ timeout: 20000 });
  assert.deepEqual(errors, []);
  console.log('PASS new menu: rows from the agent\'s own list; the row picked is the model the chat runs on');
});

// O44 review: the window's chat calls, held in the main process after the daemon answers. hold('create') holds the create
// reply, hold('events') the read that brings the chat's 'created', each for ms, so either can be made to come first.
async function holdChat(app) {
  await app.evaluate(({ ipcMain }) => {
    const h = ipcMain._invokeHandlers.get('p9:chat'); ipcMain.removeHandler('p9:chat'); globalThis.o44 = { what: null, ms: 0, done: 0, once: [] };
    const sleep = (ms) => new Promise((d) => setTimeout(d, ms));
    // once: the next call of that action only, held before it reaches the daemon (pre) and/or before its reply returns (post).
    ipcMain.handle('p9:chat', async (e, action, ...rest) => {
      const o = globalThis.o44, k = o.once.findIndex((x) => x.what === action), one = k >= 0 ? o.once.splice(k, 1)[0] : null;
      if (one?.pre) await sleep(one.pre);
      const r = await h(e, action, ...rest);
      if (one?.post) { await sleep(one.post); o.done++; } else if (!one && o.what === action) { await sleep(o.ms); o.done++; }
      return r;
    });
  });
  return { hold: (what, ms = 0) => app.evaluate((_, [what, ms]) => Object.assign(globalThis.o44, { what, ms, done: 0 }), [what, ms]), done: () => app.evaluate(() => globalThis.o44.done),
    once: (what, pre, post) => app.evaluate((_, [what, pre, post]) => { globalThis.o44.once.push({ what, pre, post }); globalThis.o44.done = 0; }, [what, pre, post]) };
}
const fromRow = async (page, model) => { const had = await rows(page); await page.click('#newBtn'); await page.locator(`#newPop [data-new="claude"][data-model="${model}"]`).click(); return madeNext(page, had); };
const sendModel = async (pane) => { await pane.locator('.composer textarea').fill('model'); await pane.locator('.composer textarea').press('Enter'); };
const ranOn = (pane, model) => pane.locator('.hist', { hasText: 'model:' + model }).waitFor({ timeout: 20000 });

test('New menu: the row\'s model applies once, whether the chat\'s created event or the create reply comes first, never over a pick made in the chat after', { timeout: 180000 }, async (t) => {
  const { app, page, errors } = await setup(t, 'new-order', 'claude');
  const chat = await holdChat(app);
  // 1. created first (the create reply held 4 s): the chat shows the row's model, and a message sent before the reply runs on it.
  await chat.hold('create', 4000);
  const a = await fromRow(page, 'haiku');
  assert.equal(await pillValue(a.pane, 'Model'), 'Haiku', 'created first: the row\'s model before the reply');
  await sendModel(a.pane);
  assert.equal(await chat.done(), 0, 'the message went while the create reply was still held');
  await ranOn(a.pane, 'haiku');
  await until(async () => await chat.done() === 1, 'the held reply returned', 10000);
  // 2. created first, and Opus picked in the chat before the reply: the reply leaves Opus.
  await chat.hold('create', 4000);
  const b = await fromRow(page, 'haiku');
  await choose(page, b.pane, 'Model', 'Opus');
  assert.equal(await chat.done(), 0, 'Opus was picked while the create reply was still held');
  await until(async () => await chat.done() === 1, 'the held reply returned', 10000);
  await sendModel(b.pane); await ranOn(b.pane, 'opus');
  assert.equal(await pillValue(b.pane, 'Model'), 'Opus', 'the reply did not put the row\'s model back');
  // 3. the reply first (the read that brings created held 2 s): the chat appears on the row's model.
  await chat.hold('events', 2000);
  const c = await fromRow(page, 'opus');
  await chat.hold(null);
  assert.equal(await pillValue(c.pane, 'Model'), 'Opus', 'reply first: the row\'s model');
  await sendModel(c.pane); await ranOn(c.pane, 'opus');
  assert.deepEqual(errors, []);
  console.log('PASS new menu order: created first and reply first both start on the row\'s model; a pick in the chat after it stays');
});

// O44 re-check: two creates in flight for one agent. The first (Haiku row) reaches the daemon 10 s late, so the second's
// (Opus row) 'created' comes first; its reply is held 4 s so the chat is used before it. Each chat gets its own row's model.
test('New menu: two overlapping creates for one agent each get their own row\'s model', { timeout: 180000 }, async (t) => {
  const { app, page, errors } = await setup(t, 'new-two', 'claude');
  const chat = await holdChat(app);
  await chat.once('create', 10000, 0); await chat.once('create', 0, 4000);
  const had = await rows(page);
  await page.click('#newBtn'); await page.locator('#newPop [data-new="claude"][data-model="haiku"]').click();
  const b = await fromRow(page, 'opus');
  assert.equal(await pillValue(b.pane, 'Model'), 'Opus', 'the second create\'s chat, before either reply: its own row\'s model');
  await sendModel(b.pane);
  assert.equal(await chat.done(), 0, 'the message went while the second create\'s reply was still held');
  await ranOn(b.pane, 'opus');
  const a = await madeNext(page, [...had, b.id]);
  assert.equal(await pillValue(a.pane, 'Model'), 'Haiku', 'the first create\'s chat: its own row\'s model');
  await sendModel(a.pane); await ranOn(a.pane, 'haiku');
  await page.click(`#navList .row[data-chat="${b.id}"]`); await b.pane.locator('[data-pill="Model"]').waitFor({ timeout: 5000 }); // the Haiku chat was shown on its created
  assert.equal(await pillValue(b.pane, 'Model'), 'Opus', 'the first create left the second chat alone');
  assert.deepEqual(errors, []);
  console.log('PASS new menu two creates: each overlapping create starts on its own row\'s model');
});

// O44 review: only New menu rows name a model. The palette's New Claude session starts on Settings' Default model.
test('New menu, palette: New Claude session starts on the saved Default model', { timeout: 150000 }, async (t) => {
  const { page, errors } = await setup(t, 'new-palette', 'claude');
  await page.evaluate(() => localStorage.setItem('p9-model-default:claude', 'opus'));
  const had = await rows(page);
  await page.keyboard.press('Control+k'); await page.fill('#palIn', 'New Claude session');
  await page.locator('#palList li[data-i]', { hasText: 'New Claude session' }).first().waitFor({ timeout: 5000 }); await page.keyboard.press('Enter');
  const made = await madeNext(page, had);
  await until(async () => await pillValue(made.pane, 'Model') === 'Opus', 'the palette\'s chat shows the saved default', 5000);
  await sendModel(made.pane); await ranOn(made.pane, 'opus');
  assert.deepEqual(errors, []);
  console.log('PASS new menu palette: New Claude session starts on the saved Default model');
});

// O29, release review (2026-11-09): switching an empty chat's agent keeps what was typed and attached, and the new chat takes
// the old one's place. A 1x1 PNG pasted into the box, as a screenshot is.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const paste = (box, b64) => box.evaluate((ta, b64) => {
  const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, b64);
const panes = (page, where = '#chats') => page.locator(where + ' .pane[data-id]').evaluateAll((l) => l.map((x) => x.dataset.id));
// An empty Codex chat from the New menu, then the chat with messages shown again: the open chats are [chat with messages, empty].
async function emptyBeside(page, id) {
  const had = await rows(page);
  await page.click('#newBtn'); await page.locator('#newPop [data-new="codex"]').first().click();
  const empty = await madeNext(page, had);
  await page.locator('#nav .row[data-chat="' + id + '"]').click();
  return empty.id;
}
const switchTo = async (page, pane, agent) => { const had = await rows(page); await choose(page, pane, 'Agent', agent); return had; };

test('Agent pill switch in Split: the empty chat in the second pane keeps its typed text and photo and stays in the second pane', { timeout: 150000 }, async (t) => {
  const { id, page, errors } = await setup(t, 'agent-swap-split', 'claude');
  const E = await emptyBeside(page, id);
  await page.locator('#chats .pane[data-id="' + id + '"] [data-tool="split"]').click();
  await page.locator('#chats .pane[data-id="' + E + '"] [data-pill="Agent"]').waitFor();
  assert.deepEqual(await panes(page), [id, E], 'Split: the chat with messages first, the empty one second');
  const empty = page.locator('#chats .pane[data-id="' + E + '"]');
  await empty.locator('.composer textarea').fill('a draft that must come along');
  await paste(empty.locator('.composer textarea'), PNG);
  await empty.locator('.attach .att').waitFor();
  const had = await switchTo(page, empty, 'Claude');
  const made = await madeNext(page, had);
  await page.locator('#navList .row[data-chat="' + E + '"]').waitFor({ state: 'detached', timeout: 10000 });
  await page.waitForFunction(([a, b]) => [...document.querySelectorAll('#chats .pane[data-id]')].map((x) => x.dataset.id).join() === a + ',' + b, [id, made.id], { timeout: 10000 }).catch(() => {});
  assert.deepEqual(await panes(page), [id, made.id], 'the new chat is in the second pane; the first is unchanged');
  assert.equal(await pillValue(made.pane, 'Agent'), 'Claude');
  assert.equal(await made.pane.locator('.composer textarea').inputValue(), 'a draft that must come along', 'the typed text came along');
  assert.equal(await made.pane.locator('.attach .att').count(), 1, 'and the photo');
  assert.equal(await focused(page), 'Agent: Claude', 'the new chat\'s Agent pill has the focus');
  await shot(page, 'o29-swap-split');
  assert.deepEqual(errors, []);
  console.log('PASS agent switch (Split): draft and photo kept, the new chat in the second pane, the first unchanged');
});

test('Agent pill switch in Dev Focus: the empty chat beside the editor is replaced there, and Chat Focus keeps its first pane', { timeout: 150000 }, async (t) => {
  const { id, instance, page, errors } = await setup(t, 'agent-swap-dev', 'claude');
  // Dev Focus folds the chat list to its strip, so the daemon's list says which chats there are.
  const daemonList = async () => (await call(instance, '/chat')).conversations.map((c) => c.id);
  const E = await emptyBeside(page, id);
  await page.click('#rDev');
  if (!(await page.locator('#sideChats').isVisible())) await page.click('#sideToggle');
  await page.locator('#sidePick').waitFor();
  await page.selectOption('#sidePick', E);
  const side = page.locator('#sideChats .pane[data-id="' + E + '"]');
  await side.locator('[data-pill="Agent"]').waitFor();
  const had = await daemonList();
  await choose(page, side, 'Agent', 'Claude');
  await until(async () => (await daemonList()).some((x) => !had.includes(x)), 'a new chat (menu hidden: ' + await page.evaluate(() => document.querySelector('#pillMenu').hidden) + ')');
  const made = (await daemonList()).find((x) => !had.includes(x));
  await until(async () => !(await daemonList()).includes(E), 'the empty chat deleted');
  await page.locator('#sideChats .pane[data-id="' + made + '"] [data-pill="Agent"][aria-label="Agent: Claude"]').waitFor({ timeout: 10000 }).catch(() => {});
  assert.deepEqual(await panes(page, '#sideChats'), [made], 'the new chat is the one beside the editor');
  await shot(page, 'o29-swap-dev');
  await page.click('#rChat');
  await page.locator('#chats .pane[data-id]').first().waitFor();
  assert.equal((await panes(page))[0], id, 'Chat Focus still shows the chat with messages first');
  assert.deepEqual(errors, []);
  console.log('PASS agent switch (Dev Focus): the new chat beside the editor, Chat Focus\'s first pane unchanged');
});
