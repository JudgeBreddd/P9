// Steering with the real adapters, not the fake (2026-10-24): does P9's own initialize get _meta.steering, and is
// _session/steering routed? claude-agent-acp 0.88 hides steering on its ACP v2 surface, so this proves which one P9 gets.
// No session and no model call: a temp HOME (no login), and an unknown session for the steering call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { adapterEntry, clientCapabilities } from '../apps/server/chat.mjs';
import { launchTree, endTree } from '../apps/server/process-tree.mjs';

for (const provider of ['claude', 'codex']) {
  test('real ' + provider + ' adapter: P9\'s initialize gets _meta.steering, and _session/steering is routed', { timeout: 60000 }, async (t) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'p9-steer-'));
    process.env.HOME = home; // launchTree passes childEnv(), which reads HOME from here
    const tree = launchTree([process.execPath, adapterEntry(provider)], home);
    t.after(() => endTree(tree));
    let stderr = '';
    tree.child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const agent = new acp.ClientSideConnection(() => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      createElicitation: async () => ({ action: 'cancel' }) }), acp.ndJsonStream(Writable.toWeb(tree.child.stdin), Readable.toWeb(tree.child.stdout)));
    const timeout = (what) => new Promise((resolve, reject) => setTimeout(() => reject(new Error(what + ' timed out; stderr: ' + stderr)), 30000));
    // The same call as chat.mjs connect().
    const init = await Promise.race([agent.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities }), timeout('initialize')]);
    console.log('REAL ' + provider + ' initialize: ' + JSON.stringify({ protocolVersion: init.protocolVersion, agent: init.agentInfo, meta: init._meta }));
    assert.equal(init._meta?.steering?.supported === true, true, 'steering advertised to P9 (chat.mjs reads exactly this)');
    // Routed: an unknown session is refused by the steering handler, not with method-not-found (-32601). Claude throws
    // "Session not found"; Codex catches it and answers { outcome: 'failed' }, which chat.mjs steer() turns into a 409.
    const { result, error } = await Promise.race([agent.request('_session/steering', { sessionId: 'p9-no-such-session', prompt: [{ type: 'text', text: 'x' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } } }).then((result) => ({ result }), (error) => ({ error })), timeout('_session/steering')]);
    console.log('REAL ' + provider + ' _session/steering, unknown session: ' + JSON.stringify({ result, code: error?.code, message: error?.message, data: error?.data }));
    if (error) assert.notEqual(error.code, -32601, 'the method is routed');
    else assert.equal(result?.outcome, 'failed', 'an unknown session is refused');
    console.log('PASS real ' + provider + ': steering advertised to P9 on protocol ' + init.protocolVersion + ', _session/steering routed (' + (error ? error.code : result.outcome) + ')');
  });
}
