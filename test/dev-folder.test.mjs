import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serverPath, folderError } from '../apps/desktop/dev-folder.mjs';

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
  assert.match(folderError('daemon-unavailable', true), /server/);
  assert.doesNotMatch(folderError('daemon-unavailable', false), /server/);
  assert.match(folderError('inside-workspace', true), /\(inside-workspace\)/, 'an unknown reason is still named');
});
