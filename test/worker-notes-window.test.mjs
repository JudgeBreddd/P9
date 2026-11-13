// Sprint spec D4: a worker's notes show in its chat window. A Notes button in the header of a chat that has a parent opens
// the notes file as it is now, read-only, in the side area; a chat with no parent has no button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const NOTES = ['## Now', 'Doing: part 2, the Notes button', 'Next: tests', 'Blocked on: nothing', 'Not yet checked: CI', '', '## Log', '- read the adapters; both send a tool call, not compaction_update'];

test('Worker notes: the header of a worker chat has a Notes button that reads its notes file each time it opens; a lead chat has none', { timeout: 120000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-worker-notes-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, timeout: 15000 });
  t.after(() => app.close());
  const page = await app.firstWindow({ timeout: 15000 });
  page.on('pageerror', e => console.log('PAGEERROR ' + e.message));
  await page.locator('#cards .card').first().waitFor({ timeout: 15000 });
  await page.addStyleTag({ content: '#toasts{display:none!important}' }); // the sample notifications sit where the notes open
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await app.evaluate(({ ipcMain }) => {
    const f = globalThis.__fake = { convs: [], events: [], cursor: 0, reads: [], text: '' };
    ipcMain.removeHandler('p9:chat');
    ipcMain.handle('p9:chat', async (_e, action, payload = {}) => {
      if (action === 'list') return { status: 200, body: { conversations: f.convs.map(c => ({ ...c })), lists: {} } };
      if (action === 'profiles') return { status: 200, body: { profiles: [] } };
      if (action === 'notes') { f.reads.push(payload.id); return { status: 200, body: { name: 'notes/w-1.md', text: f.text } }; }
      if (action === 'events') {
        const after = Number(payload.after) || 0, take = () => f.events.filter(e => e.cursor > after);
        for (let i = 0; i < 30 && payload.wait && !take().length; i++) await new Promise(r => setTimeout(r, 100));
        return { status: 200, body: { events: take(), cursor: f.cursor, more: false } };
      }
      return { status: 404, body: {} };
    });
  });
  const now = Date.now();
  const conv = (id, over = {}) => ({ id, provider: 'claude', title: id, folder: '~', created: now - 1000, state: 'running', sent: 0, used: now, project: null, archived: false, parent: null, ...over });
  const send = (convs) => app.evaluate((_, [convs, text]) => { const f = globalThis.__fake; f.convs = convs; f.text = text;
    for (const c of convs.filter(c => !f.made?.includes(c.id))) { (f.made ??= []).push(c.id);
      f.events.push({ type: 'created', conversation: c.id, data: { provider: 'claude', title: c.title, folder: '~', ...(c.parent && { parent: c.parent }) }, at: Date.now(), cursor: ++f.cursor }, { type: 'connected', conversation: c.id, data: { session: 's-' + c.id }, at: Date.now(), cursor: ++f.cursor }); } },
  [convs, NOTES.join('\n')]);
  const lead = conv('lead-1', { title: 'Lead' });
  await send([lead]);
  await page.reload();
  await page.locator('.pane[data-id="lead-1"]').waitFor({ timeout: 15000 });
  await send([lead, conv('w-1', { title: 'Builder', parent: 'lead-1' })]);
  assert.equal(await page.locator('.pane[data-id="lead-1"] [data-notes]').count(), 0, 'a Notes button on a chat that is not a worker');
  await page.locator('#navList .row[data-chat="w-1"]').click({ timeout: 15000 }); // the list reaches the page from the daemon: wait for the row
  const button = page.locator('.pane[data-id="w-1"] [data-notes]');
  await button.waitFor({ timeout: 15000 });
  await button.click();
  const text = page.locator('[data-notes-text]');
  await text.waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('[data-notes-text]')?.textContent.includes('Doing: part 2'), null, { timeout: 5000 });
  assert.equal(await text.textContent(), NOTES.join('\n'));
  assert.equal(await text.evaluate(e => e.isContentEditable || e.tagName), 'PRE', 'read-only plain text');
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  await page.waitForTimeout(500);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT worker-notes-open ' + png);
  // Closed and opened again: read again, so a change since shows.
  await button.click();
  await text.waitFor({ state: 'detached', timeout: 5000 });
  await app.evaluate(() => { globalThis.__fake.text = '## Now\nDoing: something else'; });
  await button.click();
  await page.waitForFunction(() => document.querySelector('[data-notes-text]')?.textContent === '## Now\nDoing: something else', null, { timeout: 5000 });
  assert.deepEqual(await app.evaluate(() => globalThis.__fake.reads), ['w-1', 'w-1']);
});
