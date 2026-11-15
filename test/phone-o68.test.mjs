import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

// O68: sheets, attaching and the Usage sign-in on the phone. Each test fails on main 074b17d.
const A = '00000000-0000-4000-8000-0000000000a1';
const shots = process.env.P9_SCREENSHOTS || '/tmp';
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png', path: shots + '/' + name + '.png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
function seed(server) {
  const ledger = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  ledger.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(A, 'claude', 'Attach here', 'idle', Date.now());
  const event = ledger.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  for (const [type, data] of [['user', { text: 'hello' }], ['update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi.' } }], ['turn-end', { stopReason: 'end_turn' }]]) event.run(A, type, JSON.stringify(data), Date.now());
  ledger.close();
}
const sheetBox = (page) => page.locator('#sheet').evaluate((d) => { const r = d.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; });
const settle = (page) => page.waitForFunction(() => document.querySelector('#sheet').open && !document.querySelector('#sheet').getAnimations().length, null, { timeout: 5000 });

test('O68 a: a sheet sits in the visible height, above a keyboard', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const { page } = await phone(t, server);
  await page.waitForSelector('h1:text("Chats")');
  // A keyboard on an iPhone: the page keeps its 844, the visible part is 400 tall and starts 60 down. phone.ts fit() writes
  // these two from visualViewport; Chromium has no keyboard to shrink it, so the test writes them.
  await page.evaluate(() => { const root = document.documentElement.style; root.setProperty('--vvh', '400px'); root.setProperty('--vvtop', '60px');
    dispatchEvent(new CustomEvent('p9-sheet', { detail: { title: 'Folder', html: '<label>Path<input id="o68Field"></label><p>one</p><p>two</p>' } })); });
  await settle(page);
  const low = await sheetBox(page);
  assert.equal(low.bottom, 460, `the sheet ends at ${low.bottom}, not at the visible bottom 460`);
  assert.ok(low.top >= 60, `the sheet starts at ${low.top}, above the visible part`);
  await shot(page, 'phone-o68-sheet');
  // The close event takes the full class off: it lands before the next sheet is asked for.
  await page.evaluate(() => new Promise((done) => { const sheet = document.querySelector('#sheet'); sheet.addEventListener('close', () => setTimeout(done), { once: true }); sheet.close(); }));
  await page.evaluate(() => dispatchEvent(new CustomEvent('p9-sheet', { detail: { title: 'Full', html: '<p>x</p>', full: true } })));
  await page.waitForSelector('#sheet.full[open]');
  await settle(page);
  assert.deepEqual(await sheetBox(page), { top: 60, bottom: 460, height: 400 }, 'a full sheet is the visible part');
  console.log('PASS O68 a: sheet bottom 460 of a 400-tall visible part starting at 60; full sheet 60 to 460');
});

test('O68 b: one tap to attach, and a file that cannot be attached says why', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seed(server);
  const { page } = await phone(t, server);
  const open = async () => { await page.click(`#chatList [data-chat="${A}"]`); await page.waitForSelector('#attach', { state: 'visible', timeout: 10000 }); };
  await open();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('#attach')]);
  assert.equal(await page.$eval('#sheet', (sheet) => sheet.open), false, 'P9 asked before the phone did');
  assert.equal(await page.$eval('#attachInput', (input) => input.accept), 'image/*');
  await chooser.setFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') }]);
  await page.waitForFunction(() => document.querySelector('#composerNote')?.textContent.includes('Not attached: notes.txt: PNG, JPEG, GIF or WebP only.'), null, { timeout: 10000 });
  await shot(page, 'phone-o68-attach-reason');
  // An iPhone greys out what a filter leaves out, with no reason: there P9 sets no filter, so the file can be picked and the line above says why.
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)' }));
  await page.reload();
  await page.waitForSelector(`#chatList [data-chat="${A}"], #attach`, { timeout: 15000 });
  if (!await page.isVisible('#attach')) await open();
  await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.click('#attach')]);
  assert.equal(await page.$eval('#attachInput', (input) => input.accept), '', 'an iPhone still gets the filter that greys files out');
  console.log('PASS O68 b: + opened the chooser with no sheet; notes.txt refused with its reason; no filter on an iPhone');
});

test('O68 c: a signed-in account is one line under the plan bars', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const { page } = await phone(t, server);
  const state = (claude) => ({ claude: { signedIn: claude, running: false, exit: null, url: null, code: null }, codex: { signedIn: true, running: false, exit: null, url: null, code: null } });
  let claude = true;
  // O91 diagnosis: on update PR #88 (Playwright 1.65) the mixed check saw two cards and no line. Every sign-in request, what
  // the route answered and what the page received go into the assertion messages, with the Playwright and browser versions.
  const trail = [];
  page.on('request', (r) => r.url().includes('/phone/sign-in') && trail.push(['request', r.method(), r.url().replace(server.origin, '')]));
  page.on('response', async (r) => r.url().includes('/phone/sign-in') && trail.push(['response', r.status(), r.fromServiceWorker(), await r.text().catch((e) => 'unread: ' + e.message)]));
  let version = '?'; try { version = JSON.parse(readFileSync(path.resolve('node_modules/@playwright/test/package.json'), 'utf8')).version; } catch {}
  const why = async (seenNow) => JSON.stringify({ playwright: version, browser: page.context().browser()?.version(), seen: seenNow, trail,
    box: await page.evaluate(() => document.querySelector('#signIn').innerHTML.slice(0, 800)) });
  await page.route('**/phone/sign-in', (route) => { trail.push(['route', route.request().method(), 'claude signed in: ' + claude]);
    return route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state(claude)) }) : route.continue(); });
  await page.click('nav [data-nav="usage"]');
  await page.waitForSelector('#signIn .sign-line[data-agent="codex"]', { timeout: 15000 });
  const seen = () => page.evaluate(() => { const box = document.querySelector('#signIn'), usage = document.querySelector('#usage');
    return { cards: box.querySelectorAll('.card').length, lines: [...box.querySelectorAll('.sign-line')].map((line) => [line.querySelector('span').textContent, Math.round(line.getBoundingClientRect().height)]),
      under: !!(usage.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING), framed: [...box.querySelectorAll('.sign-line button')].filter((b) => getComputedStyle(b).borderTopWidth !== '0px').length }; });
  const signedIn = await seen();
  assert.deepEqual(signedIn, { cards: 0, lines: [['Claude · Signed in', 44], ['Codex · Signed in', 44]], under: true, framed: 0 }, await why(signedIn));
  await shot(page, 'phone-o68-usage-signed-in');
  // An account that needs signing in is a card again, on top.
  claude = false;
  await page.click('nav [data-nav="chat"]'); await page.click('nav [data-nav="usage"]');
  await page.waitForSelector('#signIn .card[data-agent="claude"]', { timeout: 15000 });
  const mixed = await seen();
  assert.deepEqual([mixed.cards, mixed.lines.length, mixed.under], [1, 1, false], await why(mixed));
  await shot(page, 'phone-o68-usage-mixed');
  console.log('PASS O68 c: two lines under the plan bars when signed in; a card on top when one is not');
});
