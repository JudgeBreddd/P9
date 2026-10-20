import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { remoteDaemon, passkeyDevice, enrollDevice } from './helpers.mjs';

function nonLoopback() {
  return Object.values(os.networkInterfaces()).flat().find((address) => address?.family === 'IPv4' && !address.internal)?.address;
}
function connect(address, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, address);
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
    socket.once('error', (error) => resolve(error.code));
  });
}

test('Phase 11 surface 2: raw port, proxy headers and hostile Origin are refused without data leaving', async (t) => {
  const server = await remoteDaemon(t);
  const address = nonLoopback();
  assert.ok(address, 'no non-loopback IPv4 address available');
  assert.equal(await connect(address, server.port), 'ECONNREFUSED');

  const forged = await server.remote('/files?path=note.txt', { headers: {
    'tailscale-user-login': 'builder@example.invalid', 'tailscale-user-name': 'Builder', 'x-forwarded-for': '100.64.0.1',
  } });
  assert.equal(forged.status, 401); assert.equal(forged.text.includes('original'), false);

  const browser = await chromium.launch(); t.after(() => browser.close());
  const auth = await enrollDevice(server, await passkeyDevice(browser, server, 'surface2'));
  const hostile = await server.remote('/files?path=note.txt', { method: 'PUT', session: auth,
    headers: { origin: 'https://hostile.example' }, body: { path: 'note.txt', hash: '0'.repeat(64), content: 'stolen' } });
  assert.equal(hostile.status, 403); assert.equal(hostile.text.includes('original'), false);
  assert.equal(await readFile(server.workspace + '/note.txt', 'utf8'), 'original');
  console.log('PASS phase11 surface 2: non-loopback TCP refused; forged Tailscale identity 401; hostile Origin 403; file unchanged and no content leaked');
});
