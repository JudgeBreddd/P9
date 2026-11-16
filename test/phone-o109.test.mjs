import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remoteDaemon } from './helpers.mjs';
import { phone } from './phone-c16-helpers.mjs';

const BUSY = '00000000-0000-4000-8000-000000010901', QUEUED = 30;
const shot = async (page, name) => { const png = await page.screenshot({ type: 'png' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };

// A busy coordinated chat, as Tyler's lead chat on 2026-11-15: a turn running a long tool step, 30 messages waiting for
// it (plus one already delivered), a sprint card and a worker report pinned.
function seed(server) {
  const db = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db'));
  db.prepare('INSERT INTO conversations (id, provider, title, state, created) VALUES (?, ?, ?, ?, ?)').run(BUSY, 'claude', 'Busy lead', 'idle', Date.now());
  const event = db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)'), at = Date.now();
  const add = (type, data) => event.run(BUSY, type, JSON.stringify(data), at);
  add('card', { id: 'sprint', kind: 'note', text: 'SPRINT: 7 workers' });
  add('card', { id: 'ready-6b1f4c1e-2f1a-4c55-9a43-1f0e2d3c4b5a', kind: 'note', text: 'Worker report: PRs #103 #100 #101 #102' });
  add('user', { text: 'Run the sprint' });
  add('update', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read the queue', status: 'completed' });
  add('update', { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Waiting on worker phone', status: 'in_progress' });
  add('held', { id: 'h-delivered', text: 'already delivered', when: 'queue' });
  add('user', { text: 'already delivered', steered: true, held: ['h-delivered'] });
  for (let i = 0; i < QUEUED; i++) add('held', { id: 'h' + i, text: `[p9] worker ${i} ended its turn and has a long note that runs past the width of a phone`, when: 'queue' });
  db.close();
  return (type, data) => { const again = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db')); again.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(BUSY, type, JSON.stringify(data), Date.now()); again.close(); };
}

// The composer is on screen when its whole box is inside the viewport and nothing is drawn over its middle.
const composerOnScreen = (page) => page.evaluate(() => {
  const box = document.querySelector('#prompt'), r = box.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight, inside: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight, hit: hit === box };
});

test('O109 phone: a busy chat keeps its composer on screen; queued messages are one strip; the worker card closes; the step shows', { timeout: 180000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  const more = seed(server);
  const { page } = await phone(t, server);
  await page.evaluate((id) => history.replaceState(null, '', '#chat=' + id), BUSY);
  await page.reload();
  await page.waitForFunction(() => /Waiting on worker phone/.test(document.querySelector('#events')?.textContent ?? ''), null, { timeout: 30000 });
  await page.waitForSelector('#queued:not([hidden])', { timeout: 15000 });
  await shot(page, 'o109-phone-busy');

  // (1) The composer is on screen and takes focus.
  const seen = await composerOnScreen(page);
  assert.ok(seen.inside && seen.hit, 'the composer is on screen with 30 queued: ' + JSON.stringify(seen));
  await page.focus('#prompt');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'prompt', 'the composer takes focus');

  // (2) One compact strip says how many wait; a delivered message is not among them; each row has its own remove.
  const strip = await page.evaluate(() => ({ text: document.querySelector('#queued summary')?.textContent ?? '', rows: [...document.querySelectorAll('#queued article')].filter((row) => row.checkVisibility()).length, height: Math.round(document.querySelector('#queued').getBoundingClientRect().height) }));
  assert.match(strip.text, new RegExp('^' + QUEUED + ' queued'), 'one strip names the count: ' + JSON.stringify(strip));
  assert.equal(strip.rows, 0, 'the rows are folded away until asked for');
  assert.ok(strip.height <= 60, 'the strip is one line: ' + strip.height + ' px');
  assert.doesNotMatch(await page.textContent('#queued'), /already delivered/, 'a delivered message is never still queued');
  await page.click('#queued summary');
  assert.equal(await page.locator('#queued article:visible').count(), QUEUED);
  assert.equal(await page.locator('#queued article [data-unhold]').count(), QUEUED, 'each queued message has its own remove');
  const take = await page.evaluate(() => { const r = document.querySelector('#queued article [data-unhold]').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: innerWidth }; });
  assert.ok(take.right <= take.width && take.left >= 0, 'Take back is on screen, not past the right edge: ' + JSON.stringify(take));
  const open = await composerOnScreen(page);
  assert.ok(open.inside && open.hit, 'the composer stays on screen with the strip open: ' + JSON.stringify(open));
  await shot(page, 'o109-phone-strip-open');
  const shotOpen = await composerOnScreen(page);
  assert.ok(shotOpen.inside && shotOpen.hit, 'the composer is still on screen after the open-strip screenshot: ' + JSON.stringify(shotOpen));
  await page.click('#queued summary');

  // (4) The long turn's step is shown over the box, without scrolling.
  await page.evaluate(() => { document.querySelector('#chatBody').scrollTop = 0; });
  const step = page.locator('#nowStep');
  await step.waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await step.textContent(), /Waiting on worker phone/);

  // (3) The pinned worker report can be closed, stays closed after a reload, and comes back when a new card arrives.
  await page.waitForSelector('#chips [data-chip-close]', { timeout: 5000 });
  await page.click('#chips [data-chip-close]');
  await page.waitForFunction(() => !/pinned/.test(document.querySelector('#chips')?.textContent ?? ''), null, { timeout: 5000 });
  await page.reload();
  await page.waitForSelector('#queued:not([hidden])', { timeout: 30000 });
  assert.doesNotMatch(await page.textContent('#chips'), /pinned/, 'closed stays closed');
  const reloaded = await composerOnScreen(page);
  assert.ok(reloaded.inside && reloaded.hit, 'the composer is on screen after a reload: ' + JSON.stringify(reloaded));
  // The same card sent again, unchanged, is not new: the chip stays closed (the desktop's report order must not leak into the phone's cards).
  more('card', { id: 'sprint', kind: 'note', text: 'SPRINT: 7 workers' });
  await page.reload();
  await page.waitForSelector('#queued:not([hidden])', { timeout: 30000 });
  assert.doesNotMatch(await page.textContent('#chips'), /pinned/, 'an unchanged card sent again reopened the closed chip');
  more('card', { id: 'ready-0d4c1e2f-1a4c-4559-a431-f0e2d3c4b5a6', kind: 'note', text: 'Worker report: PR #177' });
  await page.reload();
  // O712: only the newest worker report is pinned (the desktop's rule), so the sprint card and the new report: 2.
  await page.waitForFunction(() => /2 pinned/.test(document.querySelector('#chips')?.textContent ?? ''), null, { timeout: 30000 });
  await shot(page, 'o109-phone-card-back');
  const back = await composerOnScreen(page);
  assert.ok(back.inside && back.hit, 'the composer is on screen when the pinned card comes back: ' + JSON.stringify(back));

  // (5) O712: the worker report itself closes on the phone, as on the desktop: the sheet shows the newest report with a ×;
  // closing it leaves the sprint card, stays closed after a reload, and the same worker's next report comes back.
  // Reports in the chat: every one except the one pinned above the box (it is not drawn twice).
  const chatReports = () => page.evaluate(() => [...document.querySelectorAll('#events article[data-kind="report"]')].filter((row) => row.checkVisibility()).map((row) => row.textContent));
  let rows = await chatReports();
  assert.ok(rows.some((text) => /PRs #103/.test(text)), 'the older report is still readable in the chat after a newer one: ' + JSON.stringify(rows));
  assert.ok(!rows.some((text) => /PR #177/.test(text)), 'the pinned report is not drawn twice: ' + JSON.stringify(rows));
  const sheetCards = () => page.evaluate(() => ({ text: document.querySelector('#sheetBody')?.textContent ?? '', close: document.querySelectorAll('#sheetBody [data-card-close]').length, cards: document.querySelectorAll('#sheetBody [data-card]').length }));
  await page.click('#chips [data-chip]');
  let seenSheet = await sheetCards();
  assert.equal(seenSheet.close, 1, 'the newest worker report has its own close: ' + JSON.stringify(seenSheet));
  assert.match(seenSheet.text, /PR #177/); assert.doesNotMatch(seenSheet.text, /PRs #103/, 'an older report is not pinned');
  await page.evaluate(() => Promise.all(document.querySelector('#sheet').getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished))); // the sheet has slid in
  await shot(page, 'o712-phone-report-close');
  await page.click('#sheetBody [data-card-close]');
  await page.waitForFunction(() => !/Worker report/.test(document.querySelector('#sheetBody')?.textContent ?? ''), null, { timeout: 5000 });
  seenSheet = await sheetCards();
  assert.match(seenSheet.text, /SPRINT: 7 workers/, 'the other card stays: ' + JSON.stringify(seenSheet));
  assert.match(await page.textContent('#chips'), /1 pinned/);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('#queued:not([hidden])', { timeout: 30000 });
  await page.waitForFunction(() => /1 pinned/.test(document.querySelector('#chips')?.textContent ?? ''), null, { timeout: 30000 });
  rows = await chatReports();
  assert.ok(rows.some((text) => /PR #177/.test(text)) && rows.some((text) => /PRs #103/.test(text)), 'a closed report is readable in the chat after a reload: ' + JSON.stringify(rows));
  await shot(page, 'o712-phone-report-in-chat');
  const shutAfter = await composerOnScreen(page);
  assert.ok(shutAfter.inside && shutAfter.hit, 'the composer is on screen with the report closed: ' + JSON.stringify(shutAfter));
  more('card', { id: 'ready-0d4c1e2f-1a4c-4559-a431-f0e2d3c4b5a6', kind: 'note', text: 'Worker report: PR #177 merged' });
  await page.reload();
  await page.waitForFunction(() => /2 pinned/.test(document.querySelector('#chips')?.textContent ?? ''), null, { timeout: 30000 });
  await page.click('#chips [data-chip]');
  seenSheet = await sheetCards();
  assert.match(seenSheet.text, /PR #177 merged/, 'the worker\'s next report is pinned again: ' + JSON.stringify(seenSheet));
  assert.equal(seenSheet.close, 1);
  await page.keyboard.press('Escape');
  rows = await chatReports();
  assert.ok(rows.some((text) => /PR #177$/.test(text.trim())) && !rows.some((text) => /PR #177 merged/.test(text)), 'the worker\'s earlier report stays in the chat, its pinned next one is not drawn twice: ' + JSON.stringify(rows));
  const reopened = await composerOnScreen(page);
  assert.ok(reopened.inside && reopened.hit, 'the composer is on screen after the next report: ' + JSON.stringify(reopened));
});
