// An agent program's own warning (codex-acp sends one as a whole reply chunk "Warning: ...\n\n") is a small grey line
// above the reply, not the agent's words; its "i" opens what it means (the owner, 2026-10-29). Desktop on the real daemon
// and the fake agent; phone on the same events seeded into the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron } from '@playwright/test';
import { daemon, remoteDaemon, http, authenticated, root } from './helpers.mjs';
import { phone, CHAT, seedChat, openChat } from './phone-c16-helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const WS = 'Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response.completed';
const REPLY = 'Glad she turned out just how you wanted!';
const KNOWN = 'The connection to OpenAI dropped mid-reply. Codex retried another way and the reply came through. Nothing to do; if it shows on every message, OpenAI is having trouble.';
const GENERIC = "The agent's program printed this warning. Your reply is not affected unless the reply itself says so.";
const shot = (name, png) => { if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + png.toString('base64')); };
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => JSON.parse(result.text));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 200))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
// What the chat shows: the reply bubbles' text, and each warning line with what its "i" opens (after a click).
const read = (page, bubble) => page.evaluate((bubble) => ({
  replies: [...document.querySelectorAll(bubble)].map((b) => b.innerText.replace(/^Codex\n/, '').trim()),
  warns: [...document.querySelectorAll('details.agent-warn')].map((d) => ({ line: d.querySelector('summary').innerText.replace(/\s+/g, ' ').trim(), open: d.open,
    say: d.open ? d.querySelector('p').innerText : null, raw: d.open ? d.querySelector('code')?.innerText ?? null : null })),
  above: (() => { const w = document.querySelector('details.agent-warn'), b = [...document.querySelectorAll(bubble)].at(-1); return !!w && !!b && !!(w.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); })(),
}), bubble);
const opened = async (page) => { for (const s of await page.locator('details.agent-warn summary').all()) await s.click(); };
const WANT = { replies: [REPLY], above: true, warns: [
  { line: 'Connection dropped · Codex retried i', open: true, say: KNOWN, raw: null },
  { line: 'Warning: Some new thing the agent program says i', open: true, say: GENERIC, raw: 'Some new thing the agent program says' }] };

test('Agent warnings, desktop: a grey line above the reply, not in it; its i says what it means', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const id = (await call(instance, '/chat', 'POST', { provider: 'codex' })).conversation;
  await call(instance, '/chat/' + id + '/prompt', 'POST', { text: 'codex warning' });
  await until(async () => (await call(instance, '/chat/events?after=0&only=' + id)).events.some((e) => e.type === 'turn-end'), 'the turn ends');
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-warn-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.locator('#dataNote', { hasText: 'Chat live' }).waitFor({ timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900));
  await page.locator('#tabs .tab[data-id="' + id + '"]').click();
  await page.locator('.msg.agent', { hasText: REPLY }).waitFor({ timeout: 15000 });
  await opened(page);
  assert.deepEqual(await read(page, '.msg.agent'), WANT);
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, theme !== 'daylight', { timeout: 5000 });
    // builder-look.css painted the chat history black in every theme: in a light one the reply read dark on black.
    if (theme === 'daylight') assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#chats .hist')).backgroundColor), 'rgb(0, 0, 0)', 'the Daylight chat is black');
    shot('agent-warning-desktop-' + theme, await page.screenshot({ animations: 'disabled' }));
  }
  console.log('PASS agent warning desktop');
});

test('Agent warnings, phone: a grey line above the reply, not in it; its i says what it means', { timeout: 120000 }, async (t) => {
  const server = await remoteDaemon(t, {});
  seedChat(server);
  const d = new DatabaseSync(path.join(server.directory, '.local', 'state', 'p9-foundation', 'p9.db')), now = Date.now();
  const chunk = (text) => d.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(CHAT, 'update', JSON.stringify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }), now);
  d.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(CHAT, 'user', JSON.stringify({ text: 'She came out great' }), now);
  chunk('Warning: ' + WS + '\n\n'); chunk('Warning: Some new thing the agent program says\n\n'); chunk(REPLY);
  d.close();
  const { page } = await phone(t, server);
  await openChat(page, server);
  await page.locator('#events [data-kind=agent]', { hasText: REPLY }).waitFor({ timeout: 15000 });
  await opened(page);
  assert.deepEqual(await read(page, '#events [data-kind=agent]'), WANT);
  shot('agent-warning-phone', await page.screenshot());
  console.log('PASS agent warning phone');
});
