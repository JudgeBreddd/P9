// PD-1 (h): wait_chat (delegate.mjs) waits with chat.changed(ms, id). It wakes at an event of the chat it waits on, not
// at every event of every chat; left out, id still means any chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { openLedger } from '../apps/server/ledger.mjs';
import { createChat } from '../apps/server/chat.mjs';
import { createLifecycle } from '../apps/server/lifecycle.mjs';

test('chat.changed(ms, id) wakes at that chat\'s event, not at another chat\'s; with no id, at any chat\'s', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-chat-changed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = openLedger(path.join(dir, 'ledger.db'));
  const chat = createChat({ ledger, workspace: dir, adapterOverride: path.join(import.meta.dirname, 'fake-acp-agent.mjs'),
    instance: 'changed-' + process.pid, lifecycle: createLifecycle() });
  t.after(() => chat.shutdown());
  const [a, b] = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  for (const id of [a, b]) ledger.db.prepare("INSERT INTO conversations (id, provider, title, state, created) VALUES (?, 'claude', ?, 'idle', ?)").run(id, id, Date.now());
  // 'woke' if the wait resolved within 300 ms (its own limit is 5 s), else 'waiting'.
  const within = (wait) => Promise.race([wait.then(() => 'woke'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 300))]);

  const onA = chat.changed(5000, a);
  chat.unpin(b, 'card-1');
  assert.equal(await within(onA), 'waiting', 'an event of another chat woke a wait on chat a');
  chat.unpin(a, 'card-1');
  assert.equal(await within(onA), 'woke', 'an event of chat a did not wake a wait on it');
  const any = chat.changed(5000);
  chat.unpin(b, 'card-2');
  assert.equal(await within(any), 'woke', 'a wait with no chat did not wake at an event');
});
