// O267 round 3: the operation ledger kept a turn-running refusal as the operation's answer and replayed it to every retry
// under the same ID, so a phone's queued message (its ID kept across tries) never went once the turn ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { openLedger, operations } from '../apps/server/ledger.mjs';

test('O267: a turn-running refusal is not replayed; the retry under the same ID runs, and its answer is', async () => {
  const { Hono } = await import('hono');
  const ledger = openLedger(path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-ops-')), 'ledger.db'));
  let busy = true, ran = 0;
  const app = new Hono().use('*', operations(ledger, 'desktop'))
    .post('/prompt', (c) => { ran++; return busy ? c.json({ error: 'turn-running' }, 409) : c.json({ held: 'h1' }, 202); })
    .post('/other', (c) => { ran++; return c.json({ error: 'chat-stopped' }, 409); });
  const send = (route, op) => app.request(route, { method: 'POST', headers: { 'x-p9-op': op, 'content-type': 'application/json' }, body: '{"text":"hi"}' });
  const op = randomUUID();
  assert.equal((await send('/prompt', op)).status, 409);
  busy = false;
  const retry = await send('/prompt', op);
  assert.deepEqual([retry.status, retry.headers.get('x-p9-replayed'), ran], [202, null, 2], 'the retry ran, not a replay of the refusal');
  const again = await send('/prompt', op);
  assert.deepEqual([again.status, again.headers.get('x-p9-replayed'), ran], [202, '1', 2], 'the accepted answer is replayed, not run twice');
  // Any other refusal is final and replayed, as before.
  const other = randomUUID();
  await send('/other', other);
  const replayed = await send('/other', other);
  assert.deepEqual([replayed.status, replayed.headers.get('x-p9-replayed'), ran], [409, '1', 3]);
});
