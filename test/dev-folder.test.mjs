import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serverPath, folderError, trusted, setTrust } from '../apps/desktop/dev-folder.mjs';

// Dev Focus Open Folder in Server mode (threat model rows 41/50 adds): main asks for the server path instead of refusing, checks
// it with the server's rules, and every refusal names its own reason.
test('Dev Focus Open Folder in Server mode: a typed server path, the server\'s real path decides inside or outside, and the real reason on a refusal', { timeout: 10000 }, async () => {
  const main = await readFile(new URL('../apps/desktop/main.mjs', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('p9dev:open-folder'"), main.indexOf('setTimeout(reopenDev)', main.indexOf("ipcMain.handle('p9dev:open-folder'")));
  assert.doesNotMatch(handler, /serverHost\) return \{ error: 'daemon-unavailable' \}/, 'Server mode is not refused as daemon-unavailable');
  assert.match(handler, /pathNeeded: true/, 'Server mode asks the page for the server path');
  assert.match(handler, /serverPath\(args\[0\]\)/);
  assert.match(handler, /\{ path: typed\.real, check: true \}/, 'inside or outside is the server\'s answer on the real path');

  assert.deepEqual(serverPath('/srv/work/src/'), { real: '/srv/work/src' });
  assert.deepEqual(serverPath(' /srv/work '), { real: '/srv/work' });
  assert.deepEqual(serverPath('/srv/work/../other/./x'), { real: '/srv/other/x' });
  assert.equal(serverPath('/srv/work/src/../../../etc').real, '/etc');
  for (const bad of ['srv/work', 'C:\\work', '~/work']) assert.deepEqual(serverPath(bad), { error: 'path-not-absolute' });
  for (const bad of ['', '  ', null, 7, '/a\0b', '/' + 'a'.repeat(4096)]) assert.deepEqual(serverPath(bad), { error: 'request-refused' });

  const words = ['root-refused', 'root-not-found', 'path-not-absolute', 'request-refused', 'daemon-unavailable', 'daemon-outdated'].map(e => folderError(e, true));
  assert.equal(new Set(words).size, words.length, 'each reason has its own words');
  assert.match(folderError('root-not-found', true), /on the server/);
  assert.match(folderError('root-refused', true), /Turn on Unrestricted mode in Settings on the server to open it/, 'v0.1.6 U1: the refusal says how to open home');
  assert.match(folderError('daemon-unavailable', true), /server/);
  assert.doesNotMatch(folderError('daemon-unavailable', false), /server/);
  assert.match(folderError('inside-workspace', true), /\(inside-workspace\)/, 'an unknown reason is still named');
});

// v0.1.6 U2 (threat model row 41): outside the workspace, Unrestricted mode asks "Trust this folder?" with a "Don't ask again"
// box, kept as one global flag and honoured only while the mode is on; with it off, the old confirm, word for word.
test('U2: Trust this folder? with Don\'t ask again, only in Unrestricted mode', { timeout: 10000 }, async () => {
  const main = await readFile(new URL('../apps/desktop/main.mjs', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('p9dev:open-folder'"), main.indexOf('setTimeout(reopenDev)', main.indexOf("ipcMain.handle('p9dev:open-folder'")));
  assert.match(main, /const looseNow = async \(\) => \{[^]*?'\/agent-lock'[^]*?'\/file-protection'[^]*?lock\?\.body\?\.on === false && files\?\.body\?\.on === false/);
  assert.match(handler, /const loose = await looseNow\(\);\s*if \(!\(loose && await trustAll\(\)\)\)/, 'the flag skips the ask only while the mode is on');
  assert.match(handler, /loose\s*\? \{ type: 'question', title: 'Trust this folder\?'[^}]*checkboxLabel: 'Don\\'t ask again'/);
  assert.match(handler, /: \{ type: 'warning', title: 'Open a folder outside the workspace\?'/, 'mode off: the old confirm');
  assert.match(handler, /if \(loose && checkboxChecked\) await trust\(true\);/);
  assert.match(main, /const loose = lock\?\.body\?\.on === false && files\?\.body\?\.on === false;\s*if \(!loose\) await trust\(false\);/, 'L4: the mode off drops the flag');
  // L4: per place; mode off drops only that place; the old global flag trusts nowhere.
  let file = setTrust('', 'local', true);
  assert.deepEqual([trusted(file, 'local'), trusted(file, 'server-a')], [true, false]);
  file = setTrust(file, 'server-a', true);
  assert.equal(setTrust(file, 'server-a', true), null, 'no change, no write');
  file = setTrust(file, 'local', false);
  assert.deepEqual([trusted(file, 'local'), trusted(file, 'server-a')], [false, true]);
  assert.equal(trusted(JSON.stringify({ trustOutside: true }), 'local'), false);
  assert.equal(trusted('not json', 'local'), false);
  const picker = main.slice(main.indexOf("ipcMain.handle('p9:pick-folder'"), main.indexOf("ipcMain.handle('p9:pick-vault'"));
  assert.match(picker, /return real && !args\.length && await looseNow\(\) \? real : null;/, 'U4: an outside chat folder only in the mode, only for a new chat');
  console.log('PASS U2: Trust this folder? with Don\'t ask again in the mode, the old confirm without it; U4 picker gated the same way');
});
