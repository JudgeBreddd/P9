import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDaemon } from './helpers.mjs';
import { phone, seedChat, openChat } from './phone-c16-helpers.mjs';

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
  assert.equal(await page.evaluate(() => localStorage.getItem('p9-attached-sent')), null, 'the record of the sent files is forgotten once the store has dropped them');
  // A new file after that is kept as before.
  await page.setInputFiles('#attachInput', [FILES[1]]);
  assert.deepEqual(await settled(page, 1), { chips: 1, stored: 1 }, 'a file attached after the reload is kept');
  console.log('PASS O264: refused send kept 2 files through a reload; accepted send with the store write blocked left 0 chips and 0 stored after a reload');
});
