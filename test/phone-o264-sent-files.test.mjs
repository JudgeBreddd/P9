import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone, seedChat, openChat, CHAT as CHAT_ID } from './phone-c16-helpers.mjs';

// O264: after an accepted send the phone takes the sent files out of its IndexedDB store with a write nobody waits for. A page
// killed before that write lands brought the sent photos and files back on reload, and send sent them again. Here the write
// never starts (indexedDB.open answers nothing), as on a page killed at that moment.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FILES = [{ name: 'dot.png', mimeType: 'image/png', buffer: PNG }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }];
// The chips on screen, and the files this phone's store holds for every chat.
const seen = (page) => page.evaluate(() => new Promise((done, fail) => {
  const chips = document.querySelectorAll('#attached .chip-img, #attached .chip-file').length, open = indexedDB.open('p9-attached', 1);
  open.onerror = () => fail(open.error);
  open.onsuccess = () => { const db = open.result, all = db.transaction('chats').objectStore('chats').getAll();
    all.onsuccess = () => { db.close(); done({ chips, stored: all.result.reduce((n, list) => n + list.length, 0) }); }; };
}));
// Until the phone has read its store back after a load and written it again: the chips and the store agree, on at least want
// (more is a failure the assertion shows at once).
async function settled(page, want) {
  let now; for (const end = Date.now() + 15000; Date.now() < end; await new Promise((done) => setTimeout(done, 200))) {
    now = await seen(page).catch(() => null); if (now && now.chips === now.stored && now.chips >= want) return now;
  }
  return now;
}
const send = async (page, text) => { await page.fill('#prompt', text); await page.click('#composer button[type="submit"]'); };

test('O264: files sent with an accepted message stay gone after a reload when the store never took them out; a refused send keeps them', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  let status = 400; const posts = [];
  await page.route('**/chat/*/prompt', (route) => { posts.push(route.request().postDataJSON());
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 202 ? { accepted: true } : { error: 'refused-here' }) }); });
  await openChat(page, server);
  await page.setInputFiles('#attachInput', FILES);
  assert.deepEqual(await settled(page, 2), { chips: 2, stored: 2 }, 'both files attached and kept');
  // A refused send: the files stay attached, and a reload still has them (as before this fix).
  await send(page, 'refused');
  await page.waitForFunction(() => document.querySelector('#composerNote')?.textContent.includes('refused-here'), null, { timeout: 10000 });
  assert.equal(posts.length, 1);
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  assert.deepEqual(await settled(page, 2), { chips: 2, stored: 2 }, 'a refused send keeps its files through a reload');
  // An accepted send with the store's write never landing, then a reload: no chip comes back, and the store is emptied.
  status = 202;
  await page.evaluate(() => { indexedDB.open = () => ({}); });
  await send(page, 'accepted');
  await page.waitForFunction(() => !document.querySelectorAll('#attached .chip-img, #attached .chip-file').length, null, { timeout: 10000 });
  assert.equal(posts.length, 2); assert.deepEqual([posts[1].images?.length, posts[1].files?.length], [1, 1], 'the accepted send carried both files');
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  assert.deepEqual(await settled(page, 0), { chips: 0, stored: 0 }, 'the sent files came back after the reload');
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('p9-attached-sent'))).length, 2, 'both sent files are kept as sent, after the store dropped them too');
  // A new file after that is kept as before.
  await page.setInputFiles('#attachInput', [FILES[1]]);
  assert.deepEqual(await settled(page, 1), { chips: 1, stored: 1 }, 'a file attached after the reload is kept');
  console.log('PASS O264: refused send kept 2 files through a reload; accepted send with the store write blocked left 0 chips and 0 stored after a reload');
});

// Round 2. The prompt route answers when let go (hold), so a test can act while a send is on its way.
async function held(page) {
  const posts = []; let open = () => {}, gate = new Promise((done) => { open = done; });
  await page.route('**/chat/*/prompt', async (route) => { posts.push(route.request().postDataJSON()); await gate; return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) }); });
  return { posts, release: () => open() };
}
const names = (page) => page.evaluate(() => [...document.querySelectorAll('#attached .chip-file span, #attached .chip-img img')].map((el) => el.textContent || el.getAttribute('alt')).sort());
const blockStore = (page) => page.evaluate(() => { indexedDB.open = () => ({}); });
// Two different text files of one size whose base64 ends the same (they differ only in their first byte).
const twin = (first) => ({ name: first + '.txt', mimeType: 'text/plain', buffer: Buffer.from(first + 'x'.repeat(98) + '\n') });

test('O264 round 2: a file attached while a send is on its way stays, even when it is the same size and ends the same as the sent one', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  const { posts, release } = await held(page);
  await openChat(page, server);
  await page.setInputFiles('#attachInput', [twin('a')]);
  assert.deepEqual(await settled(page, 1), { chips: 1, stored: 1 });
  await send(page, 'with a');
  for (const end = Date.now() + 10000; !posts.length && Date.now() < end;) await new Promise((done) => setTimeout(done, 100));
  assert.equal(posts.length, 1, 'the send went');
  await page.setInputFiles('#attachInput', [twin('b')]);
  assert.deepEqual(await settled(page, 2), { chips: 2, stored: 2 }, 'b.txt attached and kept while the send waits');
  await blockStore(page); release();
  await page.waitForFunction(() => document.querySelectorAll('#attached .chip-file').length === 1, null, { timeout: 10000 });
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  assert.deepEqual(await settled(page, 1), { chips: 1, stored: 1 });
  assert.deepEqual(await names(page), ['b.txt'], 'only the file that was not sent comes back');
  console.log('PASS O264 r2 twin: a.txt sent, b.txt (same size and end) attached meanwhile, only b.txt back after the reload');
});

test('O264 round 2: a ✕ on a file while its send is on its way does not bring it back after a reload', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  const { posts, release } = await held(page);
  await openChat(page, server);
  await page.setInputFiles('#attachInput', FILES);
  assert.deepEqual(await settled(page, 2), { chips: 2, stored: 2 });
  await send(page, 'both');
  for (const end = Date.now() + 10000; !posts.length && Date.now() < end;) await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual([posts[0]?.images?.length, posts[0]?.files?.length], [1, 1], 'both files went');
  await blockStore(page);
  await page.click('#attached [data-unattach="1"]'); // notes.txt, on its way
  release();
  await page.waitForFunction(() => !document.querySelectorAll('#attached .chip-img, #attached .chip-file').length, null, { timeout: 10000 });
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  assert.deepEqual(await settled(page, 0), { chips: 0, stored: 0 }, 'a file that went came back');
  console.log('PASS O264 r2 remove: both files sent, one removed mid-send, none back after the reload');
});

test('O264 round 2: another tab rewriting the store with a sent file does not bring it back on the next launch', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  await page.route('**/chat/*/prompt', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) }));
  await openChat(page, server);
  await page.setInputFiles('#attachInput', [FILES[0]]);
  assert.deepEqual(await settled(page, 1), { chips: 1, stored: 1 });
  // A second tab on the same phone, with the same chat and its photo in memory.
  const other = await page.context().newPage();
  await other.goto(server.origin + '/phone/#chat=' + CHAT_ID);
  await other.waitForSelector('#attached img[alt="dot.png"]', { timeout: 15000 });
  await blockStore(page);
  await send(page, 'photo');
  await page.waitForFunction(() => !document.querySelectorAll('#attached img').length, null, { timeout: 10000 });
  // The other tab hears of the send and drops the photo; its next rewrite has only its own new file.
  await other.waitForFunction(() => !document.querySelectorAll('#attached img').length, null, { timeout: 10000 });
  await other.setInputFiles('#attachInput', [FILES[1]]);
  assert.deepEqual(await settled(other, 1), { chips: 1, stored: 1 }, 'the other tab wrote the sent photo back');
  await other.close();
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  assert.deepEqual(await settled(page, 1), { chips: 1, stored: 1 });
  assert.deepEqual(await names(page), ['notes.txt'], 'the sent photo came back from the other tab\'s rewrite');
  console.log('PASS O264 r2 tab: the other tab dropped the photo sent while the sender\'s store was blocked; the next launch had only notes.txt');
});

// Round 3. Two tabs on one draft: B opens the chat with the photo in its memory, then A sends the photo and A's removal from
// the store lands. A sent file's mark stays (a tombstone), so B can neither write it back nor send it.
async function twoTabs(t, { running = false, deaf = false } = {}) {
  const server = await remoteDaemon(t, {});
  seedChat(server, { running });
  const { page, session } = await phone(t, server);
  const posts = [];
  await page.context().route('**/chat/*/prompt', (route) => { posts.push(route.request().postDataJSON()); return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) }); });
  await openChat(page, server);
  await page.setInputFiles('#attachInput', [FILES[0]]);
  assert.deepEqual(await settled(page, 1), { chips: 1, stored: 1 });
  const other = await page.context().newPage();
  // deaf: B's own storage listeners are let go of once deaf is set, as on a page frozen when the event came
  if (deaf) await other.addInitScript(() => { const add = window.addEventListener; window.addEventListener = function (type, fn, ...rest) { return add.call(this, type, type === 'storage' ? (event) => { if (!window.deaf) fn(event); } : fn, ...rest); }; });
  await other.goto(server.origin + '/phone/#chat=' + CHAT_ID);
  await other.evaluate((csrf) => sessionStorage.setItem('p9-csrf', csrf), session.csrf);
  await other.waitForSelector('#attached img[alt="dot.png"]', { timeout: 15000 });
  if (deaf) await other.evaluate(() => { window.deaf = true; });
  await send(page, 'photo');
  await page.waitForFunction(() => !document.querySelectorAll('#attached img').length, null, { timeout: 10000 });
  assert.deepEqual(await settled(page, 0), { chips: 0, stored: 0 }, 'A sent the photo and its removal landed');
  assert.deepEqual([posts.length, posts[0].images?.length], [1, 1]);
  return { page, other, posts };
}

test('O264 round 3: a tab that still held a photo another tab sent, and its removal landed, does not write it back when it adds a file', { timeout: 120000 }, async (t) => {
  const { page, other } = await twoTabs(t);
  await page.close(); // only B writes from here
  await other.setInputFiles('#attachInput', [FILES[1]]);
  await settled(other, 1);
  await other.reload(); await other.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  assert.deepEqual(await settled(other, 1), { chips: 1, stored: 1 });
  assert.deepEqual(await names(other), ['notes.txt'], 'the sent photo came back from the stale tab, or its new file was lost');
  console.log('PASS O264 r3 commit-first: A sent the photo and the store dropped it; B added notes.txt; after a reload only notes.txt');
});

test('O264 round 3: a tab that still held a photo another tab sent does not send it again', { timeout: 120000 }, async (t) => {
  const { other, posts } = await twoTabs(t);
  await send(other, 'from b');
  for (const end = Date.now() + 10000; posts.length < 2 && Date.now() < end;) await new Promise((done) => setTimeout(done, 100));
  assert.equal(posts.length, 2, 'B sent');
  assert.equal(posts[1].text, 'from b');
  assert.deepEqual([posts[1].images?.length ?? 0, posts[1].files?.length ?? 0], [0, 0], 'B sent the photo A had already sent');
  console.log('PASS O264 r3 stale send: A sent the photo; B\'s next send went without it');
});

test('O264 round 3: a file kept before files had ids, sent before any rewrite of the store landed, stays gone after a reload', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const { page } = await phone(t, server);
  const posts = [];
  await page.route('**/chat/*/prompt', (route) => { posts.push(route.request().postDataJSON()); return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) }); });
  // While the flag is set, the phone's writes to its store never land (the test's own write uses the real put).
  await page.context().addInitScript(() => { if (!sessionStorage.getItem('o264-block')) return; const proto = IDBObjectStore.prototype; proto.realPut = proto.put; proto.put = proto.clear = proto.delete = function () { return {}; }; });
  await openChat(page, server);
  await page.evaluate(() => sessionStorage.setItem('o264-block', '1'));
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  await page.evaluate(({ chat, data }) => new Promise((done, fail) => { const open = indexedDB.open('p9-attached', 1);
    open.onerror = () => fail(open.error);
    open.onsuccess = () => { const tx = open.result.transaction('chats', 'readwrite'); tx.objectStore('chats').realPut([{ mimeType: 'image/png', data, name: 'old.png' }], chat); tx.oncomplete = () => { open.result.close(); done(); }; }; }), { chat: CHAT_ID, data: PNG.toString('base64') });
  await page.reload(); await page.waitForSelector('#attached img[alt="old.png"]', { timeout: 15000 });
  await send(page, 'old photo');
  await page.waitForFunction(() => !document.querySelectorAll('#attached img').length, null, { timeout: 10000 });
  assert.deepEqual([posts.length, posts[0].images?.length], [1, 1], 'the old photo went');
  assert.equal((await seen(page)).stored, 1, 'the store still holds it (its rewrite never landed)');
  await page.evaluate(() => sessionStorage.removeItem('o264-block'));
  await page.reload(); await page.waitForSelector('#prompt', { state: 'visible', timeout: 15000 });
  assert.deepEqual(await settled(page, 0), { chips: 0, stored: 0 }, 'the old photo came back');
  console.log('PASS O264 r3 legacy: a photo stored with no id, sent with the store blocked, was not back after a reload');
});

test('O264 round 4: a Send tap on a photo-only draft whose photo another tab sent stops nothing and sends nothing', { timeout: 120000 }, async (t) => {
  const { page, other, posts } = await twoTabs(t, { running: true, deaf: true });
  const cancels = [];
  await page.context().route('**/chat/*/cancel', (route) => { cancels.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  assert.equal(await other.locator('#send').getAttribute('data-stop'), 'false', 'B still shows the photo, so its button is Steer, not Stop');
  await send(other, '');
  await other.waitForFunction(() => document.querySelector('#composerNote')?.textContent.includes('Nothing to send'), null, { timeout: 10000 }).catch(() => {});
  await new Promise((done) => setTimeout(done, 1000));
  assert.deepEqual([cancels.length, posts.length], [0, 1], 'B\'s Send tap stopped the turn or sent again');
  assert.match(await other.locator('#composerNote').textContent(), /Nothing to send/);
  console.log('PASS O264 r4 send-not-stop: B\'s Send on a photo another tab sent stopped nothing and sent nothing');
});
