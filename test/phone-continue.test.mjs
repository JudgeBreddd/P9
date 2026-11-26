// Continue on phone (PH1), the phone's own message queue (PH2), the narrowed replay (PH3) and the plan and cards (PH4). The phone page never asks
// which agent a chat runs, so each check runs on a Claude chat and a Codex chat (the fake agent serves both).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { remoteDaemon, passkeyDevice, enrollDevice, root } from './helpers.mjs';
import { phoneLink, qrSvg, phoneDialogBody } from '../apps/web/src/phone-link.mjs';

// The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
async function setup(paths) {
  await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', hub: 'hub', server_host: 'test-server' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
// The dev space has no network, so Chromium reports navigator.onLine false: the page is told it is online (or not) by
// window.__on, which survives a reload.
async function phoneOn(t) {
  const server = await remoteDaemon(t, { setup, args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const device = await passkeyDevice(browser, server, 'phone-continue');
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.context.addInitScript(() => {
    window.__on = true;
    Object.defineProperty(navigator, 'onLine', { get: () => window.__on, configurable: true });
  });
  await device.page.goto(server.origin + '/phone/');
  await device.page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await device.page.reload();
  await device.page.setViewportSize({ width: 390, height: 844 });
  return { ...device, server, session };
}
const until = async (check, what) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out: ' + what);
};
const setOnline = (page, on) => page.evaluate((on) => { window.__on = on; dispatchEvent(new Event(on ? 'online' : 'offline')); }, on);
// Back to the Chats list from a chat (the tab bar is gone inside one).
async function toList(page) {
  if (await page.locator('[data-back]').count()) await page.click('[data-back]');
  await page.waitForSelector('#chatList', { state: 'visible' });
}
// A new chat for `agent`: the + sheet makes it and the chat screen opens on it; returns its id.
async function newChat(page, agent) {
  await toList(page);
  const before = await page.inputValue('#conversation');
  await page.click('#newChat'); await page.click(`#sheet [data-new="${agent}"]`);
  await page.waitForFunction((was) => { const v = document.querySelector('#conversation').value; return v && v !== was; }, before, { timeout: 10000 });
  await page.waitForSelector('#composer', { state: 'visible' });
  return page.inputValue('#conversation');
}
// Opens chat `id` from the list, as a tap on its row.
async function pick(page, id) {
  await toList(page); await page.click(`[data-chat="${id}"]`);
  await page.waitForSelector('#composer', { state: 'visible' });
}
const youCount = (page, text) => page.locator('#events article[data-kind=user]').filter({ hasText: text }).count();

test('PH1: the link carries the chat id, the QR is drawn in the window, and the phone opens that chat', { timeout: 120000 }, async (t) => {
  const box = 'https://my-box.tail1.ts.net';
  assert.equal(phoneLink(box, 'abc-123'), 'https://my-box.tail1.ts.net/phone#chat=abc-123');
  assert.match(qrSvg(phoneLink(box, 'abc-123')), /^<svg[^>]*viewBox/);
  assert.equal(phoneDialogBody(box, 'abc-123').includes('value="https://my-box.tail1.ts.net/phone#chat=abc-123"'), true);
  assert.equal(/https?:\/\/[^"' ]*(qr|chart)/i.test(phoneDialogBody(box, 'abc-123')), false, 'no QR service');
  assert.match(phoneDialogBody('', 'abc-123'), /Remote logins are off/);

  const { page, server } = await phoneOn(t);
  for (const agent of ['claude', 'codex']) {
    const id = await newChat(page, agent);
    const other = await newChat(page, agent === 'claude' ? 'codex' : 'claude'); // the newest chat is the default pick
    assert.notEqual(other, id);
    // The path and hash of the link the window shows, on this daemon's own origin (the dev space has no https host).
    const url = new URL(phoneLink('https://test-server', id));
    await page.goto(server.origin + url.pathname + url.hash);
    await page.waitForSelector('#conversation option', { state: 'attached' });
    await until(async () => (await page.inputValue('#conversation')) === id, 'the linked chat is picked');
    if (agent === 'claude') await shot(page, 'phone-linked-chat');
    // An id that is not one of this phone's chats is ignored: the newest stays picked.
    await page.goto(server.origin + '/phone#chat=no-such-chat');
    await page.waitForSelector('#conversation option', { state: 'attached' });
    assert.equal(await page.inputValue('#conversation'), other);
  }
});

// Correction 7: a link that meets sign-in still opens its chat. The server's redirect to /login keeps the fragment (the
// browser carries it), and the login page passes on only an exact #chat=<uuid>: any other fragment is dropped.
test('PH1: sign-in keeps the linked chat, and drops any fragment that is not #chat=<uuid>', { timeout: 120000 }, async (t) => {
  const { page, context, server } = await phoneOn(t);
  const signIn = async (where, landing) => {
    await context.clearCookies();
    await page.goto(server.origin + where);
    await page.waitForURL(server.origin + '/login' + where.slice(where.indexOf('#')), { timeout: 10000 });
    await page.click('#login');
    await page.waitForURL(server.origin + landing, { timeout: 15000 });
    await page.waitForSelector('#conversation option', { state: 'attached' });
  };
  const ids = {};
  for (const agent of ['claude', 'codex']) ids[agent] = await newChat(page, agent);
  await newChat(page, 'claude'); // the default pick, so the linked chat shows only through the link
  for (const agent of ['claude', 'codex']) {
    await signIn('/phone#chat=' + ids[agent], '/phone/#chat=' + ids[agent]);
    await until(async () => (await page.inputValue('#conversation')) === ids[agent], `the linked ${agent} chat is picked after sign-in`);
  }
  for (const hash of ['#chat=' + ids.claude + '&next=https://evil.example', '#https://evil.example/', '#chat=../../x']) {
    await signIn('/phone' + hash, '/phone/');
    assert.equal(new URL(page.url()).hash, '');
  }
});

// O125 (4), Reviewer FIX1 on #367: the phone strip's age ticks on a fake clock, and its one timer runs only while an open
// chat has a queue: it stops when the queue empties and when the chat closes, and starts again when a message is queued.
test('O125 tick: the phone strip\'s oldest wait advances; its timer stops on an empty queue and a closed chat, and restarts', { timeout: 120000 }, async (t) => {
  const { page } = await phoneOn(t);
  const other = await newChat(page, 'claude'), id = await newChat(page, 'claude');
  await setOnline(page, false);
  await page.clock.install();
  const tick = () => page.evaluate(() => document.querySelector('#queued').dataset.tick ?? '');
  const summary = () => page.textContent('#queued summary');
  assert.equal(await tick(), '', 'no queue, no timer');
  await page.fill('#prompt', 'kept here'); await page.click('#composer button');
  await page.waitForSelector('#queued:not([hidden])');
  assert.equal(await summary(), '1 queued, oldest waiting <1 min ▸');
  assert.equal(await tick(), 'on', 'a queue starts the timer');
  await page.clock.runFor(2 * 60000 + 1000);
  assert.equal(await summary(), '1 queued, oldest waiting 2 min ▸', 'the age advances with nothing else redrawing');
  await page.locator('[data-unqueue]').dispatchEvent('click');
  await page.waitForSelector('#queued[hidden]', { state: 'attached' });
  assert.equal(await tick(), '', 'an empty queue stops the timer');
  await page.click('#composer button');
  await page.waitForSelector('#queued:not([hidden])');
  assert.equal(await tick(), 'on', 'a message queued again restarts it');
  // A hidden tab skips ticks; back on screen the age is current at once, not a tick late.
  const hide = (hidden) => page.evaluate((hidden) => { Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true }); if (!hidden) document.dispatchEvent(new Event('visibilitychange')); }, hidden);
  await hide(true); await page.clock.runFor(3 * 60000 + 1000);
  assert.equal(await summary(), '1 queued, oldest waiting <1 min ▸', 'hidden: no redraw');
  await hide(false);
  assert.equal(await summary(), '1 queued, oldest waiting 3 min ▸', 'visible again: the age is current at once');
  // Another chat with nothing queued: the timer stops; back on this chat it runs again (one timer).
  await pick(page, other);
  assert.equal(await tick(), '', 'a chat with no queue: no timer');
  await pick(page, id);
  assert.equal(await tick(), 'on', 'back on the queued chat');
  assert.equal(await summary(), '1 queued, oldest waiting 3 min ▸');
  await toList(page);
  await page.clock.runFor(15001);
  assert.equal(await tick(), '', 'a closed chat stops the timer at its next tick');
  console.log('PASS O125 tick: <1 min -> 2 min on the fake clock; timer off when empty, on again; current on return from hidden; follows a chat switch; off after the chat closed');
});

for (const agent of ['claude', 'codex']) {
  test(`PH2 (${agent}): messages typed offline or while an approval is pending are kept, then sent once`, { timeout: 120000 }, async (t) => {
    const { page, server } = await phoneOn(t);
    const id = await newChat(page, agent), key = 'p9-queue:' + id;
    const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), key);

    // Offline: the button stays usable, says what it will do, and the message is kept (and the box cleared).
    await setOnline(page, false);
    await page.waitForSelector('#stale:not([hidden])');
    assert.equal(await page.locator('#composer button').isDisabled(), false);
    assert.equal(await page.locator('#composer button').textContent(), 'Queue message');
    const prompts = [];
    await page.route('**/chat/*/prompt', async (route) => {
      prompts.push(route.request().headers()['x-p9-op']);
      // The daemon takes the first message, but its reply never reaches the phone.
      if (prompts.length === 1) { await route.fetch({ url: route.request().url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...route.request().headers(), host: server.host } }); await route.abort(); } else await route.continue();
    });
    await page.fill('#prompt', 'typed offline'); await page.click('#composer button');
    await page.waitForSelector('#queued:not([hidden]) :text("typed offline")', { state: 'attached' });
    assert.equal(await page.inputValue('#prompt'), '');
    assert.deepEqual((await stored()).map((item) => item.text), ['typed offline']);
    // O125 (4): a message kept on this phone has its time, and the strip names the wait.
    assert.ok(Math.abs(Date.now() - (await stored())[0].at) < 60000, 'the kept message has the time it was queued');
    assert.match(await page.textContent('#queued summary'), /^1 queued, oldest waiting <1 min ▸$/);
    assert.equal(prompts.length, 0, 'nothing is sent while offline');
    // The queue survives a reload.
    await page.reload();
    await page.waitForSelector('#queued:not([hidden]) :text("typed offline")', { state: 'attached' });

    // Back online: the first send is lost after the daemon took it; the retry carries the same operation ID, so it is not sent twice.
    await setOnline(page, true);
    await until(() => prompts.length === 1, 'first send');
    assert.equal((await stored()).length, 1, 'a lost request keeps the message');
    await setOnline(page, true);
    await page.waitForSelector('#events article:has-text("echo:typed offline")', { timeout: 10000 });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1]);
    assert.equal(await youCount(page, 'typed offline'), 1);
    // The echo comes from the first send (the daemon took it), so it can show before the retry's 202 empties the queue and
    // drain() redraws #queued after its fetchEvents: wait for both (CI 42431676626, 42455268765).
    await until(async () => (await stored()).length === 0 && await page.locator('#queued').isHidden(), 'the queue empties after the retry');
    await page.unroute('**/chat/*/prompt');

    // An approval is pending: a message now would decline it, so it waits in the queue and goes after the answer.
    await page.fill('#prompt', 'permission'); await page.click('#composer button');
    await page.waitForSelector('#events button[data-option="allow"]', { timeout: 10000 });
    assert.equal(await page.locator('#composer button').textContent(), 'Queue message');
    await page.fill('#prompt', 'after the approval'); await page.click('#composer button');
    await page.waitForSelector('#queued:not([hidden]) :text("after the approval")', { state: 'attached' });
    assert.equal(await page.locator('#events button[data-option="allow"]').count(), 1, 'the approval is still open');
    await page.evaluate(() => { const strip = document.querySelector('#queued details'); if (!strip.open) strip.querySelector('summary').click(); }); // O109: the queue is one folded line until opened
    await page.locator('#queued').scrollIntoViewIfNeeded();
    await shot(page, `phone-queue-${agent}`);
    // Taking one back puts its text in the box.
    await page.click('#queued [data-unqueue]');
    assert.equal(await page.inputValue('#prompt'), 'after the approval');
    assert.deepEqual(await stored(), []);
    await page.click('#composer button');
    await page.waitForSelector('#queued:not([hidden]) :text("after the approval")', { state: 'attached' });
    await page.click('#events button[data-option="allow"]');
    await page.waitForSelector('#events article:has-text("permission:allow")', { timeout: 10000 }); // allowed, not declined
    await page.waitForSelector('#events article:has-text("echo:after the approval")', { timeout: 15000 });
    assert.equal(await youCount(page, 'after the approval'), 1);
    assert.deepEqual(await stored(), []);
  });
}

test('O267: a message the phone\'s full storage refuses is not queued and stays in the box', { timeout: 120000 }, async (t) => {
  const { page } = await phoneOn(t);
  const id = await newChat(page, 'claude');
  await setOnline(page, false);
  await page.waitForSelector('#stale:not([hidden])');
  await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (String(key).startsWith('p9-queue:')) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, key, value); }; });
  await page.fill('#prompt', 'no room'); await page.click('#composer button');
  await page.waitForSelector('#composerNote:not([hidden])');
  assert.match(await page.textContent('#composerNote'), /storage is full/);
  assert.equal(await page.inputValue('#prompt'), 'no room', 'still in the box');
  assert.equal(await page.locator('#queued').isHidden(), true, 'not queued');
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), 'p9-queue:' + id), null);
  // Online, the daemon answering turn-running (the phone queues it for the turn's end): the same refusal.
  await page.fill('#prompt', ''); await setOnline(page, true); await page.waitForSelector('#stale', { state: 'hidden' });
  await page.route('**/chat/*/prompt', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'turn-running' }) }));
  await page.evaluate(() => { document.querySelector('#composerNote').hidden = true; });
  await page.fill('#prompt', 'busy'); await page.click('#composer button');
  await page.waitForSelector('#composerNote:not([hidden])');
  assert.match(await page.textContent('#composerNote'), /storage is full/);
  assert.equal(await page.inputValue('#prompt'), 'busy', 'still in the box');
  assert.equal(await page.locator('#queued').isHidden(), true, 'not queued');
});

for (const agent of ['claude', 'codex']) {
  test(`PH3 (${agent}): the first read asks only for chats that are not stopped; a stopped chat loads when picked`, { timeout: 120000 }, async (t) => {
    const { page, server } = await phoneOn(t);
    const stopped = await newChat(page, agent);
    await page.fill('#prompt', 'hello old chat'); await page.click('#composer button');
    await page.waitForSelector('#events article:has-text("echo:hello old chat")', { timeout: 10000 });
    const live = await newChat(page, agent === 'claude' ? 'codex' : 'claude');
    await page.fill('#prompt', 'hello live chat'); await page.click('#composer button');
    await page.waitForSelector('#events article:has-text("echo:hello live chat")', { timeout: 10000 });
    assert.equal((await server.desk(`/chat/${stopped}/stop`, 'POST')).status, 200);

    const reads = [];
    page.on('request', (request) => { if (request.url().includes('/chat/events')) reads.push(new URL(request.url())); });
    await page.evaluate(() => localStorage.removeItem('p9-cursor'));
    await page.reload();
    await page.waitForSelector('#events article:has-text("echo:hello live chat")', { timeout: 10000 });
    const first = reads.find((url) => url.searchParams.get('after') === '0'); // not the old page's last poll
    assert.equal(first.searchParams.get('only'), live, 'the first read is narrowed to the chat that is not stopped');
    // The stopped chat has no events yet; picking it reads them, once, up to where the first read stopped.
    assert.equal(reads.some((url) => url.searchParams.get('only') === stopped), false);
    await pick(page, stopped);
    await page.waitForSelector('#events article:has-text("echo:hello old chat")', { timeout: 10000 });
    const history = reads.filter((url) => url.searchParams.get('only') === stopped);
    assert.equal(history.length >= 1, true);
    assert.equal(history[0].searchParams.has('until'), true);
    await pick(page, live);
    await pick(page, stopped);
    await page.waitForSelector('#events article:has-text("echo:hello old chat")');
    assert.equal(reads.filter((url) => url.searchParams.get('only') === stopped).length, history.length, 'a loaded history is not read again');
    assert.equal(await youCount(page, 'hello old chat'), 1);
  });
}

// PH4: the plan and the cards an agent pins (pin_card, unpin_card) show on the phone, drawn by the desktop's own strip code.
for (const agent of ['claude', 'codex']) {
  test(`PH4 (${agent}): the phone shows the plan and pinned cards, HTML as text, an unpinned card gone, live and after a reload`, { timeout: 150000 }, async (t) => {
    const { page, server } = await phoneOn(t);
    const id = await newChat(page, agent);
    const send = async (text) => { await page.fill('#prompt', text); await page.click('#composer button'); };
    await send('plan');
    await page.waitForSelector('#pinned .plan li', { state: 'attached', timeout: 15000 });
    assert.deepEqual(await page.locator('#pinned .plan li').allTextContents(), ['✓Read the chat ledger', '▸Pin the plan above the composer', '○Check it on the phone']);
    // P1: no 35vh strip over the chat; one chip row, and a tap opens the plan in a sheet.
    assert.equal(await page.locator('#chips .chip').first().textContent(), 'Plan 1/3 ▸');
    await page.click('#chips .chip'); await page.waitForSelector('#sheet[open] .plan li');
    assert.equal(await page.locator('#sheet .plan li').count(), 3); await page.keyboard.press('Escape');
    // The agent's own MCP server (P9's) is how it pins; the fake agent hands over the command that starts it.
    await send('mcp');
    let entry;
    await until(async () => (entry = (await server.desk('/chat/events?after=0&only=' + id)).body.events.find((e) => e.data?.content?.text?.startsWith('mcp:'))), 'mcp entry');
    const [mcp] = JSON.parse(entry.data.content.text.slice(4));
    const client = new Client({ name: 'p9-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: mcp.command, args: mcp.args, env: Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])) }));
    t.after(() => client.close());
    const tool = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    assert.equal((await tool('pin_card', { id: 'status', kind: 'markdown', text: '**Build** green, 3 of 4 checks.\n\n<img src=x onerror="window.pwned=1"> <b>not bold</b>' })).pinned, 'status');
    assert.equal((await tool('pin_card', { id: 'gone', kind: 'checklist', text: '- [ ] never shown' })).pinned, 'gone');
    assert.equal((await tool('unpin_card', { id: 'gone' })).unpinned, 'gone');
    const shown = async () => {
      const card = page.locator('#pinned [data-card="status"]');
      await card.waitFor({ state: 'attached', timeout: 15000 });
      assert.equal(await card.locator('.eyebrow').textContent(), 'status · markdown');
      assert.match(await card.textContent(), /<img src=x onerror="window\.pwned=1"> <b>not bold<\/b>/);
      assert.equal(await card.locator('strong').textContent(), 'Build');
      assert.equal(await page.locator('#pinned img, #pinned b, #pinned script').count(), 0);
      assert.equal(await page.locator('#pinned [data-card="gone"]').count(), 0);
      assert.equal(await page.evaluate(() => window.pwned), undefined);
    };
    await shown();
    if (agent === 'claude') await shot(page, 'phone-plan-card');
    // Live: a pin shows at once, an unpin takes it away; a reload replays the ledger and shows the same strip.
    await tool('pin_card', { id: 'live', kind: 'table', text: '| check | state |\n|---|---|\n| lint | ok |' });
    await page.waitForSelector('#pinned [data-card="live"] table', { state: 'attached', timeout: 15000 });
    await tool('unpin_card', { id: 'live' });
    await page.waitForSelector('#pinned [data-card="live"]', { state: 'detached', timeout: 15000 });
    await page.evaluate(() => localStorage.removeItem('p9-cursor'));
    await page.reload();
    await shown();
    assert.equal(await page.locator('#pinned .plan li').count(), 3);
  });
}

// O37 (threat model row 18): the phone colours a reply's complete code blocks too, and leaves an unknown language plain.
// phone-2 (the plan itself never showed, only the approval buttons): Claude's plan call arrives
// empty and its plan comes after it, in the update and in the approval. The phone shows the plan before any choice is tapped.
test('phone-2: the plan approval shows the plan above its choices, and the tool row opens it after', { timeout: 120000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  await page.fill('#prompt', 'plan approve'); await page.click('#composer button');
  const ask = page.locator('#events article[data-kind=approval]');
  await ask.locator('button[data-option="exit-plan-default"]').waitFor({ timeout: 10000 });
  assert.equal(await ask.locator('.ask-plan h1').textContent(), 'Ship the phone plan');
  assert.equal(await ask.locator('.ask-plan li').count(), 2);
  assert.ok(await ask.locator('.ask-plan').isVisible());
  await ask.locator('.ask-plan').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, 'phone-plan-approval');
  await ask.locator('button[data-option="exit-plan-default"]').click();
  await page.waitForSelector('#events article:has-text("plan:exit-plan-default")', { timeout: 10000 });
  // Answered: the plan stays one tap away on the tool row (its update carried it), not drawn again in full.
  assert.equal(await ask.locator('.ask-plan').count(), 0);
  await page.locator('#events article[data-kind=tool] .open-plan, #events article[data-kind=group] .open-plan').first().click();
  await page.waitForSelector('#sheet:has-text("Plan")', { timeout: 10000 });
});

test('Code colours on the phone: a ts, python, json and shell reply coloured in Azure; an unknown language stays plain', { timeout: 120000 }, async (t) => {
  const { page } = await phoneOn(t);
  await newChat(page, 'claude');
  const fence = (lang, code) => '```' + lang + '\n' + code + '\n```\n\n';
  await page.fill('#prompt', 'Four blocks:\n\n' + fence('ts', 'const n: number = 42; // note\nfunction f(x: string) { return "s"; }') + fence('python', 'def f(x):\n    return True')
    + fence('json', '{"a": 1, "ok": null}') + fence('sh', 'pnpm install "./app"  # build') + fence('zz', 'plain = 1'));
  await page.click('#composer button');
  const reply = page.locator('#events article[data-kind=agent]').last();
  await reply.locator('code.language-sh .cc-comment').first().waitFor({ timeout: 15000 });
  await reply.locator('code.language-json .cc-const').first().waitFor({ timeout: 15000 });
  await page.evaluate(() => { const h = document.documentElement; h.classList.add('dark'); h.dataset.theme = 'p9-event-horizon-azure'; });
  const seen = await reply.evaluate((m) => [...m.querySelectorAll('pre code')].map((c) => [c.className, c.querySelectorAll('span').length > 0]));
  assert.deepEqual(seen, [['language-ts', true], ['language-python', true], ['language-json', true], ['language-sh', true], ['language-zz', false]]);
  assert.equal(await reply.locator('code.language-ts .cc-keyword').first().evaluate((s) => getComputedStyle(s).color), 'rgb(183, 122, 255)');
  await page.waitForTimeout(300);
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT phone-code-colours-azure ' + (await page.screenshot()).toString('base64'));
});

// O180: a card pinned while the reader is at the bottom unhides the chip row above the chat; the last line of the reply stays in view.
test('O180: the last reply line stays in view when the pinned chip row appears', { timeout: 150000 }, async (t) => {
  const { page, server } = await phoneOn(t);
  const id = await newChat(page, 'claude');
  const send = async (text) => { await page.fill('#prompt', text); await page.click('#composer button'); };
  await send('mcp');
  let entry;
  await until(async () => (entry = (await server.desk('/chat/events?after=0&only=' + id)).body.events.find((e) => e.data?.content?.text?.startsWith('mcp:'))), 'mcp entry');
  const [mcp] = JSON.parse(entry.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: mcp.command, args: mcp.args, env: Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  await send(Array.from({ length: 60 }, (_, i) => 'line ' + (i + 1) + ' of a message taller than the phone').join('\n')); // a chat that scrolls
  await send('many steps');
  await page.waitForFunction(() => /All steps done\./.test(document.querySelector('#events')?.lastElementChild?.textContent ?? ''), null, { timeout: 30000 });
  assert.ok(await page.locator('#chips').isHidden(), 'no chip row before the card');
  // The reader is at the bottom: the reply's last line is inside the scroller.
  const gap = () => page.evaluate(() => {
    const body = document.querySelector('#chatBody'), last = document.querySelector('#events').lastElementChild;
    return { below: Math.round(last.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom), fromEnd: Math.round(body.scrollHeight - body.scrollTop - body.clientHeight) };
  });
  await until(async () => (await gap()).fromEnd <= 1, 'at the bottom before the card');
  assert.ok(await page.evaluate(() => { const body = document.querySelector('#chatBody'); return body.scrollHeight > body.clientHeight + 200; }), 'the chat is taller than its scroller');
  await client.callTool({ name: 'pin_card', arguments: { id: 'report', kind: 'markdown', text: 'Worker report: PR #180' } });
  await page.waitForFunction(() => /1 pinned/.test(document.querySelector('#chips')?.textContent ?? ''), null, { timeout: 15000 });
  await page.waitForTimeout(300); // every observer and frame after the chip row shows has run
  const after = await gap();
  assert.ok(after.below <= 1 && after.fromEnd <= 1, 'the last reply line is in view after the chip row shows: ' + JSON.stringify(after));
  // And when the chip row closes again, the reader stays at the bottom.
  await page.click('#chips [data-chip-close]');
  await page.waitForSelector('#chips', { state: 'hidden', timeout: 5000 });
  await page.waitForTimeout(300);
  const closed = await gap();
  assert.ok(closed.below <= 1 && closed.fromEnd <= 1, 'still at the bottom after the chip row hides: ' + JSON.stringify(closed));
});
