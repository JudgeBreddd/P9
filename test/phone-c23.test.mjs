import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone, CHAT, seedChat, openChat } from './phone-c16-helpers.mjs';
import { claudeWindow } from '../apps/server/limits.mjs';

// The dev space keeps no files: pictures go out in the log as "P9_SHOT <name> <base64>".
const shot = async (page, name, options = {}) => { const png = await page.screenshot(options); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const db = (server) => new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
const MOVED = '00000000-0000-4000-8000-0000000000c2';
// A 1x1 PNG, for the attach picker.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('P5: the Claude context window is the auto-compact window when one is set (env first, then settings.json), else none', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-c23-window-'));
  assert.equal(await claudeWindow(dir, {}), null, 'no settings file');
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } }));
  assert.equal(await claudeWindow(dir, {}), 200000);
  assert.equal(await claudeWindow(dir, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' }), 150000, 'the environment wins');
  assert.equal(await claudeWindow(dir, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'lots' }), 200000, 'a bad env value falls back');
  await writeFile(path.join(dir, 'settings.json'), '{not json');
  assert.equal(await claudeWindow(dir, {}), null);
});

test('P3, P5, P16, P19, K8: running chat bar, named and capped context, a readable approval, Copy on code, moved chats in History', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server, { running: true });
  const d = db(server), now = Date.now(), event = d.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  event.run(CHAT, 'update', JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Run this:\n\n```sh\necho copied-c23\n```' } }), now);
  event.run(CHAT, 'update', JSON.stringify({ sessionUpdate: 'usage_update', used: 50000, size: 1000000 }), now);
  event.run(CHAT, 'approval', JSON.stringify({ request: 'r1', toolCall: { title: 'Run pnpm --filter @p9/web exec astro check --minimumFailingSeverity warning in the web app folder' },
    options: [{ optionId: 'a', name: 'Allow once', kind: 'allow_once' }, { optionId: 'b', name: 'Always allow in this folder', kind: 'allow_always' }, { optionId: 'c', name: 'Reject and tell Claude why', kind: 'reject_once' }] }), now);
  d.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(MOVED, 'claude', 'Moved chat', 'moved', now);
  event.run(MOVED, 'user', JSON.stringify({ text: 'hi' }), now);
  d.close();
  await mkdir(path.join(server.directory, '.claude'), { recursive: true });
  await writeFile(path.join(server.directory, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' } }));
  const { page, session } = await phone(t, server);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });

  // P5: the server sizes a Claude chat's context by its auto-compact window, and names the chat.
  const usage = await server.remote('/usage', { session });
  assert.deepEqual(usage.body.contexts.map(({ conversation, size }) => ({ conversation, size })), [{ conversation: CHAT, size: 200000 }]);

  // K8: a chat that moved to another machine is history, not open.
  await openChat(page, server);
  const groups = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#conversation optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)])));
  assert.ok(!groups.Open?.some((name) => name.includes('Moved chat')), 'a moved chat is listed as Open: ' + JSON.stringify(groups));
  assert.ok(groups.History?.some((name) => name.includes('Moved chat')), 'a moved chat is missing from History: ' + JSON.stringify(groups));

  // P3: a spinner (amber while it waits on you) and, apart from it, a labelled Stop.
  await page.waitForSelector('[data-bar="chat"] #stopTurn', { timeout: 10000 });
  const bar = await page.evaluate(() => { const run = document.querySelector('[data-bar="chat"] .run'), stop = document.querySelector('#stopTurn');
    return { run: run?.getAttribute('aria-label'), stop: stop.innerText.trim(), apart: !stop.contains(run) }; });
  assert.deepEqual(bar, { run: 'Waiting on you', stop: 'Stop', apart: true });

  // P16: the approval reads at 14 px and no choice is squeezed past its box.
  await page.waitForSelector('#events .msg.ask.open button', { timeout: 10000 });
  const ask = await page.evaluate(() => { const card = document.querySelector('#events .msg.ask.open');
    return { size: getComputedStyle(card).fontSize, squeezed: [...card.querySelectorAll('button')].filter((b) => b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).map((b) => b.textContent) }; });
  assert.deepEqual(ask, { size: '14px', squeezed: [] });
  await page.locator('#events .msg.ask.open').scrollIntoViewIfNeeded();
  await shot(page, 'c23-phone-chat');

  // P19: a reply's code block has Copy, and it copies the code.
  await page.click('#events pre [data-copycode]');
  await page.waitForSelector('#events pre [data-copycode]:text("Copied")', { timeout: 5000 });
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).trim(), 'echo copied-c23');

  // P5: the Usage tab names the context bar by its chat and shows it against 200,000 tokens.
  await page.goto(server.origin + '/phone/'); await page.waitForSelector('h1:text("Chats")');
  await page.click('[data-nav="usage"]');
  await page.waitForSelector('#usage .ctx', { timeout: 10000 });
  assert.match(await page.locator('#usage .ctxs').innerText(), /^Draft chat[\s\S]*25%[\s\S]*of 200,000 tokens/);
  await shot(page, 'c23-phone-usage', { fullPage: true });
  console.log('PASS P3 P5 P16 P19 K8');
});

test('P4, P6, P7, P17: boot black hole, refresh turns while it loads, Usage reloads itself, iPhone focus zoom off', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const { page } = await phone(t, server);
  // P4: the loading mark is a drawn black hole that bobs with the old squash and shadow timing (the broken ring around it
  // turns; phone-loading.test.mjs watches it on a held first load). The boot screen is gone once the page loads, so its rules
  // are read from the stylesheet.
  const bob = await page.evaluate(() => { const all = (rules) => [...rules].flatMap((r) => [r, ...(r.cssRules ? all(r.cssRules) : [])]);
    const rules = [...document.styleSheets].flatMap((s) => all(s.cssRules));
    const anim = (part) => rules.find((r) => r.selectorText === '.bh ' + part && r.style?.animationName)?.style.animation ?? '';
    return { keyframes: ['bob', 'shade', 'spin'].every((name) => rules.some((r) => r.type === CSSRule.KEYFRAMES_RULE && r.name === name)),
      hole: anim('.hole'), shade: anim('.shade'), ring: anim('.ring') }; });
  assert.equal(bob.keyframes, true, 'bob, shade and spin keyframes');
  assert.match(bob.hole, /0\.9s.*bob/); assert.match(bob.shade, /0\.9s.*shade/); assert.match(bob.ring, /1\.1s.*spin/);
  // The real P9 logo top left (docs/brand/icon-simplified-256.png at 64 px), loaded, not the old D-in-a-ring placeholder.
  await page.locator('[data-bar="chat"] img.mark').evaluate((el) => el.decode());
  const mark = await page.locator('[data-bar="chat"] img.mark').evaluate((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), new URL(el.src).pathname, el.naturalWidth]; });
  assert.deepEqual(mark, [16, 20, '/p9-mark.png', 64]);
  await shot(page, 'c23-phone-mark', { clip: { x: 0, y: 0, width: 390, height: 60 } });
  // The home-screen icon: the manifest and the apple-touch icon name only the brand PNG (docs/brand/icon-dark-512.png).
  const home = await page.evaluate(async () => ({ manifest: (await (await fetch('/manifest.webmanifest')).json()).icons.map((i) => i.src),
    touch: document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'), bytes: (await (await fetch('/p9-icon.png')).arrayBuffer()).byteLength }));
  assert.deepEqual(home, { manifest: ['/p9-icon.png'], touch: '/p9-icon.png', bytes: fs.statSync(new URL('../docs/brand/icon-dark-512.png', import.meta.url)).size });
  // P6: Refresh says it is loading, then when it last loaded.
  let loads = 0; page.on('request', (request) => { if (new URL(request.url()).pathname === '/usage') loads++; });
  await page.click('[data-nav="usage"]');
  await page.click('#refreshUsage');
  assert.equal(await page.getAttribute('#refreshUsage', 'aria-busy'), 'true');
  await page.waitForFunction(() => !document.querySelector('#refreshUsage').hasAttribute('aria-busy'), null, { timeout: 5000 });
  assert.match(await page.locator('#usageWhen').innerText(), /^Updated \d/);
  // P7: on the Usage tab it reloads on its own (every 20 s).
  const before = loads;
  await page.waitForTimeout(21500);
  assert.ok(loads > before, 'Usage did not reload on its own in 21.5 s');
  // P17: an iPhone does not zoom into the 14 px editor: the viewport stops the focus zoom (pinch still works on iOS).
  await page.context().addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }));
  await page.reload();
  assert.match(await page.getAttribute('meta[name="viewport"]', 'content'), /maximum-scale=1/);
  console.log('PASS P4 P6 P7 P17');
});

test('K9, K10: attached photos survive a reload; a sheet opened over the Mode sheet keeps the Mode controls', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  await openChat(page, server);
  // K10: the Mode sheet borrows the effort/plan controls; a second sheet over it must not wipe them.
  await page.click('#modePill');
  await page.waitForSelector('#sheetBody #more', { state: 'attached' });
  await page.evaluate(() => document.querySelector('#attach').click());
  await page.waitForSelector('#sheetTitle:text("Attach")');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => !!document.querySelector('#modeHome #more #pickers')), true, 'the Mode controls are gone');
  // K9: a photo attached, then a reload: it is still there.
  await page.setInputFiles('#attachInput', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('#attached img', { timeout: 10000 });
  await page.reload();
  await page.waitForSelector('#attached img[alt="dot.png"]', { timeout: 15000 });
  console.log('PASS K9 K10');
});

test('P15: the Files tab opens a folder outside the workspace by its path, saves there, and goes back', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const outside = path.join(server.directory, 'site');
  await mkdir(outside); await writeFile(path.join(outside, 'index.txt'), 'outside\n');
  const { page } = await phone(t, server);
  await page.click('[data-nav="files"]');
  await page.click('#pickFolder');
  await page.fill('#folderPath', server.directory);
  await page.click('[data-pickfolder] button[type="submit"]');
  await page.waitForSelector('[data-folder-note]:text("holds P9")', { timeout: 5000 });
  await page.fill('#folderPath', outside);
  await page.click('[data-pickfolder] button[type="submit"]');
  await page.waitForSelector('#fileList button[data-name="index.txt"]', { timeout: 10000 });
  assert.equal(await page.locator('[data-bar="files"] h1').innerText(), 'site');
  await shot(page, 'c23-phone-files-outside');
  await page.click('#fileList button[data-name="index.txt"]'); await page.waitForSelector('#fileState:text("Loaded")');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+A'); await page.keyboard.type('saved from the phone');
  await page.click('#save'); await page.waitForSelector('#fileState:text("Saved")', { timeout: 10000 });
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(outside, 'index.txt'), 'utf8'), 'saved from the phone');
  await page.click('#closeFile');
  await page.click('#pickFolder'); await page.click('[data-folder-home]');
  await page.waitForSelector('#fileList button[data-name="note.txt"]', { timeout: 10000 });
  assert.equal(await page.locator('[data-bar="files"] h1').innerText(), 'Workspace');
  console.log('PASS P15');
});
