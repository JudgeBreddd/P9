import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';

const replay = path.join(root, 'test/acp-replay.mjs');
const contracts = await readFile(path.join(root, 'contracts.md'), 'utf8');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const pinned = (name) => contracts.match(new RegExp('\\| `' + name.replace(/[/.]/g, '\\$&') + '` \\| ([^ |]+) \\|'))?.[1];
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ ...r, body: JSON.parse(r.text) }));

for (const provider of ['claude', 'codex']) {
  test(`${provider} fixture: version matches contracts.md and package.json, and the recorded turn replays through P9`, async (t) => {
    const fixture = JSON.parse(await readFile(path.join(root, `test/fixtures/acp/${provider}.json`), 'utf8'));
    assert.equal(fixture.version, pinned(fixture.package), `fixture captured against ${fixture.version}, contracts.md pins ${pinned(fixture.package)}`);
    assert.equal(pkg.dependencies[fixture.package], fixture.version, 'package.json pin differs from the fixture');
    const installed = JSON.parse(await readFile(path.join(root, 'node_modules', fixture.package, 'package.json'), 'utf8')).version;
    assert.equal(installed, fixture.version, 'installed adapter differs from the fixture');

    const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', replay] }));
    const created = await call(instance, '/chat', 'POST', { provider });
    assert.equal(created.status, 201, created.text);
    const id = created.body.conversation;
    const recordedPrompt = fixture.lines.find((l) => l.msg.method === 'session/prompt').msg.params.prompt[0].text;
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: recordedPrompt })).status, 202);
    const events = []; let after = 0;
    const until = async (type) => {
      for (let i = 0; i < 20 && !events.some((e) => e.type === type); i += 1) {
        const r = await call(instance, `/chat/events?after=${after}&wait=2000`);
        events.push(...r.body.events); after = r.body.cursor;
      }
      return events.find((e) => e.type === type);
    };
    const approval = await until('approval');
    assert.ok(approval, 'no approval replayed: ' + events.map((e) => e.type).join());
    const recordedAnswer = fixture.lines.find((l) => l.dir === 'in' && l.msg.result?.outcome).msg.result.outcome.optionId;
    assert.ok(approval.data.options.some((o) => o.optionId === recordedAnswer));
    assert.equal((await call(instance, `/chat/${id}/answer`, 'POST', { request: approval.data.request, answer: { optionId: recordedAnswer } })).status, 200);
    const end = await until('turn-end');
    assert.equal(end?.data.stopReason, 'end_turn', events.map((e) => e.type).join());
    const text = events.filter((e) => e.type === 'update' && e.data.sessionUpdate === 'agent_message_chunk').map((e) => e.data.content.text).join('');
    const recordedText = fixture.lines.filter((l) => l.msg.params?.update?.sessionUpdate === 'agent_message_chunk').map((l) => l.msg.params.update.content.text).join('');
    assert.equal(text, recordedText);
    assert.ok(text.length > 0);
  });
}
