// Send to server (D14, threat model row 51): a Claude chat moves, between turns, from this computer's daemon to a server's.
// The window's half (the button, the moved pane) is in remote.test.mjs, which the dev space runs with Electron's sandbox.
// Two real daemons in throwaway homes, the stand-in ssh (test/fake-ssh.mjs) between them as in remote.test.mjs, and the fake
// agent with claude-home: it keeps a transcript where Claude Code does and resumes only a session whose transcript is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { sendToServer } from '../apps/desktop/move.mjs';

const skip = process.platform === 'win32' ? 'Unix sockets and sh; the move is the same code on Windows' : false;
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const markers = async ({ workspace }) => {
  for (const marker of ['uuid-sessions', 'claude-home']) await writeFile(path.join(workspace, marker), '');
  return { args: ['--acp-override', fake] };
};
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((result) => ({ status: result.status, ...(result.status === 404 ? {} : JSON.parse(result.text)) }));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (await check()) return;
  assert.fail('timed out: ' + what);
};
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).events;
const listed = async (instance, id) => (await call(instance, '/chat')).conversations.find((c) => c.id === id);
const said = async (instance, id) => (await events(instance, id)).filter((e) => e.type === 'update' && e.data.sessionUpdate === 'agent_message_chunk').map((e) => e.data.content.text);
async function turn(instance, id, text) {
  const ends = async () => (await events(instance, id)).filter((e) => e.type === 'turn-end').length, before = await ends();
  const sent = await call(instance, '/chat/' + id + '/prompt', 'POST', { text });
  assert.equal(sent.status, 202, JSON.stringify(sent));
  await until(async () => await ends() > before, text + ' answered');
}
async function chat(instance, ...texts) {
  const id = (await call(instance, '/chat', 'POST', { provider: 'claude' })).conversation;
  for (const text of texts) await turn(instance, id, text);
  return { id, session: (await events(instance, id)).find((e) => e.type === 'connected')?.data.session };
}
// The transcripts in a daemon's home, as claude-agent-acp finds them: <home>/.claude/projects/<any folder>/<session>.jsonl.
async function transcripts(instance, session) {
  const projects = path.join(instance.directory, '.claude', 'projects');
  const found = [];
  for (const folder of await readdir(projects).catch(() => [])) {
    const text = await readFile(path.join(projects, folder, session + '.jsonl'), 'utf8').catch(() => null);
    if (text !== null) found.push({ folder, text });
  }
  return found;
}

// The stand-in ssh reaching the server daemon (remote.test.mjs's stage, for one server).
async function pair(t) {
  const laptop = await daemon(t, undefined, false, markers), server = await daemon(t, undefined, false, markers);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'p9-move-'));
  const runtime = path.join(directory, 'server'), local = path.join(directory, 'local'), log = path.join(directory, 'ssh.log');
  await mkdir(runtime); await mkdir(local, { mode: 0o700 });
  await symlink(server.state, path.join(runtime, 'p9-foundation'));
  const ssh = path.join(directory, 'ssh'), q = (s) => "'" + s + "'";
  await writeFile(ssh, '#!/bin/sh\nFAKE_RUNTIME=' + q(runtime) + ' FAKE_SSH_LOG=' + q(log) + ' exec ' + q(process.execPath) + ' ' + q(path.join(root, 'test/fake-ssh.mjs')) + ' "$@"\n');
  await chmod(ssh, 0o755);
  const sshCalls = () => readFile(log, 'utf8').then((text) => text.trim().split('\n').length, () => 0);
  const move = (id, extra) => sendToServer({ local: laptop.state, id, host: 'test-host', ssh, runtime: local, ...extra });
  return { laptop, server, directory, ssh, local, sshCalls, move };
}

test('Send to server: refused while a turn runs, and nothing reaches the server', { skip, timeout: 60000 }, async (t) => {
  const { laptop, server, sshCalls, move } = await pair(t);
  const { id } = await chat(laptop, 'hello');
  await call(laptop, '/chat/' + id + '/prompt', 'POST', { text: 'slow' });
  await until(async () => (await said(laptop, id)).includes('working'), 'the slow turn started');
  const result = await move(id);
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(result.body.error, 'turn-running');
  assert.match(result.body.message, /Finish or stop the turn first/);
  // The turn runs on, untouched: not stopped, not frozen; the server has nothing and ssh never ran.
  assert.equal((await listed(laptop, id)).state, 'turn');
  assert.ok(!(await events(laptop, id)).some((e) => ['stopped', 'moving'].includes(e.type)));
  assert.equal(await listed(server, id), undefined);
  assert.equal(await sshCalls(), 0);
  await call(laptop, '/chat/' + id + '/cancel', 'POST');
  // A Codex chat cannot move yet, and says why.
  const codex = (await call(laptop, '/chat', 'POST', { provider: 'codex' })).conversation;
  await turn(laptop, codex, 'hello');
  const refused = await move(codex);
  assert.equal(refused.body.error, 'move-unavailable');
  assert.match(refused.body.message, /Codex chats cannot move/);
});

test('Send to server: the chat resumes on the server with the same session, once the edited files have synced', { skip, timeout: 60000 }, async (t) => {
  const { laptop, server, move } = await pair(t);
  const { id, session } = await chat(laptop, 'hello', 'edit moved-notes.md');
  assert.match(session, /^[0-9a-f-]{36}$/);
  // Syncthing has not brought the edited file yet: the server names it, and the chat stays here, runnable.
  const early = await move(id, { syncWait: 1000 });
  assert.equal(early.status, 409, JSON.stringify(early));
  assert.match(early.body.message, /latest copy of moved-notes\.md/);
  assert.equal((await listed(laptop, id)).state, 'stopped');
  assert.equal(await listed(server, id), undefined);
  assert.deepEqual(await transcripts(server, session), []);
  // The sync arrives; the move goes through.
  await copyFile(path.join(laptop.workspace, 'moved-notes.md'), path.join(server.workspace, 'moved-notes.md'));
  const moved = await move(id);
  assert.deepEqual(moved, { status: 200, body: { moved: true, host: 'test-host' } });
  // The transcript is in the server's Claude folder for the server's workspace, byte for byte; the chat keeps its ID.
  const [here] = await transcripts(laptop, session), there = await transcripts(server, session);
  assert.equal(there.length, 1);
  assert.equal(there[0].folder, server.workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  assert.equal(there[0].text, here.text);
  const row = await listed(server, id);
  assert.equal(row.state, 'stopped');
  // Its history came along with the original times; the move itself is the last event.
  const history = await events(server, id), before = await events(laptop, id);
  assert.deepEqual(history.filter((e) => e.type === 'user').map((e) => [e.data.text, e.at]), before.filter((e) => e.type === 'user').map((e) => [e.data.text, e.at]));
  assert.deepEqual(history.at(-1).data, { from: laptop.workspace, to: server.workspace });
  // The next message resumes the same Claude session there, which still knows what was said; P9 tells it the folder moved, once.
  await turn(server, id, 'recall');
  const resumed = (await events(server, id)).filter((e) => e.type === 'resumed');
  assert.deepEqual(resumed.map((e) => e.data.session), [session]);
  assert.ok((await said(server, id)).includes('recall:hello|edit moved-notes.md +note'), JSON.stringify(await said(server, id)));
  await turn(server, id, 'recall');
  assert.ok((await said(server, id)).at(-1).startsWith('recall:') && !(await said(server, id)).at(-1).endsWith('+note'));
});

test('Send to server: the laptop copy is stopped and marked moved, and a lost answer never makes two', { skip, timeout: 60000 }, async (t) => {
  const { laptop, server, move } = await pair(t);
  const { id } = await chat(laptop, 'hello');
  assert.equal((await move(id)).status, 200);
  assert.equal((await listed(laptop, id)).state, 'moved');
  assert.deepEqual((await events(laptop, id)).find((e) => e.type === 'moved').data, { host: 'test-host' });
  // Nothing here runs it again: a message, Stop, Hand off and a second move are all refused, and it stays moved.
  const prompt = await call(laptop, '/chat/' + id + '/prompt', 'POST', { text: 'still here?' });
  assert.equal(prompt.status, 409, JSON.stringify(prompt));
  assert.equal((await call(laptop, '/chat/' + id + '/stop', 'POST')).status, 200);
  assert.equal((await call(laptop, '/chat/' + id + '/handoff', 'POST')).status, 409);
  assert.equal((await move(id)).body.error, 'moved');
  assert.equal((await listed(laptop, id)).state, 'moved');
  assert.ok(!(await events(laptop, id)).some((e) => e.type === 'user' && e.data.text === 'still here?'));

  // A move whose answer was lost after the server took the chat: this copy stays frozen ("moving"), refuses messages,
  // and pressing again finishes it, with no second copy on the server.
  const other = await chat(laptop, 'hello');
  const away = await call(laptop, '/chat/' + other.id + '/send-away', 'POST');
  assert.equal(away.status, 200, JSON.stringify(away));
  assert.equal((await call(laptop, '/chat/' + other.id + '/prompt', 'POST', { text: 'in between' })).status, 409);
  const { status: _, ...manifest } = away;
  for (const kind of ['transcript', 'events']) {
    const piece = await call(laptop, '/chat/' + other.id + '/move-part?kind=' + kind + '&offset=0');
    assert.equal((await call(server, '/chat-import/' + other.id + '/part', 'POST', { kind, offset: 0, data: piece.data })).status, 200);
  }
  assert.equal((await call(server, '/chat-import/' + other.id, 'POST', manifest)).status, 200);
  assert.equal((await listed(laptop, other.id)).state, 'moving');
  assert.deepEqual(await move(other.id), { status: 200, body: { moved: true, host: 'test-host' } });
  assert.equal((await listed(laptop, other.id)).state, 'moved');
  assert.equal((await call(server, '/chat')).conversations.filter((c) => c.id === other.id).length, 1);
  assert.equal((await transcripts(server, other.session)).length, 1);
  // Landing it once more is the same answer, and adds nothing.
  assert.deepEqual(await call(server, '/chat-import/' + other.id, 'POST', manifest), { status: 200, already: true });
  assert.equal((await events(server, other.id)).filter((e) => e.type === 'moved-in').length, 1);
});

test('Send to server: the server refuses crafted ids, pieces, paths and history, and writes nothing', { skip, timeout: 60000 }, async (t) => {
  const { server } = await pair(t);
  const id = randomUUID(), session = randomUUID(), b64 = (text) => Buffer.from(text).toString('base64');
  const piece = (kind, offset, text) => call(server, '/chat-import/' + id + '/part', 'POST', { kind, offset, data: b64(text) });
  // Pieces: only a UUID chat, a known kind, and at the exact size so far.
  assert.ok([400, 404].includes((await call(server, '/chat-import/' + encodeURIComponent('../x') + '/part', 'POST', { kind: 'events', offset: 0, data: '' })).status));
  assert.equal((await call(server, '/chat-import/not-a-uuid/part', 'POST', { kind: 'events', offset: 0, data: '' })).status, 400);
  assert.equal((await piece('ledger', 0, 'x')).status, 400);
  assert.deepEqual(await piece('events', 5, 'x'), { status: 409, error: 'offset', size: 0 });
  // A history line whose type is not a short word, uploaded intact: refused as a whole.
  const transcript = '{"type":"user"}\n', history = JSON.stringify({ type: 'Bad Type; rm', at: 1, data: {} }) + '\n';
  assert.equal((await piece('transcript', 0, transcript)).status, 200);
  assert.equal((await piece('events', 0, history)).status, 200);
  const sum = (text) => createHash('sha256').update(text).digest('hex');
  const manifest = { session, title: 'crafted', folder: '', created: 1, from: '/elsewhere', files: [], outside: 0,
    parts: { transcript: { bytes: transcript.length, sha256: sum(transcript) }, events: { bytes: history.length, sha256: sum(history) } } };
  const land = (changes) => call(server, '/chat-import/' + id, 'POST', { ...manifest, ...changes });
  assert.equal((await land({ session: '../../etc/passwd' })).status, 400);
  assert.equal((await land({ files: [{ path: '../outside', sha256: null }] })).status, 400);
  assert.equal((await land({ files: [{ path: '/etc/passwd', sha256: null }] })).status, 400);
  assert.equal((await land({ folder: '../..' })).error, 'folder-missing');
  assert.equal((await land()).error, 'events-refused');
  // A piece that does not match its size and sha256: refused, and the pieces are dropped so the upload starts again.
  assert.equal((await land({ parts: { ...manifest.parts, transcript: { bytes: transcript.length, sha256: sum('other') } } })).error, 'upload-mismatch');
  assert.deepEqual(await piece('events', history.length, 'x'), { status: 409, error: 'offset', size: 0 });
  // None of it reached the ledger or Claude's folder.
  assert.equal(await listed(server, id), undefined);
  assert.deepEqual(await transcripts(server, session), []);
});
