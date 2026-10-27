// The phone's Chats list and chat screen (v0.1.6 phone spec §3; plan P1, P2, P3, P7): messages without bordered cards or label
// lines, a chat that opens at its last message, a page that appends instead of rewriting, and the running state on the list.
// Each check runs on the page as served, then on a page with the behaviour broken (a patch to the served files, or a stub):
// the check must fail there. Chromium cannot prove iPhone momentum scroll or keyboard timing.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice, root } from './helpers.mjs';

const SEED = '00000000-0000-4000-8000-0000000000a1';
const HOSTILE_TOOL = '<img src=x onerror="window.pwned=1">';
// The dev space keeps no files: the picture goes out in the log as "P9_SHOT <name> <base64>" (not on GitHub).
const shot = async (page, name) => { const png = await page.screenshot(); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
async function setup(paths) {
  await mkdir(path.join(paths.workspace, 'hub'), { recursive: true });
  await writeFile(path.join(paths.workspace, 'hub', 'registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
  await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ registry: 'hub/registry.json', hub: 'hub', server_host: 'test-server' }));
  return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
}
// One long chat the daemon never ran: a question, five tool calls (the first with a hostile title and output), a long reply with
// hostile markup, and an approval nobody has answered. The phone reads it from the ledger like any other chat.
function seed(server) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(SEED, 'claude', 'Seeded long chat', 'idle', Date.now());
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  const add = (type, data) => event.run(SEED, type, JSON.stringify(data), Date.now());
  const update = (data) => add('update', data);
  add('user', { text: 'What changed in the build?' });
  for (let i = 1; i <= 5; i++) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'seed-' + i, title: i === 1 ? HOSTILE_TOOL : 'Read file ' + i, kind: 'read', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: i === 1 ? '<script>window.pwned=2</script>' : 'line ' + i } }] });
  }
  const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long reply, with **bold** words and enough text that it wraps on a phone screen.`);
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: lines.join('\n\n') + '\n\n<img src=x onerror="window.pwned=3"> <script>window.pwned=5</script>' } });
  add('turn-end', { stopReason: 'end_turn' });
  add('user', { text: 'Write the marker file' });
  add('approval', { request: 'seed-req', toolCall: { title: 'Write marker' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
  db.close();
}
// No network in the dev space, so Chromium reports navigator.onLine false: the page is told it is online.
async function phoneOn(t, server, browser) {
  const device = await passkeyDevice(browser, server, 'phone-chats-' + Math.random().toString(36).slice(2, 7));
  const session = await enrollDevice(server, device);
  await device.context.addCookies([{ name: 'p9s', value: session.token, url: server.origin, httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await device.context.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { get: () => !window.__off, configurable: true }); });
  return { ...device, session };
}
async function open(device, server, { fix = [], init } = {}) {
  const { page, session } = device;
  // The A/B: swap text (a string or a pattern) in the served document, stylesheet and script so the old behaviour is back. The swap must hit.
  const hit = fix.map(() => false), seen = fix.map(() => '');
  await page.route('**/*', async (route) => {
    if (!fix.length || !['document', 'stylesheet', 'script'].includes(route.request().resourceType())) return route.continue();
    const response = await route.fetch({ url: route.request().url().replace('app.p9.localhost', '127.0.0.1'), headers: { ...route.request().headers(), host: server.host } });
    let body = await response.text();
    for (const [index, [from, to]] of fix.entries()) {
      if (typeof from === 'string' ? body.includes(from) : from.test(body)) { body = body.replace(from, to); hit[index] = true; }
      else if (!seen[index] && typeof from === 'string') { const at = body.indexOf(from.slice(0, 14)); if (at >= 0) seen[index] = body.slice(at, at + 160); }
    }
    await route.fulfill({ response, body });
  });
  // The phone's service worker re-fetches /_astro/ itself once it claims the page, and page.route never sees that fetch:
  // the reload would get the unpatched file whenever the worker wins the race. These pages run without it.
  await page.addInitScript(() => { if (navigator.serviceWorker) navigator.serviceWorker.register = async () => undefined; });
  if (init) await page.addInitScript(init);
  await page.goto(server.origin + '/phone/');
  await page.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  return { page, hits: () => hit.filter(Boolean).length, missed: () => fix.map((_, i) => hit[i] ? '' : 'patch ' + i + ' did not hit' + (seen[i] ? '; the served text reads: ' + seen[i] : '; its first 14 characters appear nowhere')).filter(Boolean).join(' | ') };
}
const until = async (check, what) => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out: ' + what);
};
async function openChat(page, id) {
  await page.waitForSelector('h1:text("Chats")');
  await page.click(`[data-chat="${id}"]`);
  await page.waitForSelector('#composer', { state: 'visible' });
}
// A chat the daemon runs, started from outside the page; the phone sees it on its next poll.
async function liveChat(server, text, title) {
  const chat = await server.desk('/chat', 'POST', { provider: 'claude', ...(title && { title }) });
  assert.equal(chat.status < 300, true);
  const id = chat.body.conversation;
  if (text) assert.equal((await server.desk('/chat/' + id + '/prompt', 'POST', { text })).status, 202);
  return id;
}

const checks = {
  // P1: a message is its text. No label line over it and no bordered card around it; a tool run folds into one row.
  async layout(page) {
    await openChat(page, SEED);
    await page.waitForSelector('#events article[data-kind=agent]');
    for (const kind of ['user', 'agent']) {
      const articles = page.locator(`#events article[data-kind=${kind}]`);
      assert.ok(await articles.count() >= 1, kind + ' blocks are drawn');
      assert.equal(await page.locator(`#events article[data-kind=${kind}] > b`).count(), 0, kind + ': no label line');
      assert.equal(await page.locator(`#events article[data-kind=${kind}].event`).count(), 0, kind + ': not a card');
      assert.equal(await articles.first().evaluate((node) => getComputedStyle(node).borderTopWidth), '0px', kind + ': no border');
    }
  },
  // Three or more tool calls in a row are one row; a tap opens them (the first title is hostile and stays text).
  async group(page) {
    await openChat(page, SEED);
    await page.waitForSelector('#events article[data-kind=group]');
    assert.match(await page.locator('#events article[data-kind=group] summary').first().textContent(), /Ran 5 tools/);
    assert.equal(await page.locator('#events > article[data-kind=tool]').count(), 0, 'no loose tool rows');
    await page.locator('#events article[data-kind=group] summary').first().click();
    assert.equal(await page.locator('#events article[data-kind=group] article[data-kind=tool]').count(), 5);
  },
  // P2: the chat opens on its last message, not the top.
  async bottom(page, { shots }) {
    await openChat(page, SEED);
    await page.waitForSelector('#events article[data-kind=approval], #events article[data-kind=ask]');
    await page.waitForTimeout(400);
    const at = await page.locator('#chatBody').evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight, view: node.clientHeight }));
    assert.ok(at.height > at.view * 2, 'the chat is longer than the screen');
    assert.ok(at.height - at.top - at.view < 4, 'the chat is scrolled to its end');
    const last = await page.locator('#events > :last-child').boundingBox(), area = await page.locator('#chatBody').boundingBox();
    assert.ok(last.y + last.height <= area.y + area.height + 1, 'the last message is on the screen');
    if (shots) await shot(page, 'c1-chat-long');
  },
  // P3: a tick of the long poll adds to the page; nodes already drawn stay, and the reader stays where they were.
  async append(page, { server }) {
    const id = await liveChat(server, 'stream 30');
    await openChat(page, id);
    await page.waitForSelector('#events :text("step 30 done")', { timeout: 30000 });
    await page.locator('#chatBody').evaluate((node) => { node.scrollTop = 500; });
    await page.waitForTimeout(300);
    const before = await page.locator('#chatBody').evaluate((node) => { [...document.querySelector('#events').children].forEach((child, index) => { child.__mark = index; }); return { top: node.scrollTop, count: document.querySelector('#events').children.length }; });
    assert.ok(before.top > 100 && before.top < 1500, 'the reader is part way up: ' + before.top);
    const tick = page.waitForResponse(async (response) => response.url().includes('/chat/events') && (await response.text().catch(() => '')).includes('echo:next'), { timeout: 20000 });
    assert.equal((await server.desk('/chat/' + id + '/prompt', 'POST', { text: 'next' })).status, 202);
    await tick;
    await page.waitForFunction(() => document.querySelector('#events').textContent.includes('echo:next'));
    const after = await page.locator('#chatBody').evaluate((node) => ({ top: node.scrollTop, marks: [...document.querySelector('#events').children].map((child) => child.__mark), count: document.querySelector('#events').children.length }));
    assert.ok(after.count > before.count, 'the new messages were added');
    assert.deepEqual(after.marks.slice(0, before.count), Array.from({ length: before.count }, (_, index) => index), 'the nodes already drawn are the same nodes');
    assert.ok(Math.abs(after.top - before.top) < 3, `the reader stayed put: ${before.top} -> ${after.top}`);
  },
  // P7: the list says which chats work and which wait on you.
  async running(page, { server, shots }) {
    const working = await liveChat(server, 'slow'), needs = await liveChat(server, 'permission');
    await page.waitForSelector('h1:text("Chats")');
    await page.waitForSelector(`[data-chat="${working}"][data-run=working]`, { timeout: 30000 });
    await page.waitForSelector(`[data-chat="${needs}"][data-run=needs]`, { timeout: 30000 });
    assert.match(await page.locator(`[data-chat="${working}"] small`).textContent(), /Working/);
    assert.equal(await page.locator(`[data-chat="${needs}"] small`).textContent(), 'Needs you');
    assert.equal(await page.locator(`[data-chat="${SEED}"]`).getAttribute('data-run'), 'needs', 'an unanswered approval is waiting on you');
    const height = await page.locator(`[data-chat="${needs}"]`).evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(height >= 56 && height <= 64, 'a row is about 60 px: ' + height);
    if (shots) await shot(page, 'c1-chats-list');
  },
  // Threat model row 18: text from the ledger (a tool title, its output, a reply, a chat title) is drawn as text.
  async xss(page, { server }) {
    const titled = await liveChat(server, '', '<img src=x onerror="window.pwned=4">');
    await page.waitForSelector(`[data-chat="${titled}"]`, { timeout: 30000 });
    assert.equal(await page.locator('#chatList img, #chatList script').count(), 0, 'the list draws a chat title as text');
    await openChat(page, SEED);
    await page.waitForSelector('#events article[data-kind=group]');
    await page.locator('#events article[data-kind=group] summary').first().click();
    await page.waitForSelector('#events article[data-kind=agent]');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#events img, #events script, #events b').count(), 0, 'no element came from the text');
    assert.ok((await page.locator('#events').textContent()).includes(HOSTILE_TOOL), 'the title shows as the characters');
    assert.ok((await page.locator('#events').textContent()).includes('<script>window.pwned=2</script>'), 'the output shows as the characters');
    assert.equal(await page.evaluate(() => window.pwned), undefined);
  },
  // The 390x500 picture: the composer rides the short viewport under the messages.
  async short(page, { shots }) {
    await openChat(page, SEED);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForFunction(() => document.body.classList.contains('kbd'));
    await page.waitForTimeout(400);
    const slot = await page.locator('#composerSlot').boundingBox();
    assert.ok(slot.y + slot.height <= 500.5, 'the composer is inside the short viewport');
    if (shots) await shot(page, 'c1-chat-500');
  },
};
const breaks = {
  layout: { fix: [['<article data-kind="agent" class="msg md">', '<article data-kind="agent" class="msg md event"><b>Claude</b>']] },
  group: { fix: [['<span class="t">Ran ', '<span class="t">Did ']] },
  bottom: { init: () => {
    const was = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get: was.get, set(value) { if (this.id !== 'chatBody') was.set.call(this, value); } });
  } },
  // Every node looks changed on every tick: the page is rewritten, as it was before.
  append: { fix: [[/(\w+)\.sig\s*!==\s*(\w+)\.sig/, '$1.sig!==$2.sig+Math.random()']] },
  running: { fix: [['" data-run="', '" data-runx="']] },
  xss: { fix: [[/<span class="t">\$\{\w+\((\w+)\.text\)\}/, '<span class="t">${$1.text}']] },
  short: { fix: [['id="composerSlot"', 'id="composerSlotGone"']] },
};

test('P1, P2, P3, P7: the Chats list and the chat screen (A/B)', { timeout: 900000 }, async (t) => {
  const server = await remoteDaemon(t, { setup, args: ['--acp-override', path.join(root, 'test/fake-acp-agent.mjs')] });
  seed(server);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  // Every check runs, and every failure is listed at the end: a run is too slow to find them one at a time.
  const failures = [];
  let said = '';
  for (const stream of [server.child.stdout, server.child.stderr]) stream.on('data', (chunk) => { said += chunk; });
  const run = async (name, check) => {
    const good = await open(await phoneOn(t, server, browser), server);
    try { await check(good.page, { server, shots: true }); } catch (error) { failures.push(name + ' (good page): ' + String(error.message).split('\n')[0]); await good.page.context().close(); return; }
    await good.page.context().close();
    const bad = await open(await phoneOn(t, server, browser), server, breaks[name]);
    if (breaks[name].fix && bad.missed()) { failures.push(name + ' (A/B): ' + bad.missed()); await bad.page.context().close(); return; }
    let broke = true;
    try { await check(bad.page, { server, shots: false }); broke = false; } catch { /* the check failed on the broken page, as it must */ }
    await bad.page.context().close();
    if (!broke) failures.push(name + ' (A/B): the check passed on the broken page');
  };
  for (const [name, check] of Object.entries(checks)) {
    try { await run(name, check); } catch (error) {
      failures.push(name + ': ' + String(error.message).split('\n')[0] + ' [daemon exit ' + server.child.exitCode + '/' + server.child.signalCode + '; its last output: ' + said.slice(-800) + ']');
      if (server.child.exitCode !== null) break;
    }
  }
  assert.deepEqual(failures, []);
});
