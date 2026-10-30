// C3 and C4 (v0.1.3): the right-click menu's contents and the Windows full-name reader; both load without Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMenu, windowsFullName } from '../apps/desktop/native.mjs';

const shape = (items) => items.map((item) => item.role ?? item.label ?? item.type);

test('right-click: a text box gets Cut, Copy, Paste, Select All; misspellings add suggestions that replace the word', () => {
  assert.deepEqual(shape(contextMenu({ isEditable: true, selectionText: '', editFlags: {} })), ['cut', 'copy', 'paste', 'separator', 'selectAll']);
  const said = [];
  const menu = contextMenu({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten', 'tech', 'tee', 'tel'] }, (word) => said.push(['replace', word]), (word) => said.push(['learn', word]));
  assert.deepEqual(shape(menu), ['the', 'tea', 'ten', 'tech', 'tee', 'Add to dictionary', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
  menu[0].click(); menu[5].click();
  assert.deepEqual(said, [['replace', 'the'], ['learn', 'teh']]);
  assert.equal(contextMenu({ isEditable: true, editFlags: { canCut: false, canPaste: true } }).find((item) => item.role === 'cut').enabled, false);
});

test('right-click: selected page text gets Copy; the bare page gets no menu', () => {
  assert.deepEqual(shape(contextMenu({ isEditable: false, selectionText: 'some text' })), ['copy']);
  assert.deepEqual(contextMenu({ isEditable: false, selectionText: '' }), []);
});

test('Windows full name: read from net user; a blank or missing one gives the login-name fallback', () => {
  const out = (full) => `User name                    sam\r\nFull Name                    ${full}\r\nComment                      Built-in\r\n`;
  assert.equal(windowsFullName(out('Sam Rivera')), 'Sam Rivera');
  assert.equal(windowsFullName(out('')), '', 'a blank full name is not the next line');
  assert.equal(windowsFullName('The user name could not be found.'), '');
  assert.equal(windowsFullName(''), '');
});

// E3: Mission Control "Fix with Claude" and a first chat prompt wait for the agent to start (up to 45 s, chat.mjs START_MS); the
// other daemon calls keep 10 s. A slow daemon here answers after 400 ms, so a 100 ms limit fails and a 3 s limit succeeds.
test('daemonRequest: the timeout is the caller\'s; main.mjs gives only Fix and the chat prompt the agent-start wait', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const { daemonRequest, AGENT_START_MS } = await import('../scripts/teh.mjs');
  const state = await mkdtemp(path.join(os.tmpdir(), 'p9-teh-')), socketPath = path.join(state, 'slow.sock');
  await writeFile(path.join(state, 'desktop.json'), JSON.stringify({ cookie: 'c', csrf: 'x', socketPath }));
  const server = createServer((_req, res) => setTimeout(() => res.end('{"ok":true}'), 400));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  await assert.rejects(daemonRequest(state, 'GET', '/slow', undefined, undefined, 100), /timeout/);
  assert.deepEqual(await daemonRequest(state, 'GET', '/slow', undefined, undefined, 3000), { status: 200, body: { ok: true } });
  assert.ok(AGENT_START_MS >= 45_000 + 5_000 * 8, 'covers the 45 s start plus the mode, model and six effort settings');
  const main = await readFile(new URL('../apps/desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /action === 'fix' \? AGENT_START_MS/);
  assert.match(main, /action === 'prompt' \? AGENT_START_MS/);
  assert.equal(main.match(/AGENT_START_MS/g).length, 3, 'import plus the two routes; no other call gets the long wait');
});
