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
// A new chat for `agent`, picked; returns its id.
async function newChat(page, agent) {
  const before = await page.inputValue('#conversation');
  await page.click(`[data-new="${agent}"]`);
  await page.waitForFunction((was) => { const v = document.querySelector('#conversation').value; return v && v !== was; }, before, { timeout: 10000 });
  return page.inputValue('#conversation');
}
const youCount = (page, text) => page.locator('#events article', { has: page.locator('b', { hasText: /^You$/ }) }).filter({ hasText: text }).count();

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
    await page.waitForSelector('#queued:not([hidden]) :text("typed offline")');
    assert.equal(await page.inputValue('#prompt'), '');
    assert.deepEqual((await stored()).map((item) => item.text), ['typed offline']);
    assert.equal(prompts.length, 0, 'nothing is sent while offline');
    // The queue survives a reload.
    await page.reload();
    await page.waitForSelector('#queued:not([hidden]) :text("typed offline")');

    // Back online: the first send is lost after the daemon took it; the retry carries the same operation ID, so it is not sent twice.
    await setOnline(page, true);
    await until(() => prompts.length === 1, 'first send');
    assert.equal((await stored()).length, 1, 'a lost request keeps the message');
    await setOnline(page, true);
    await page.waitForSelector('#events article:has-text("echo:typed offline")', { timeout: 10000 });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompts[1]);
    assert.equal(await youCount(page, 'typed offline'), 1);
    assert.deepEqual(await stored(), []);
    assert.equal(await page.locator('#queued').isHidden(), true);
    await page.unroute('**/chat/*/prompt');

    // An approval is pending: a message now would decline it, so it waits in the queue and goes after the answer.
    await page.fill('#prompt', 'permission'); await page.click('#composer button');
    await page.waitForSelector('#events button[data-option="allow"]', { timeout: 10000 });
    assert.equal(await page.locator('#composer button').textContent(), 'Queue message');
    await page.fill('#prompt', 'after the approval'); await page.click('#composer button');
    await page.waitForSelector('#queued:not([hidden]) :text("after the approval")');
    assert.equal(await page.locator('#events button[data-option="allow"]').count(), 1, 'the approval is still open');
    await page.locator('#queued').scrollIntoViewIfNeeded();
    await shot(page, `phone-queue-${agent}`);
    // Taking one back puts its text in the box.
    await page.click('#queued [data-unqueue]');
    assert.equal(await page.inputValue('#prompt'), 'after the approval');
    assert.deepEqual(await stored(), []);
    await page.click('#composer button');
    await page.waitForSelector('#queued:not([hidden]) :text("after the approval")');
    await page.click('#events button[data-option="allow"]');
    await page.waitForSelector('#events article:has-text("permission:allow")', { timeout: 10000 }); // allowed, not declined
    await page.waitForSelector('#events article:has-text("echo:after the approval")', { timeout: 15000 });
    assert.equal(await youCount(page, 'after the approval'), 1);
    assert.deepEqual(await stored(), []);
  });
}

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
    await page.selectOption('#conversation', stopped);
    await page.waitForSelector('#events article:has-text("echo:hello old chat")', { timeout: 10000 });
    const history = reads.filter((url) => url.searchParams.get('only') === stopped);
    assert.equal(history.length >= 1, true);
    assert.equal(history[0].searchParams.has('until'), true);
    await page.selectOption('#conversation', live);
    await page.selectOption('#conversation', stopped);
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
    await page.waitForSelector('#pinned .plan li', { timeout: 15000 });
    assert.deepEqual(await page.locator('#pinned .plan li').allTextContents(), ['✓Read the chat ledger', '▸Pin the plan above the composer', '○Check it on the phone']);
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
      await card.waitFor({ timeout: 15000 });
      assert.equal(await card.locator('.eyebrow').textContent(), 'status · markdown');
      assert.match(await card.textContent(), /<img src=x onerror="window\.pwned=1"> <b>not bold<\/b>/);
      assert.equal(await card.locator('strong').innerText(), 'Build');
      assert.equal(await page.locator('#pinned img, #pinned b, #pinned script').count(), 0);
      assert.equal(await page.locator('#pinned [data-card="gone"]').count(), 0);
      assert.equal(await page.evaluate(() => window.pwned), undefined);
    };
    await shown();
    if (agent === 'claude') await shot(page, 'phone-plan-card');
    // Live: a pin shows at once, an unpin takes it away; a reload replays the ledger and shows the same strip.
    await tool('pin_card', { id: 'live', kind: 'table', text: '| check | state |\n|---|---|\n| lint | ok |' });
    await page.waitForSelector('#pinned [data-card="live"] table', { timeout: 15000 });
    await tool('unpin_card', { id: 'live' });
    await page.waitForSelector('#pinned [data-card="live"]', { state: 'detached', timeout: 15000 });
    await page.evaluate(() => localStorage.removeItem('p9-cursor'));
    await page.reload();
    await shown();
    assert.equal(await page.locator('#pinned .plan li').count(), 3);
  });
}
