// Sprint scripts (sprint spec S19; SECURITY.md § Sprint scripts): hooks.json names commands P9 runs at fixed points of a
// sprint, each given the sprint's state as JSON on stdin. Only the copy the owner approved at Start runs: a file edited
// after Start runs nothing until Start is pressed again. A blocking script that fails refuses the action by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { parse, run, said, clean, POINTS, BLOCKING, FIRED } from '../apps/server/sprint-hooks.mjs';
import { planItems } from '../apps/server/sprint-files.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const rows = async (instance) => (await call(instance, '/chat')).body.conversations;
const events = async (instance, id) => (await call(instance, '/chat/events?after=0&only=' + id)).body.events;
async function replied(instance, id, start) {
  for (let i = 0; i < 150; i += 1) {
    if ((await events(instance, id)).some((e) => e.data?.content?.text?.startsWith(start))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no ' + start + ' reply from ' + id);
}
async function attach(t, instance, conversation) {
  let hit;
  for (let i = 0; i < 150 && !hit; i += 1) { hit = (await events(instance, conversation)).find((e) => e.data?.content?.text?.startsWith('mcp:')); if (!hit) await new Promise((r) => setTimeout(r, 200)); }
  assert.ok(hit, 'no mcp reply from ' + conversation);
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  return { tool: async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text) };
}
const eventually = async (check, what) => { for (let i = 0; i < 100; i += 1) { const got = await check(); if (got) return got; await new Promise((r) => setTimeout(r, 150)); } assert.fail('timed out: ' + what); };

test('Sprint scripts: hooks.json is refused by row and field; a run gets its input, ends on its timeout, and never throws', { timeout: 60000 }, async () => {
  assert.deepEqual(parse(null), { scripts: [] }); assert.deepEqual(parse('  \n'), { scripts: [] });
  const one = { name: 'check', command: 'node check.mjs', point: 'before-start', blocking: true };
  assert.deepEqual(parse(JSON.stringify({ scripts: [one, { name: 'n', command: 'x', point: 'ci-red' }] })).scripts, [one, { name: 'n', command: 'x', point: 'ci-red', blocking: false }]);
  const bad = (rows, re, extra = {}) => { const got = parse(typeof rows === 'string' ? rows : JSON.stringify({ scripts: rows, ...extra })); assert.match(got.error ?? 'accepted', re, JSON.stringify(rows).slice(0, 120)); assert.equal(got.scripts, undefined); };
  bad('{nope', /not JSON/); bad('[]', /"scripts"/); bad([], /"scripts"/, { run: 'now' });
  bad(Array.from({ length: 13 }, (_, i) => ({ ...one, name: 'n' + i })), /at most 12/);
  bad([{ ...one, shell: true }], /script 1: only name/);
  bad([one, { ...one }], /script 2, name: "check" is used twice/);
  bad([{ ...one, name: 'a|b' }], /name/); bad([{ ...one, name: ' a' }], /name/); bad([{ ...one, name: 'a\nb' }], /name/);
  bad([{ ...one, command: 'x'.repeat(201) }], /command: 1 to 200/); bad([{ ...one, command: 'a b' }], /command/); bad([{ ...one, command: '' }], /command/);
  bad([{ ...one, point: 'whenever' }], /point: one of before-start/);
  bad([{ ...one, blocking: 'yes' }], /blocking: true or false/);
  bad([{ ...one, point: 'sprint-start' }], /blocking: only at before-start, before-new-worker, before-merge, before-close/);
  assert.equal(said(one), 'check (before-start, blocking): node check.mjs');
  assert.equal(clean('a |\u0007 b\n' + 'c'.repeat(400)).length, 300); assert.equal(clean(' a |\u0007  b\tc '), 'a b c');
  assert.ok(BLOCKING.every((p) => POINTS.includes(p)) && FIRED.every((p) => POINTS.includes(p)) && POINTS.length === 12);
  assert.deepEqual(planItems('# P\n\n- [ ] A1: x. Role w1\n- [x] A2: y\nnot an item\n'), [{ id: 'A1', text: 'A1: x. Role w1', role: 'w1', ticked: false }, { id: 'A2', text: 'A2: y', role: null, ticked: true }]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-hooks-'));
  fs.writeFileSync(path.join(dir, 'echo.mjs'), 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { console.log("first"); console.log("got " + JSON.parse(s).n + " |\\u0007 in " + process.cwd() + " key=" + (process.env.P9_TEST_SECRET ?? "none")); process.exit(JSON.parse(s).n); });');
  fs.writeFileSync(path.join(dir, 'slow.mjs'), 'setTimeout(() => {}, 60000);');
  process.env.P9_TEST_SECRET = 'leak';
  const node = process.execPath;
  const ok = await run(`${node}   echo.mjs`, '{"n":0}', { cwd: dir, timeout: 20000 });
  assert.deepEqual([ok.exit, ok.reason], [0, null]);
  assert.equal(ok.line, `got 0 in ${fs.realpathSync(dir)} key=none`, 'the last line, cleaned; the working folder; no variable outside the allow-list');
  assert.deepEqual((({ exit, reason }) => [exit, reason])(await run(`${node} echo.mjs`, '{"n":4}', { cwd: dir, timeout: 20000 })), [4, null]);
  const late = await run(`${node} slow.mjs`, '{}', { cwd: dir, timeout: 400 });
  assert.deepEqual([late.exit, late.reason], [null, 'timeout']); assert.ok(late.ms < 10000);
  assert.deepEqual((({ exit, reason }) => [exit, reason])(await run(path.join(dir, 'no-such-program'), '{}', { cwd: dir, timeout: 5000 })), [null, 'not-started']);
  // No shell: the words after the program are its arguments, never a second command.
  const shell = await run(`${node} echo.mjs ; touch ${path.join(dir, 'made')}`, '{"n":0}', { cwd: dir, timeout: 20000 });
  assert.equal(shell.exit, 0); assert.equal(fs.existsSync(path.join(dir, 'made')), false);
  delete process.env.P9_TEST_SECRET;
  console.log('PASS S19 unit: hooks.json refusals by row and field; run passes stdin, keeps the last line, times out, runs no shell');
});

test('Sprint scripts: Start approves the scripts by the file\'s hash and P9 runs only that copy, each with the sprint\'s state on stdin; a blocking failure refuses by name; a file edited after Start runs nothing', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Scripts' })).body, sprint = s.sprint;
  const write = (name, body) => fs.writeFileSync(path.join(s.folder, name), body);
  const page = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint);
  const lead = { key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, low = { provider: 'claude', model: 'haiku', effort: 'low' };
  write('roles.json', JSON.stringify({ folder: 'repo', roles: [lead] })); write('roles/lead.work.md', 'mcp');
  write('sprint.md', '# Scripts\n\n- [ ] B4: the one item. Role w1\n');

  // The hook: every run's stdin goes to hook-out.jsonl beside it; refuse-<point> beside it makes it fail with exit 3.
  const hook = path.join(ws, 'hook.mjs'), outFile = path.join(ws, 'hook-out.jsonl'), node = process.execPath;
  fs.writeFileSync(hook, `import fs from 'node:fs'; import path from 'node:path';
let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { const j = JSON.parse(s), here = import.meta.dirname;
  fs.appendFileSync(path.join(here, 'hook-out.jsonl'), JSON.stringify({ ...j, cwd: process.cwd() }) + '\\n');
  if (fs.existsSync(path.join(here, 'refuse-' + j.point))) { console.log('first line'); console.log('no: ' + j.point); process.exit(3); } });`);
  fs.writeFileSync(path.join(ws, 'evil.mjs'), `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(import.meta.dirname, 'evil-ran'), '1'); process.exit(7);`);
  const cmd = `${node} ${hook}`; assert.ok(cmd.length <= 200, 'the test\'s own command is too long: ' + cmd.length);
  const out = () => (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ran = (point) => eventually(() => out().find((r) => r.point === point), point + ' never ran');
  const scripts = [
    { name: 'check', command: cmd, point: 'before-start', blocking: true }, { name: 'started', command: cmd, point: 'sprint-start', blocking: false },
    { name: 'gate', command: cmd, point: 'before-new-worker', blocking: true }, { name: 'folder', command: cmd, point: 'worker-folder-made', blocking: false },
    { name: 'rdy', command: cmd, point: 'before-ready', blocking: false }, { name: 'later', command: cmd, point: 'before-merge', blocking: true },
  ];
  const before = (await rows(instance)).length;
  const press = (body = {}) => call(instance, `/sprints/${sprint}/start`, 'POST', body);

  // A file P9 cannot read as scripts: Start refuses and names the row and field.
  write('hooks.json', JSON.stringify({ scripts: [{ ...scripts[0], point: 'whenever' }] }));
  let got = await press();
  assert.deepEqual([got.status, got.body.error], [400, 'scripts-refused'], JSON.stringify(got.body)); assert.match(got.body.detail, /script 1 \(check\), point/);
  // The press names the file it was shown: none, or another, is refused and nothing starts.
  write('hooks.json', JSON.stringify({ scripts }, null, 1));
  let shown = (await page()).files.find((f) => f.name === 'hooks.json');
  assert.match(shown.hash, /^[0-9a-f]{64}$/);
  got = await press(); assert.deepEqual([got.status, got.body.error], [409, 'scripts-changed'], JSON.stringify(got.body));
  got = await press({ hooks: 'a'.repeat(64) }); assert.deepEqual([got.status, got.body.error], [409, 'scripts-changed']);
  assert.equal((await press({ hooks: 'nope' })).status, 400); assert.equal((await press({ hooks: shown.hash, also: 1 })).status, 400);
  assert.equal(out().length, 0, 'a refused press ran a script');
  // before-start, blocking: its failure refuses the start by name and records nothing.
  fs.writeFileSync(path.join(ws, 'refuse-before-start'), '');
  got = await press({ hooks: shown.hash });
  assert.deepEqual([got.status, got.body.error, got.body.script, got.body.point, got.body.exit], [400, 'script-refused', 'check', 'before-start', 3], JSON.stringify(got.body));
  assert.match(got.body.detail, /"check" \(before-start\) refused this: exit 3: no: before-start$/);
  assert.equal((await page()).started, undefined, 'a refused start left an approval record');
  assert.equal((await rows(instance)).length, before, 'a refused start made a chat');
  assert.match(fs.readFileSync(path.join(s.folder, 'hooks.log'), 'utf8'), /^\S+Z \| before-start \| check \| exit 3 \| \d+ ms \| no: before-start\n$/);
  fs.rmSync(path.join(ws, 'refuse-before-start')); fs.rmSync(outFile);

  // The press that approves: the record holds the scripts, and each run is told the sprint's state.
  got = await press({ hooks: shown.hash });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  let listed = await page();
  assert.deepEqual(listed.started.scripts, scripts);
  const bs = await ran('before-start');
  assert.deepEqual(Object.keys(bs).sort(), ['at', 'blocking', 'contract', 'cwd', 'items', 'log', 'phase', 'point', 'pr', 'project', 'roles', 'script', 'sprint', 'subject', 'usage', 'verdicts', 'workers'].sort());
  assert.deepEqual([bs.contract, bs.blocking, bs.script, bs.subject, bs.phase, bs.pr], [1, true, { name: 'check' }, null, null, null]);
  assert.deepEqual(bs.sprint, { id: sprint, title: 'Scripts', folder: s.folder, started: null });
  assert.equal(bs.cwd, fs.realpathSync(s.folder), 'a script runs in the sprint folder');
  assert.deepEqual(bs.project, { id: project, name: 'Fresh' });
  assert.deepEqual(bs.roles, [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high', mode: null }]);
  assert.deepEqual(bs.items, [{ id: 'B4', text: 'B4: the one item. Role w1', role: 'w1', ticked: false, review: null }]);
  assert.deepEqual([bs.workers, bs.verdicts], [[], []]);
  assert.equal(bs.log.length, 1, 'the earlier refusal is in the state\'s log'); assert.match(bs.log[0], /check \| exit 3/);
  assert.ok(!JSON.stringify(bs).includes(instance.credentials.token ?? '\u0000no-token'), 'the state carries the daemon\'s token');
  const ss = await ran('sprint-start');
  assert.deepEqual([ss.blocking, ss.script.name, ss.sprint.started.by, ss.sprint.started.plan], [false, 'started', 'owner', listed.started.plan]);
  assert.deepEqual(ss.workers.map((w) => [w.chat, w.key, w.provider, w.folder === null || typeof w.folder === 'string']), [[sprint, 'lead', 'claude', true]]);
  assert.deepEqual(Object.keys(ss.workers[0]).sort(), ['active', 'chat', 'context', 'effort', 'folder', 'key', 'mode', 'model', 'profile', 'provider', 'ready', 'state', 'task', 'title', 'verdict', 'waiting'].sort());

  // hooks.json edited after Start (any agent can write it): P9 still runs the approved copy, never the file.
  const L = await attach(t, instance, sprint);
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill({ agent: 'claude', model: 'haiku', effort: 'low' }) })).status, 200);
  write('roles.json', JSON.stringify({ folder: 'repo', roles: [lead, { key: 'w1', ...low }, { key: 'w2', ...low }] }));
  write('hooks.json', JSON.stringify({ scripts: [{ name: 'evil', command: `${node} ${path.join(ws, 'evil.mjs')}`, point: 'before-new-worker', blocking: true }] }));
  const made = await L.tool('open_chat', { text: 'mcp', key: 'w1', worktree: true, folder: repo, item: 'B4', done_means: 'reported', checks: ['check'] });
  assert.equal(made.error, undefined, 'the edited file\'s script ran or refused: ' + JSON.stringify(made));
  assert.equal(fs.existsSync(path.join(ws, 'evil-ran')), false, 'a script nobody approved ran');
  const nw = await ran('before-new-worker');
  assert.deepEqual([nw.blocking, nw.script.name, nw.subject.key, nw.subject.provider, nw.subject.model, nw.subject.effort], [true, 'gate', 'w1', 'claude', 'haiku', 'low']);
  const fm = await ran('worker-folder-made');
  assert.deepEqual([fm.subject.key, fm.subject.folder], ['w1', made.folder]); assert.equal(typeof fm.subject.branch, 'string');

  // sprint_scripts: every agent of the sprint can read what is approved, what the file holds, and the runs.
  const read = await L.tool('sprint_scripts');
  assert.deepEqual([read.sprint, read.approved.by, read.approved.scripts.length, read.file.scripts.map((x) => x.name), read.pending], [sprint, 'owner', 6, ['evil'], true], JSON.stringify(read).slice(0, 400));
  assert.deepEqual([read.points, read.blocking, read.fired], [POINTS, BLOCKING, FIRED]);
  assert.ok(read.log.some((l) => / \| before-new-worker \| gate \| exit 0 \| /.test(l)), read.log.join('\n'));
  assert.equal((await L.tool('sprint_scripts', { sprint: '00000000-0000-4000-8000-000000000000' })).error, 'unknown-sprint');
  // The owner's next press must name the changed file too.
  got = await press({ hooks: shown.hash }); assert.deepEqual([got.status, got.body.error], [409, 'scripts-changed']);

  // before-new-worker, blocking: its failure refuses the worker by name; no chat is made.
  fs.writeFileSync(path.join(ws, 'refuse-before-new-worker'), '');
  const count = (await rows(instance)).length;
  const no = await L.tool('open_chat', { text: 'config', key: 'w2' });
  assert.deepEqual([no.error, no.script, no.point, no.exit], ['script-refused', 'gate', 'before-new-worker', 3], JSON.stringify(no));
  assert.match(no.detail, /no: before-new-worker$/);
  assert.equal((await rows(instance)).length, count, 'a refused worker was made');
  fs.rmSync(path.join(ws, 'refuse-before-new-worker'));

  // before-ready: told the worker, its item and commit; the state now lists the worker.
  const turns = async () => (await events(instance, made.chat)).filter((e) => e.type === 'turn-end').length;
  await eventually(turns, 'the worker\'s first turn');
  assert.equal((await L.tool('send_chat', { chat: made.chat, text: 'mcp' })).error, undefined);
  const W = await attach(t, instance, made.chat);
  await eventually(async () => (await turns()) >= 2, 'the worker\'s second turn');
  await L.tool('send_chat', { chat: made.chat, text: 'late' }); // the fake agent's long turn: ready is called inside a turn
  const head = g(made.folder, 'rev-parse', 'HEAD');
  const ready = await W.tool('ready', { commit: head, results: [{ check: 'check', result: 'passed' }], weakest: 'not live' });
  assert.ok(ready.ready, JSON.stringify(ready));
  const br = await ran('before-ready');
  assert.deepEqual([br.script.name, br.blocking, br.subject.chat, br.subject.key, br.subject.item, br.subject.commit], ['rdy', false, made.chat, 'w1', 'B4', head]);
  assert.deepEqual(br.workers.map((w) => w.key), ['lead', 'w1']);
  assert.equal(br.workers[1].task.item, 'B4'); assert.equal(br.workers[1].folder, made.folder);
  assert.equal(out().some((r) => r.point === 'before-merge'), false, 'a point P9 does not fire ran');
  console.log('PASS S19: Start approves scripts by hash; before-start, sprint-start, before-new-worker, worker-folder-made, before-ready ran with the state; the file edited after Start ran nothing; blocking failures refused by name');
});
