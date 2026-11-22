// CAT-1b: how an agent signs in is catalog data (signIn.kind), not its id. A device-code sign-in's one-time code is read
// from the login's output for any agent of that kind; a browser sign-in never yields one.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as agents from '../apps/server/agents.mjs';
import * as chat from '../apps/server/chat.mjs';

// Namespace imports, so the asserts (not a missing export) are what fail on code without these.
const KIND = agents.SIGN_IN_KIND ?? {}, FLAG = agents.SIGN_IN_FLAG ?? {}, loginRead = chat.loginRead ?? (() => ({ url: null, code: null }));
const PAGE = 'https://auth.example.test/codex/device';
const output = '\x1b[1mWelcome\x1b[0m\nOpen this page: ' + PAGE + '\nand enter the code \x1b[94mWXYZ-12345\x1b[0m (it expires in 15 minutes)\n';

test('sign-in kind: the catalog says browser for claude and device-code for codex', () => {
  assert.deepEqual(agents.CATALOG.map((a) => [a.id, KIND[a.id]]), [['claude', 'browser'], ['codex', 'device-code']]);
  assert.ok(Object.isFrozen(KIND));
  // The flag the unsupported check looks for is the one the login is started with.
  assert.deepEqual(agents.CATALOG.map((a) => [a.id, FLAG[a.id]]), [['claude', null], ['codex', '--device-auth']]);
  for (const a of agents.CATALOG) if (FLAG[a.id]) assert.ok(agents.LOGIN[a.id].includes(FLAG[a.id]), a.id);
});

test('sign-in kind: the one-time code is read by kind, for any agent of that kind', () => {
  assert.deepEqual(loginRead('device-code', output), { url: PAGE, code: 'WXYZ-12345' });
  assert.deepEqual(loginRead('browser', output), { url: PAGE, code: null }, 'a browser sign-in never gets a code');
  assert.deepEqual(loginRead(undefined, output), { url: PAGE, code: null }, 'an agent with no kind gets no code');
  assert.deepEqual(loginRead('device-code', 'code ABCD-1234 first, then ' + PAGE + ' and nothing'), { url: PAGE, code: null }, 'only a code after the page');
  assert.deepEqual(loginRead('device-code', 'enter ABCD-1234 at http://plain.example.test/x'), { url: null, code: null }, 'no https page, no code');
  assert.deepEqual(loginRead('device-code', 'Open ' + PAGE + ' and wait'), { url: PAGE, code: null }, 'the page before its code arrives');
  console.log('PASS device-code reads the code after the page; browser never does');
});
