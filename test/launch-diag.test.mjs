import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { _electron } from '@playwright/test';
import { xState } from '../scripts/launch-diag.mjs';

// O58 diagnostic: CI has had Electron fail to start with "Missing X server or $DISPLAY" and no cause in the log. Under
// with-tmp.mjs (CI, the dev space) a failed _electron.launch now prints the X state, then throws the same error.
const said = (t) => { const lines = []; t.mock.method(console, 'error', (...a) => lines.push(a.join(' '))); return () => lines.join('\n'); };

test('O58 diagnostic: a failed electron launch prints DISPLAY, the X sockets and an xdpyinfo exit, then throws its own error', { skip: process.platform !== 'linux', timeout: 30000 }, async (t) => {
  const out = said(t);
  const env = { ...process.env, DISPLAY: ':4242' };
  await assert.rejects(_electron.launch({ executablePath: '/nonexistent/o58-electron', args: ['x'], env, timeout: 10000 }), /o58-electron|Failed to launch/);
  const text = out();
  assert.match(text, /O58 launch-diag: electron\.launch failed/, 'no diagnostic printed: ' + text);
  assert.match(text, /DISPLAY=:4242 \(this process: /, 'the DISPLAY the launch got is missing');
  assert.match(text, /ls -la \/tmp\/\.X11-unix \(exit \d+\):/);
  // :4242 has no server: xdpyinfo cannot exit 0 (CI installs x11-utils; the dev space has none, so ENOENT there), and the
  // socket connect fails with the reason.
  assert.match(text, /xdpyinfo exit [^0\s]/, text);
  assert.match(text, /socket \/tmp\/\.X11-unix\/X<n> for that DISPLAY: ENOENT/, text);
});

test('O58 diagnostic: a launch that works prints nothing and returns the app', { skip: process.platform !== 'linux', timeout: 60000 }, async (t) => {
  const out = said(t);
  const main = path.join(await mkdtemp(path.join(os.tmpdir(), 'o58-diag-')), 'main.cjs');
  await writeFile(main, "require('electron').app.whenReady().then(() => {});\n");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [main], env, timeout: 20000 });
  assert.equal(typeof await app.evaluate(({ app }) => app.getName()), 'string');
  await app.close();
  assert.doesNotMatch(out(), /launch-diag/);
});

test('O58 diagnostic: on the live display the socket line says connected', { skip: process.platform !== 'linux' || !process.env.DISPLAY }, async () => {
  assert.match(await xState(), /socket \/tmp\/\.X11-unix\/X<n> for that DISPLAY: connected/);
});
