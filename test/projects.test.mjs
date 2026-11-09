// N1 step 1 (threat model row N1): projects in the daemon. A project is its id, not its path; P9 adds nothing to the
// user's folder; a chat's project is the one the user put it in, never guessed from its folder; deleting a project never
// touches a folder the user chose. Each test drives the real daemon's routes (and memory's replay for the memory rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { openLedger, SCHEMA } from '../apps/server/ledger.mjs';
import { startMemory, MEMORY_CONVERSATION as MEM } from '../apps/server/memory.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const start = (t) => daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
const call = (instance, route, method = 'GET', body) => http({ socketPath: path.join(instance.state, 'daemon.sock'), route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-p9-op': randomUUID() }) },
  body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => ({ ...r, body: /json/.test(r.headers['content-type'] ?? '') ? JSON.parse(r.text) : r.text }));
const home = (instance) => path.join(instance.directory, '.local', 'state', 'p9-foundation', 'projects');
const b64 = (text) => Buffer.from(text).toString('base64');
const list = async (instance) => (await call(instance, '/chat')).body.conversations;

// Every file and folder under one folder: its path, kind, mtime and (files) a hash of its bytes.
async function snapshot(folder) {
  const out = [];
  const walk = async (dir) => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name), info = await lstat(full);
      out.push([path.relative(folder, full), info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file', info.mtimeMs,
        info.isFile() ? createHash('sha256').update(await readFile(full)).digest('hex') : null]);
      if (info.isDirectory()) await walk(full);
    }
  };
  const info = await lstat(folder);
  await walk(folder);
  return { mtime: info.mtimeMs, out };
}
// A linked folder as the user has it: an agent file, a nested file, all with an old mtime so any touch shows.
async function userFolder(workspace, name) {
  const folder = path.join(workspace, name);
  await mkdir(path.join(folder, 'src'), { recursive: true });
  await writeFile(path.join(folder, 'AGENTS.md'), 'agent rules');
  await writeFile(path.join(folder, 'src', 'main.mjs'), 'export {}');
  const old = new Date('2020-01-01T00:00:00Z');
  for (const file of ['src/main.mjs', 'AGENTS.md', 'src', '']) await utimes(path.join(folder, file), old, old);
  return folder;
}
async function turn(instance, id, text) {
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text })).status, 202);
  for (let i = 0; i < 100; i++) {
    const { body } = await call(instance, `/chat/events?after=0&only=${id}`);
    const events = body.events ?? [];
    const ends = events.filter((e) => e.type === 'turn-end' || e.type === 'error');
    const users = events.filter((e) => e.type === 'user' && !e.data.steered); // a steered message makes no turn of its own
    if (ends.length >= users.length && users.at(-1)?.data.text === text) {
      const at = events.lastIndexOf(users.at(-1));
      return events.slice(at).filter((e) => e.type === 'update' && e.data.sessionUpdate === 'agent_message_chunk').map((e) => e.data.content.text).join('');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no turn end for ' + text);
}

test('a linked folder is byte-identical after create, edit, add file, chat, relocate, archive, a second project and delete', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const folder = await userFolder(instance.workspace, 'site');
  await userFolder(instance.workspace, 'site-copy');
  const before = await snapshot(folder);
  const same = async (step) => assert.deepEqual(await snapshot(folder), before, 'the linked folder changed after ' + step);

  const created = await call(instance, '/projects', 'POST', { name: 'Site', about: 'the site', instructions: 'Use tabs.', work: { kind: 'linked', folder: 'site' } });
  assert.equal(created.status, 201, created.text);
  const id = created.body.project.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.body.project.agentFiles, ['AGENTS.md']);
  assert.equal(created.body.project.found, true);
  await same('create');
  assert.equal((await call(instance, `/projects/${id}`, 'POST', { name: 'Site 2', about: 'x', instructions: 'Use spaces.' })).status, 200);
  await same('edit');
  assert.equal((await call(instance, `/projects/${id}/files`, 'POST', { name: 'brief.txt', data: b64('the brief') })).status, 201);
  assert.equal(await readFile(path.join(home(instance), id, 'files', 'brief.txt'), 'utf8'), 'the brief');
  await same('add file');
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', project: id })).body.conversation;
  assert.equal((await list(instance)).find((c) => c.id === chat).folder, 'site', 'a project chat starts in its work folder');
  await turn(instance, chat, 'hello');
  await same('a chat');
  assert.equal((await call(instance, `/projects/${id}/locate`, 'POST', { folder: 'site-copy' })).status, 200);
  assert.equal((await call(instance, `/projects/${id}/locate`, 'POST', { folder: 'site' })).status, 200);
  await same('relocate');
  assert.equal((await call(instance, `/projects/${id}`, 'POST', { archived: true })).body.project.archived, true);
  await same('archive');
  // Two projects may use one work folder; the reply names the other (create and relocate).
  const second = await call(instance, '/projects', 'POST', { name: 'Site B', work: { kind: 'linked', folder: 'site' } });
  assert.equal(second.status, 201, second.text);
  const other = second.body.project.id;
  assert.deepEqual(second.body.project.sharedWith, [{ id, name: 'Site 2' }]);
  assert.deepEqual((await call(instance, `/projects/${other}/locate`, 'POST', { folder: 'site-copy' })).body.project.sharedWith, []);
  assert.deepEqual((await call(instance, `/projects/${other}/locate`, 'POST', { folder: 'site' })).body.project.sharedWith, [{ id, name: 'Site 2' }]);
  assert.deepEqual((await call(instance, `/projects/${id}`)).body.project.sharedWith, [{ id: other, name: 'Site B' }]);
  await same('a second project on it');
  // Delete: its chats always move to Chats; there is no choice to delete them with it.
  assert.equal((await call(instance, `/projects/${id}/delete`, 'POST', { chats: 'delete' })).status, 400, 'no delete-the-chats choice');
  const gone = await call(instance, `/projects/${id}/delete`, 'POST', {});
  assert.deepEqual([gone.status, gone.body.moved], [200, [chat]], gone.text);
  await same('delete');
  assert.equal(existsSync(path.join(home(instance), id)), false, "P9's own folder for the project is removed");
  assert.equal((await list(instance)).find((c) => c.id === chat).project, null, 'its chat is a general chat now');
  assert.deepEqual((await call(instance, `/projects/${other}`)).body.project.found, true, 'the other project on the folder is untouched');
  // A chat's own delete (its menu) removes the chat and its events, and still not a byte of the folder.
  assert.equal((await call(instance, `/chat/${chat}/project`, 'POST', { project: other })).status, 200);
  assert.equal((await call(instance, `/chat/${chat}/delete`, 'POST', {})).status, 200);
  assert.equal((await list(instance)).some((c) => c.id === chat), false, 'the chat is deleted');
  assert.deepEqual((await call(instance, `/chat/events?after=0&only=${chat}`)).body.events.filter((e) => e.type !== 'deleted'), [], 'and its events');
  assert.equal((await call(instance, `/projects/${other}/delete`, 'POST', {})).status, 200);
  await same('chat delete and the second project deleted');
  console.log('PASS linked folder: file list, contents and mtimes unchanged through create, edit, add file, chat, relocate x2, archive, a second project, delete x2, chat delete');
});

test('a new folder is made empty, a taken name is refused; In P9 has no work folder', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const made = await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(await readdir(path.join(instance.workspace, 'fresh')), [], 'P9 adds nothing to the new folder');
  assert.equal(made.body.project.work.folder, 'fresh');
  const taken = await call(instance, '/projects', 'POST', { name: 'Again', work: { kind: 'new', parent: '', name: 'fresh' } });
  assert.deepEqual([taken.status, taken.body.error], [409, 'folder-exists']);
  for (const name of ['../out', 'a/b', '..', '.env']) {
    assert.equal((await call(instance, '/projects', 'POST', { name: 'Bad', work: { kind: 'new', parent: '', name } })).status, 400, name);
  }
  assert.equal(existsSync(path.join(instance.directory, 'out')), false);
  assert.equal((await call(instance, '/projects')).body.projects.length, 1, 'a refused create leaves no project behind');
  const p9 = await call(instance, '/projects', 'POST', { name: 'Notes', work: { kind: 'p9' } });
  assert.equal(p9.status, 201, p9.text);
  assert.deepEqual(p9.body.project.work, { kind: 'p9', folder: null });
  const chat = (await call(instance, '/chat', 'POST', { provider: 'codex', project: p9.body.project.id })).body.conversation;
  assert.equal((await list(instance)).find((c) => c.id === chat).folder, ':project-files', "an In P9 chat starts in its project's files (step 1b)");
  console.log('PASS new folder: made empty, taken name 409, bad names 400, In P9 project chat marked to start in its files');
});

test('added files: ../, a separator, a link already there, an existing name and a locked name are refused', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const id = (await call(instance, '/projects', 'POST', { name: 'Files', work: { kind: 'p9' } })).body.project.id;
  const add = (name, data = b64('x')) => call(instance, `/projects/${id}/files`, 'POST', { name, data });
  assert.equal((await add('one.txt', b64('first'))).status, 201);
  const outside = path.join(instance.directory, 'outside.txt');
  await writeFile(outside, 'keep me');
  await symlink(outside, path.join(home(instance), id, 'files', 'link.txt'));
  for (const [name, status] of [['../escape.txt', 400], ['sub/x.txt', 400], ['..', 400], ['.env', 400], ['one.txt', 409], ['link.txt', 409]]) {
    assert.equal((await add(name)).status, status, name);
  }
  assert.equal((await add('bad.txt', 'not base64!')).status, 400);
  assert.equal(await readFile(outside, 'utf8'), 'keep me', 'the link target is untouched');
  assert.equal(await readFile(path.join(home(instance), id, 'files', 'one.txt'), 'utf8'), 'first', 'an existing file is never replaced');
  assert.equal(existsSync(path.join(home(instance), id, 'escape.txt')), false);
  assert.deepEqual((await call(instance, `/projects/${id}`)).body.project.files, [{ name: 'one.txt', size: 5 }], 'a link is not listed');
  assert.equal((await call(instance, `/projects/${id}/files/remove`, 'POST', { name: '../project.json' })).status, 400);
  assert.equal((await call(instance, `/projects/${id}/files/remove`, 'POST', { name: 'link.txt' })).status, 404, 'a link is not removed through it');
  assert.equal((await call(instance, `/projects/${id}/files/remove`, 'POST', { name: 'one.txt' })).status, 200);
  assert.deepEqual((await call(instance, `/projects/${id}`)).body.project.files, []);
  console.log('PASS added files: ../, separator, .., .env 400; existing name and planted link 409; link target and existing file unchanged');
});

// Step 1b (threat model row N1b): an In P9 project's chat starts in that project's own files/, found from its project id.
// No client can name a folder under P9's own: not files/, not projects/<id>/, not state/, not another project's files/, not
// a link to one, in either mode. files/ swapped for a link is refused at the next start.
test("an In P9 project's chat starts and resumes in its own files folder; no client-sent folder reaches P9's", { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const make = async (name) => (await call(instance, '/projects', 'POST', { name, work: { kind: 'p9' } })).body.project.id;
  const a = await make('Notes'), b = await make('Other');
  const files = (id) => path.join(home(instance), id, 'files');
  const replies = async (id) => {
    const events = (await call(instance, `/chat/events?after=0&only=${id}`)).body.events ?? [];
    return { said: events.filter((e) => e.type === 'update' && e.data.content?.text?.startsWith('cwd:')).map((e) => e.data.content.text),
      ends: events.filter((e) => e.type === 'turn-end').length };
  };
  const ask = async (id) => {
    const before = (await replies(id)).said.length;
    assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'cwd' })).status, 202);
    for (let i = 0; i < 100; i++) {
      const { said, ends } = await replies(id);
      if (said.length > before && ends >= said.length) return said.at(-1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('no cwd reply');
  };
  const chat = await call(instance, '/chat', 'POST', { provider: 'claude', project: a });
  assert.equal(chat.status, 201, chat.text);
  const id = chat.body.conversation;
  assert.equal(await ask(id), 'cwd:new:' + files(a), "a new chat starts in its project's files");
  assert.equal((await call(instance, `/chat/${id}/stop`, 'POST')).status, 200);
  assert.equal(await ask(id), 'cwd:resume:' + files(a), 'and resumes there');
  await symlink(files(a), path.join(instance.workspace, 'to-files'));
  const refusedFolders = [path.join(home(instance), a), files(b), path.join(home(instance), a, 'state'), files(a), home(instance), ':project-files', 'to-files'];
  for (const mode of ['protected', 'unrestricted']) {
    if (mode === 'unrestricted') assert.equal(JSON.parse((await call(instance, '/file-protection', 'POST', { on: false })).text).on, false);
    for (const folder of refusedFolders) {
      assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', folder })).status, 400, `${mode}: ${folder} refused`);
      assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', project: a, folder })).status, 400, `${mode}, in a project: ${folder} refused`);
    }
    const again = (await call(instance, '/chat', 'POST', { provider: 'codex', project: a })).body.conversation;
    assert.equal(await ask(again), 'cwd:new:' + files(a), `${mode}: the rule holds, the client sent no path`);
  }
  await call(instance, '/file-protection', 'POST', { on: true });
  assert.equal((await call(instance, '/chat/started-in?folder=')).body.conversations.length, 0, 'an In P9 chat is not "started in" the workspace');
  // Moved into another In P9 project: that project's files. Moved out: the workspace.
  assert.equal((await call(instance, `/chat/${id}/project`, 'POST', { project: b })).status, 200);
  assert.equal((await call(instance, `/chat/${id}/stop`, 'POST')).status, 200);
  assert.equal(await ask(id), 'cwd:resume:' + files(b), 'moved: the new project\'s files');
  assert.equal((await call(instance, `/chat/${id}/project`, 'POST', { project: null })).status, 200);
  assert.equal((await call(instance, `/chat/${id}/stop`, 'POST')).status, 200);
  assert.equal(await ask(id), 'cwd:resume:' + instance.workspace, 'moved out: the workspace');
  // files/ swapped for a link: refused at the next start.
  assert.equal((await call(instance, `/chat/${id}/project`, 'POST', { project: a })).status, 200);
  assert.equal((await call(instance, `/chat/${id}/stop`, 'POST')).status, 200);
  await rename(files(a), files(a) + '-real');
  await symlink(instance.workspace, files(a));
  assert.equal((await call(instance, `/chat/${id}/prompt`, 'POST', { text: 'cwd' })).status, 502, 'files/ as a link is refused');
  console.log("PASS In P9: starts and resumes in its files, follows a move, refuses every client-sent P9 folder in both modes and a linked files/");
});

test('a project id that is not a UUID is refused on every route', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  // A folder under projects/ that looks like a project but is not named by a UUID is never read as one.
  await mkdir(path.join(home(instance), 'site'), { recursive: true });
  await writeFile(path.join(home(instance), 'site', 'project.json'), JSON.stringify({ id: 'site', name: 'Site', work: { kind: 'p9' } }));
  for (const bad of ['site', '..', '%2e%2e', 'ABCDEFAB-0000-4000-8000-000000000000', randomUUID() + 'x']) {
    // 404 (unknown project) or, for '..' and '%2e%2e', the router's own refusal of the path it normalizes to: never a 2xx.
    for (const [route, method, body] of [[`/projects/${bad}`, 'GET'], [`/projects/${bad}/delete`, 'POST', {}], [`/projects/${bad}/files`, 'POST', { name: 'a.txt', data: '' }]]) {
      const { status } = await call(instance, route, method, body);
      assert.ok(status === 404 || (['..', '%2e%2e'].includes(bad) && status === 400), `${method} ${route}: ${status}`);
    }
    assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', project: bad })).status, 400, bad);
    assert.equal((await call(instance, `/chat/${chat}/project`, 'POST', { project: bad })).status, 400, bad);
  }
  assert.equal((await call(instance, `/chat/${chat}/project`, 'POST', { project: randomUUID() })).status, 404, 'an unknown UUID');
  assert.equal((await call(instance, '/chat', 'POST', { provider: 'claude', project: null })).status, 400);
  assert.deepEqual((await call(instance, '/projects')).body.projects, []);
  assert.equal(existsSync(path.join(home(instance), 'site', 'project.json')), true, 'and never deleted through a route');
  console.log('PASS non-UUID project ids: 404 on project routes, 400 on chat create and move; a non-UUID folder is never listed');
});

test('a moved folder keeps the project id, its chats and files, and is reported missing until located', { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await userFolder(instance.workspace, 'old');
  const id = (await call(instance, '/projects', 'POST', { name: 'Moved', work: { kind: 'linked', folder: 'old' } })).body.project.id;
  await call(instance, `/projects/${id}/files`, 'POST', { name: 'brief.txt', data: b64('brief') });
  const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', project: id })).body.conversation;
  await rename(path.join(instance.workspace, 'old'), path.join(instance.workspace, 'new'));
  const missing = (await call(instance, `/projects/${id}`)).body.project;
  assert.deepEqual([missing.id, missing.found, missing.chats, missing.files.map((f) => f.name), missing.agentFiles], [id, false, 1, ['brief.txt'], []]);
  assert.equal((await call(instance, '/projects')).body.projects[0].found, false);
  assert.equal((await list(instance)).find((c) => c.id === chat).project, id, 'the chat keeps its project');
  assert.equal((await call(instance, `/projects/${id}/locate`, 'POST', { folder: 'nowhere' })).status, 400);
  const located = await call(instance, `/projects/${id}/locate`, 'POST', { folder: 'new' });
  assert.equal(located.status, 200, located.text);
  assert.deepEqual([located.body.project.id, located.body.project.found, located.body.project.work.folder], [id, true, 'new']);
  assert.equal((await list(instance)).find((c) => c.id === chat).folder, 'new', 'its chats that started in the old folder start in the new one');
  console.log('PASS moved folder: same id, 1 chat, brief.txt kept, found:false, then located to new with found:true');
});

test("a chat started in a project's folder with no project id stays a general chat; the user's choices stick", { timeout: 120000 }, async (t) => {
  const instance = await start(t);
  await userFolder(instance.workspace, 'site');
  const id = (await call(instance, '/projects', 'POST', { name: 'Site', instructions: 'Answer in French.', work: { kind: 'linked', folder: 'site' } })).body.project.id;
  const general = (await call(instance, '/chat', 'POST', { provider: 'claude', folder: 'site' })).body.conversation;
  assert.equal((await list(instance)).find((c) => c.id === general).project, null, 'never guessed from its folder');
  assert.ok(!(await turn(instance, general, 'hi')).includes('[P9: this chat is in the project'), 'a general chat gets no project note');
  assert.deepEqual((await call(instance, '/chat/started-in?folder=site')).body.conversations.map((c) => [c.id, c.project]), [[general, null]]);
  // The user moves it in: its next message carries the project's note once; an edit sends it again.
  assert.equal((await call(instance, `/chat/${general}/project`, 'POST', { project: id })).status, 200);
  assert.match(await turn(instance, general, 'first'), /\[P9: this chat is in the project "Site"\.[\s\S]*Answer in French\.[\s\S]*first$/);
  assert.equal(await turn(instance, general, 'second'), 'echo:second', 'the same note is not sent twice');
  // Step 1c: a message steered into a running turn carries no projectNote; the next message still gets no note.
  const seen = async (test, what) => {
    for (let i = 0; i < 100; i++) {
      if (test((await call(instance, `/chat/events?after=0&only=${general}`)).body.events ?? [])) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('never ' + what);
  };
  const said = (text) => seen((events) => events.some((e) => e.type === 'update' && e.data.content?.text === text), 'said ' + text);
  const ends = ((await call(instance, `/chat/events?after=0&only=${general}`)).body.events ?? []).filter((e) => e.type === 'turn-end').length;
  assert.equal((await call(instance, `/chat/${general}/prompt`, 'POST', { text: 'slow' })).status, 202);
  await said('working');
  assert.equal((await call(instance, `/chat/${general}/prompt`, 'POST', { text: 'mid' })).body.steered, true);
  await said('got:mid');
  assert.equal((await call(instance, `/chat/${general}/cancel`, 'POST')).status, 200);
  await seen((events) => events.filter((e) => e.type === 'turn-end').length > ends, 'ended the cancelled turn');
  assert.equal(await turn(instance, general, 'after steer'), 'echo:after steer', 'a steered message does not make the note go again');
  await call(instance, `/projects/${id}/files`, 'POST', { name: 'brief.txt', data: b64('b') });
  assert.ok((await turn(instance, general, 'third')).includes(path.join(home(instance), id, 'files', 'brief.txt')), 'an added file changes the note');
  // Rename sticks over the agent's own title; archive hides without deleting.
  assert.equal((await call(instance, `/chat/${general}/rename`, 'POST', { title: '  My   name ' })).body.title, 'My name');
  await turn(instance, general, 'title Agent title');
  assert.equal((await list(instance)).find((c) => c.id === general).title, 'My name');
  assert.equal((await call(instance, `/chat/${general}/archive`, 'POST', { archived: true })).status, 200);
  assert.equal((await list(instance)).find((c) => c.id === general).archived, true);
  assert.equal((await call(instance, `/chat/${general}/project`, 'POST', { project: null })).status, 200);
  assert.equal((await list(instance)).find((c) => c.id === general).project, null);
  console.log('PASS general chat in a project folder: project null, no note; moved in: note once, not again after a steer, again after a change; rename and archive stick');
});

test("memory: a chat in a P9 project takes project:<id>; a chat in its folder with no project is inferred as today", { timeout: 120000 }, async (t) => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-projects-memory-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  await mkdir(path.join(ws, 'site', '.git'), { recursive: true });
  const ledgerFile = path.join(dir, 'p9.db'), file = path.join(dir, 'memory.db');
  const ledger = openLedger(ledgerFile);
  const U = randomUUID(), [A, B, C] = [1, 2, 3].map((n) => 'eeeeeeee-0000-4000-8000-00000000000' + n);
  const end = ['turn-end', { stopReason: 'end_turn' }];
  const insert = ledger.db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)');
  [[MEM, 'memory', { action: 'switch', on: true }],
    [A, 'created', { provider: 'claude', title: 'A', folder: 'site' }], [A, 'user', { text: 'hi' }], [A, ...end], // no project: inferred
    [B, 'created', { provider: 'claude', title: 'B', folder: 'site', project: U }], [B, 'user', { text: 'hi' }], [B, ...end], // in U
    [C, 'created', { provider: 'claude', title: 'C', folder: 'site', project: 'site' }], [C, 'user', { text: 'hi' }], [C, ...end], // not a UUID
    [A, 'project', { project: U }], [A, 'user', { text: 'moved in' }], [A, ...end], // moved in by the user
    [A, 'project', { project: null }], [A, 'user', { text: 'moved out' }], [A, ...end],
  ].forEach(([conversation, type, data], i) => insert.run(conversation, type, JSON.stringify(data), 1767000000000 + i * 100));
  ledger.db.close();
  const memory = startMemory({ ledgerFile, file, workspace: ws });
  await memory.idle();
  await memory.close();
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare('SELECT conversation, user_text, project FROM records ORDER BY key').all().map((r) => [r.conversation, r.user_text, r.project]);
  db.close();
  assert.deepEqual(rows, [[A, 'hi', 'site'], [B, 'hi', 'project:' + U], [C, 'hi', 'site'], [A, 'moved in', 'project:' + U], [A, 'moved out', 'site']]);
  console.log('PASS memory: general chat in site -> site; project chat -> project:<id>; non-UUID project ignored; move in and out followed');
});

test('ledger schema 3: every chat from before is a general chat, not archived; the old file is kept', { timeout: 120000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'p9-projects-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A real ledger (and memory.db, if any), copied read-only into test/real-state/ for one staged run and never committed
  // (the dev space passes no environment); else one made at schema 2.
  const source = existsSync(path.join(root, 'test', 'real-state', 'p9.db')) ? path.join(root, 'test', 'real-state') : null;
  const file = path.join(dir, 'p9.db');
  if (source) for (const name of ['p9.db', 'memory.db'].filter((name) => existsSync(path.join(source, name)))) await copyFile(path.join(source, name), path.join(dir, name));
  else {
    const { MIGRATIONS } = await import('../apps/server/ledger.mjs');
    openLedger(file, { steps: MIGRATIONS.slice(0, 2) }).db.close();
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO conversations (id, provider, title, state, created, folder) VALUES (?, 'claude', 'Old', 'idle', 1, 'site')").run(randomUUID());
    db.close();
  }
  const read = (sql) => { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const before = read('SELECT id, title, folder FROM conversations ORDER BY id').map((r) => ({ ...r }));
  const ledger = openLedger(file);
  ledger.db.close();
  assert.equal(SCHEMA, 3);
  assert.equal(read('PRAGMA user_version')[0].user_version, 3);
  const after = read('SELECT id, title, folder, project, archived FROM conversations ORDER BY id').map((r) => ({ ...r }));
  assert.deepEqual(after.map(({ id, title, folder }) => ({ id, title, folder })), before);
  assert.ok(after.every((r) => r.project === null && r.archived === 0));
  assert.ok(existsSync(file + '.v2.bak'), 'the schema 2 file is kept beside it');
  if (source) {
    const memory = startMemory({ ledgerFile: file, file: path.join(dir, 'memory.db'), workspace: dir });
    await memory.idle();
    const stats = memory.stats();
    await memory.close();
    assert.equal(stats.workerError, null);
    console.log('P9_REAL_STATE memory ' + JSON.stringify(stats));
  }
  console.log(`PASS ledger schema 3 on ${source ? 'the real ledger copy' : 'a schema 2 ledger'}: ${after.length} chats, all general, none archived; .v2.bak kept`);
});
