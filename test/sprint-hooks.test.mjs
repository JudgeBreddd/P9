// Sprint scripts (sprint spec S19; SECURITY.md § Sprint scripts): hooks.json names commands P9 runs at fixed points of a
// sprint, each given the sprint's state as JSON on stdin. Only the copy the owner approved at Start runs: a file edited
// after Start runs nothing until Start is pressed again. A blocking script that fails refuses the action by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { parse, run, said, clean, createHooks, POINTS, BLOCKING, FIRED } from '../apps/server/sprint-hooks.mjs';
import { planItems, hashOf } from '../apps/server/sprint-files.mjs';
import { createDelegate } from '../apps/server/delegate.mjs';
import { remoteOk } from '../apps/server/worker-folders.mjs';

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
  assert.ok(BLOCKING.every((p) => POINTS.includes(p)) && FIRED.every((p) => POINTS.includes(p)) && POINTS.length === 13);
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
  // A program the script started keeps the script's output open: the run still ends, at the script's end or the limit.
  fs.writeFileSync(path.join(dir, 'hold.mjs'), `import { spawn } from 'node:child_process'; import fs from 'node:fs';
const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit', detached: true }); kid.unref();
fs.writeFileSync('kid-' + (process.argv[2] ?? 'go'), String(kid.pid)); console.log('bye'); if (process.argv[2] === 'stay') setTimeout(() => {}, 60000);`);
  const endKid = (name) => { try { process.kill(Number(fs.readFileSync(path.join(dir, 'kid-' + name), 'utf8')), 'SIGKILL'); } catch { /* gone */ } };
  try {
    const held = await run(`${node} hold.mjs stay`, '{}', { cwd: dir, timeout: 1500 });
    assert.deepEqual([held.exit, held.reason, held.ms < 6000], [null, 'timeout', true], 'a held pipe kept a timed-out run open: ' + JSON.stringify(held));
    const gone = await run(`${node} hold.mjs`, '{}', { cwd: dir, timeout: 15000 });
    assert.deepEqual([gone.exit, gone.reason, gone.line, gone.ms < 6000], [0, null, 'bye', true], 'a held pipe kept a finished run open: ' + JSON.stringify(gone));
  } finally { endKid('stay'); endKid('go'); }
  delete process.env.P9_TEST_SECRET;
  console.log('PASS S19 unit: hooks.json refusals by row and field; run passes stdin, keeps the last line, times out, runs no shell; a program holding the output does not hold the run');
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
let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', async () => { const j = JSON.parse(s), here = import.meta.dirname;
  fs.appendFileSync(path.join(here, 'hook-out.jsonl'), JSON.stringify({ ...j, cwd: process.cwd() }) + '\\n');
  while (fs.existsSync(path.join(here, 'hold-' + j.point))) await new Promise((r) => setTimeout(r, 50));
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
  let before = (await rows(instance)).length;
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
  // A switch turned while before-start runs (it may take a minute) is obeyed: nothing is recorded or made. (O174: Delegation
  // Off no longer applies to the user's own press, so the switches are turned under an agent's start_sprint below.)
  const hold = path.join(ws, 'hold-before-start'), was = (await call(instance, '/delegation')).body;
  let going;
  // An agent's start_sprint and the agent lock: the user's yes, then the lock while the script runs.
  const asker = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation;
  await call(instance, `/chat/${asker}/prompt`, 'POST', { text: 'mcp', mode: 'Auto' });
  const A = await attach(t, instance, asker);
  fs.writeFileSync(hold, '');
  going = A.tool('start_sprint', { sprint });
  const ask = await eventually(async () => (await events(instance, asker)).find((e) => e.type === 'approval'), 'the start question');
  assert.match(ask.data.toolCall.title, /It also approves these 6 scripts/);
  await call(instance, `/chat/${asker}/answer`, 'POST', { request: ask.data.request, answer: { optionId: 'allow' } });
  await ran('before-start');
  assert.equal((await call(instance, '/agent-lock', 'POST', { on: true })).status, 200);
  fs.rmSync(hold); got = await going;
  assert.equal(got.error, 'agent-lock-on', JSON.stringify(got));
  assert.equal((await call(instance, '/agent-lock', 'POST', { on: false })).status, 200);
  assert.equal((await page()).started, undefined, 'a locked start left an approval record');
  assert.equal((await rows(instance)).length, before + 1, 'a locked start made a chat');
  fs.rmSync(outFile);
  // Held again: start_sprint asked, allowed, and before-start waiting. `during` changes something, then the script ends.
  const heldStart = async (during) => {
    fs.writeFileSync(hold, '');
    const seen = (await events(instance, asker)).filter((e) => e.type === 'approval').length, run = A.tool('start_sprint', { sprint });
    const q = await eventually(async () => (await events(instance, asker)).filter((e) => e.type === 'approval')[seen], 'the start question');
    await call(instance, `/chat/${asker}/answer`, 'POST', { request: q.data.request, answer: { optionId: 'allow' } });
    await ran('before-start'); await during(); fs.rmSync(hold);
    const reply = await run; fs.rmSync(outFile); return reply;
  };
  // The caller's mode narrowed while the script runs (the lock on and off again leaves a chat in Manual): the lead's
  // row asks for Auto, now wider than its caller, so nothing is recorded or made.
  await call(instance, `/chat/${asker}/prompt`, 'POST', { text: 'config', mode: 'Auto' }); await replied(instance, asker, 'config:'); // the lock above left it in Manual
  write('roles.json', JSON.stringify({ folder: 'repo', roles: [{ ...lead, mode: 'Auto' }] }));
  got = await heldStart(async () => { for (const on of [true, false]) assert.equal((await call(instance, '/agent-lock', 'POST', { on })).status, 200); });
  assert.deepEqual([got.error, got.role, got.field], ['role-refused', 'lead', 'mode'], JSON.stringify(got)); assert.match(got.detail, /never wider than you: your mode is Manual/);
  assert.equal((await page()).started, undefined, 'a start wider than its caller left an approval record');
  assert.equal((await rows(instance)).length, before + 1, 'a start wider than its caller made a chat');
  write('roles.json', JSON.stringify({ folder: 'repo', roles: [lead] }));
  // Workers per chat lowered while the script runs (one worker running, 2 -> 1): nothing is recorded or made.
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 2, workers: was.workers ?? [] })).status, 200);
  const kid = await A.tool('open_chat', { text: 'x', title: 'Kid', key: 'kid' }); assert.ok(kid.chat, JSON.stringify(kid));
  got = await heldStart(async () => assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 1, workers: was.workers ?? [] })).status, 200));
  assert.equal(got.error, 'too-many-chats', JSON.stringify(got));
  assert.equal((await page()).started, undefined, 'a start over the lowered limit left an approval record');
  assert.equal((await rows(instance)).length, before + 2, 'a start over the lowered limit made a chat');
  // Delegation turned Off while the script runs: an agent's start (the lead is its chat's worker) is refused.
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 2, workers: was.workers ?? [] })).status, 200); // back to 2: kid holds one place
  got = await heldStart(async () => assert.equal((await call(instance, '/delegation', 'POST', { start: 'off', max: 2, workers: was.workers ?? [] })).status, 200));
  assert.equal(got.error, 'delegate-off', JSON.stringify(got));
  assert.equal((await page()).started, undefined, 'a start refused after its script left an approval record');
  assert.equal((await rows(instance)).length, before + 2, 'a start refused after its script made a chat');
  assert.equal((await call(instance, '/delegation', 'POST', { start: was.start, max: was.max, workers: was.workers ?? [] })).status, 200);

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
  assert.deepEqual(bs.project, { id: project, name: 'Fresh', source: null }, 'O211: a project with no Clone from gives source null');
  assert.deepEqual(bs.roles, [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high', mode: null, owns: null }]);
  assert.deepEqual(bs.items, [{ id: 'B4', text: 'B4: the one item. Role w1', role: 'w1', ticked: false, review: null }]);
  assert.deepEqual([bs.workers, bs.verdicts], [[], []]);
  assert.equal(bs.log.length, 5, 'the earlier refusal and the four held runs are in the state\'s log: ' + JSON.stringify(bs.log)); assert.match(bs.log[0], /check \| exit 3/);
  assert.ok(!JSON.stringify(bs).includes(instance.credentials.token ?? '\u0000no-token'), 'the state carries the daemon\'s token');
  const ss = await ran('sprint-start');
  assert.deepEqual([ss.blocking, ss.script.name, ss.sprint.started.by, ss.sprint.started.plan], [false, 'started', 'owner', listed.started.plan]);
  assert.deepEqual(ss.workers.map((w) => [w.chat, w.key, w.provider, w.folder === null || typeof w.folder === 'string']), [[sprint, 'lead', 'claude', true]]);
  assert.deepEqual(Object.keys(ss.workers[0]).sort(), ['active', 'chat', 'context', 'effort', 'folder', 'key', 'mode', 'model', 'profile', 'provider', 'ready', 'spent', 'state', 'task', 'title', 'verdict', 'waiting'].sort());

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

// S18: the library and the tools. A script saved from one project's sprint is used in another project's sprint; the
// library is only text, so a sprint holds a copy and runs only what its owner approved at Start.
test('Sprint scripts S18: a script saved to the library from project A is added to project B\'s sprint, approved at Start and run there; a library edit changes no sprint; run_sprint_script asks and refuses an unapproved script', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo'), node = process.execPath;
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  const hook = path.join(ws, 'h.mjs'), outFile = path.join(ws, 'h-out.jsonl'), evil = path.join(ws, 'evil.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs'; import path from 'node:path';
let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { fs.appendFileSync(path.join(import.meta.dirname, 'h-out.jsonl'), JSON.stringify({ ...JSON.parse(s), cwd: process.cwd() }) + '\\n'); console.log('ran fine'); });`);
  fs.writeFileSync(evil, `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(import.meta.dirname, 'evil-ran'), '1'); process.exit(7);`);
  const cmd = `${node} ${hook}`, bad = `${node} ${evil}`; assert.ok(cmd.length <= 200 && bad.length <= 200);
  const out = () => (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const noEvil = (what) => assert.equal(fs.existsSync(path.join(ws, 'evil-ran')), false, what);
  // Two projects, a prepared sprint in each, and one chat in each with the tools.
  const side = async (name, dir) => {
    const project = (await call(instance, '/projects', 'POST', { name, work: { kind: 'new', parent: '', name: dir } })).body.project.id;
    const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: name + ' sprint' })).body;
    fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
    fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
    const chat = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation;
    await call(instance, `/chat/${chat}/prompt`, 'POST', { text: 'mcp', mode: 'Auto' });
    const page = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === s.sprint);
    return { project, sprint: s.sprint, folder: s.folder, chat, page, tool: (await attach(t, instance, chat)).tool, file: () => JSON.parse(fs.readFileSync(path.join(s.folder, 'hooks.json'), 'utf8')).scripts };
  };
  const A = await side('Alpha', 'alpha'), B = await side('Beta', 'beta');
  const row = { name: 'notify', command: cmd, point: 'sprint-start' }, kept = { ...row, blocking: false };
  const answer = async (who, seen, optionId) => {
    const q = await eventually(async () => (await events(instance, who)).filter((e) => e.type === 'approval')[seen], 'the run question');
    await call(instance, `/chat/${who}/answer`, 'POST', { request: q.data.request, answer: { optionId } }); return q;
  };
  const asks = async (who) => (await events(instance, who)).filter((e) => e.type === 'approval').length;

  // A: a script into its own sprint (no hooks.json yet), then the same one into the library.
  let got = await A.tool('sprint_script_save', { ...row, sprint: A.sprint });
  assert.deepEqual([got.error, got.sprint, got.file.scripts, got.pending], [undefined, A.sprint, [kept], true], JSON.stringify(got));
  assert.deepEqual(A.file(), [kept]);
  assert.equal((await A.page()).files.find((f) => f.name === 'hooks.json').hash, got.file.hash, 'the tool\'s hash is the file\'s');
  got = await A.tool('sprint_script_save', { ...row, library: true });
  assert.deepEqual([got.error, got.library], [undefined, [kept]], JSON.stringify(got));
  // Refused by row and field, and nothing kept; the library and a sprint are never both named.
  got = await A.tool('sprint_script_save', { name: 'long', command: 'x'.repeat(201), point: 'sprint-start', library: true });
  assert.equal(got.error, 'scripts-refused', JSON.stringify(got)); assert.match(got.detail, /The library, script 2 \(long\), command/);
  got = await A.tool('sprint_script_save', { name: 'gate', command: cmd, point: 'sprint-start', blocking: true, sprint: A.sprint });
  assert.equal(got.error, 'scripts-refused', JSON.stringify(got)); assert.match(got.detail, /hooks\.json, script 2 \(gate\), blocking/);
  assert.equal((await A.tool('sprint_script_save', { ...row, library: true, sprint: A.sprint })).error, 'request-refused');
  assert.equal((await A.tool('sprint_script_remove', { name: 'nope', sprint: A.sprint })).error, 'unknown-script');
  assert.equal((await A.tool('sprint_script_add', { name: 'nope', sprint: A.sprint })).error, 'unknown-script');
  assert.equal((await A.tool('sprint_script_save', { ...row, sprint: B.sprint })).error, 'unknown-sprint', 'a chat wrote another project\'s sprint');
  assert.deepEqual(A.file(), [kept]);
  // Nothing was approved: a script in hooks.json is refused by name, and nobody is asked.
  got = await A.tool('run_sprint_script', { name: 'notify', sprint: A.sprint });
  assert.deepEqual([got.error, got.name], ['script-not-approved', 'notify'], JSON.stringify(got)); assert.match(got.detail, /in hooks\.json and the user has not approved it/);
  assert.equal(await asks(A.chat), 0, 'the user was asked about a script nobody approved'); assert.deepEqual(out(), []);

  // B, another project: the library is the same one. A library-only script is refused by name; added, it is a copy.
  let read = await B.tool('sprint_scripts', { sprint: B.sprint });
  assert.deepEqual([read.library, read.file.scripts, read.approved], [[kept], [], null], JSON.stringify(read).slice(0, 600));
  got = await B.tool('run_sprint_script', { name: 'notify', sprint: B.sprint });
  assert.equal(got.error, 'script-not-approved', JSON.stringify(got)); assert.match(got.detail, /only in the library/);
  fs.writeFileSync(path.join(B.folder, 'hooks.json'), JSON.stringify({ scripts: [{ name: 'notify', command: bad, point: 'before-merge' }, { name: 'other', command: cmd, point: 'before-ready' }] }));
  got = await B.tool('sprint_script_add', { name: 'notify', sprint: B.sprint });
  assert.deepEqual([got.error, got.file.scripts.map((x) => [x.name, x.command, x.point])], [undefined, [['notify', cmd, 'sprint-start'], ['other', cmd, 'before-ready']]], JSON.stringify(got));
  assert.equal((await B.tool('sprint_script_remove', { name: 'other', sprint: B.sprint })).error, undefined);
  assert.deepEqual(B.file(), [kept]);
  got = await B.tool('run_sprint_script', { name: 'notify', sprint: B.sprint });
  assert.equal(got.error, 'script-not-approved', 'adding a script approved it: ' + JSON.stringify(got)); assert.deepEqual(out(), []);

  // The owner starts B naming the file: the script is approved and runs at sprint-start, in B's folder with B's state.
  const shown = (await B.page()).files.find((f) => f.name === 'hooks.json');
  // O211: B's Clone from carries a password, a query token and a fragment token (the save accepts all three); the script is told the address without it.
  assert.equal((await call(instance, `/projects/${B.project}/sprint-settings`, 'POST', { source: 'ssh://git:hunter2@example.com/o/r.git?access_token=hunter2#token=hunter2', setup: '' })).status, 200);
  const start = await call(instance, `/sprints/${B.sprint}/start`, 'POST', { hooks: shown.hash });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.deepEqual((await B.page()).started.scripts, [kept]);
  const ss = await eventually(() => out().find((r) => r.point === 'sprint-start'), 'sprint-start never ran in B');
  assert.deepEqual([ss.sprint.id, ss.project.name, ss.cwd, ss.script, ss.subject], [B.sprint, 'Beta', fs.realpathSync(B.folder), { name: 'notify' }, null]);
  assert.equal(ss.project.source, 'ssh://example.com/o/r.git', 'O211: the Clone from reached the script with its user and password');
  assert.ok(!JSON.stringify(ss).includes('hunter2'), 'O211: the Clone from password is somewhere in a script\'s state');

  // The library changed and emptied afterwards: B's file, B's approved copy and what runs there stay as they were.
  got = await A.tool('sprint_script_save', { name: 'notify', command: bad, point: 'sprint-start', library: true });
  assert.deepEqual(got.library.map((x) => x.command), [bad], JSON.stringify(got));
  assert.deepEqual(B.file(), [kept]); assert.deepEqual((await B.page()).started.scripts, [kept]);

  // run_sprint_script: the user is asked, shown the whole command; a no runs nothing; a yes runs the approved copy.
  assert.equal((await call(instance, '/file-protection', 'POST', { on: true })).status, 200); // not Unrestricted: the tools ask
  let run = B.tool('run_sprint_script', { name: 'notify', sprint: B.sprint });
  let q = await answer(B.chat, 0, 'reject');
  assert.ok(q.data.toolCall.title.includes(`notify (sprint-start): ${cmd}`), q.data.toolCall.title); assert.equal(q.data.toolCall.kind, 'execute');
  got = await run; assert.equal(got.error, 'not-allowed', JSON.stringify(got)); assert.equal(out().length, 1, 'a declined run ran');
  run = B.tool('run_sprint_script', { name: 'notify', sprint: B.sprint }); await answer(B.chat, 1, 'allow'); got = await run;
  assert.deepEqual([got.error, got.sprint, got.script, got.point, got.exit, got.reason, got.line], [undefined, B.sprint, 'notify', 'sprint-start', 0, null, 'ran fine'], JSON.stringify(got));
  const byTool = got; // O162: compared below with the same script run from the page
  assert.equal(out().length, 2); const first1 = out()[1], manual = () => out().filter((r) => r.subject?.manual);
  assert.deepEqual([first1.sprint.id, first1.cwd, first1.point, first1.blocking, first1.subject], [B.sprint, fs.realpathSync(B.folder), 'sprint-start', false, { manual: true, by: B.chat }]);
  noEvil('the library\'s later command ran in a sprint that approved the earlier one');
  // Approved again as another row while the user is asked: the yes is for the row shown, so nothing runs.
  const moved = { ...kept, command: cmd + ' again', point: 'after-close' }; // a point nothing fires
  fs.writeFileSync(path.join(B.folder, 'hooks.json'), JSON.stringify({ scripts: [moved] }));
  run = B.tool('run_sprint_script', { name: 'notify', sprint: B.sprint });
  q = await eventually(async () => (await events(instance, B.chat)).filter((e) => e.type === 'approval')[2], 'the third run question');
  assert.ok(q.data.toolCall.title.includes(`notify (sprint-start): ${cmd}`) && !q.data.toolCall.title.includes('again'), q.data.toolCall.title);
  got = await call(instance, `/sprints/${B.sprint}/start`, 'POST', { hooks: (await B.page()).files.find((f) => f.name === 'hooks.json').hash });
  assert.deepEqual([got.status, (await B.page()).started.scripts.map((x) => x.command)], [200, [moved.command]], JSON.stringify(got.body));
  await call(instance, `/chat/${B.chat}/answer`, 'POST', { request: q.data.request, answer: { optionId: 'allow' } });
  got = await run; assert.equal(got.error, 'scripts-changed', JSON.stringify(got)); assert.deepEqual([out().length, manual().length], [2, 1], 'a changed script ran on the old yes');
  fs.writeFileSync(path.join(B.folder, 'hooks.json'), JSON.stringify({ scripts: [kept] }));
  got = await call(instance, `/sprints/${B.sprint}/start`, 'POST', { hooks: (await B.page()).files.find((f) => f.name === 'hooks.json').hash });
  assert.deepEqual([got.status, (await B.page()).started.scripts], [200, [kept]], JSON.stringify(got.body));
  // The owner's own run (the project page): no question, the same refusal by name.
  got = await call(instance, `/sprints/${B.sprint}/run-script`, 'POST', { name: 'notify' });
  assert.deepEqual([got.status, got.body.exit, got.body.line], [200, 0, 'ran fine'], JSON.stringify(got.body));
  assert.deepEqual(manual()[1].subject, { manual: true, by: 'owner' }); assert.equal(await asks(B.chat), 3);
  // O162: a script run from the page does what the same script run by the agent does: the same answer and the same input
  // on stdin, but for who ran it, the clock (the run's ms and the times in the sprint's state) and the log, which the
  // page run sees one line longer: the agent's own run, just before it.
  const steady = (v) => JSON.parse(JSON.stringify(v, (k, x) => (['at', 'ms', 'running_ms', 'active', 'log'].includes(k) ? 0 : k === 'by' && (x === 'owner' || x === B.chat) ? 'runner' : x)));
  assert.deepEqual(steady(got.body), steady(byTool), 'the page run answered differently: ' + JSON.stringify([got.body, byTool]));
  assert.deepEqual(steady(manual()[1]), steady(manual()[0]), 'the page run got different input: ' + JSON.stringify([manual()[1], manual()[0]]).slice(0, 3000));
  assert.deepEqual(manual()[1].log.slice(0, -1), manual()[0].log); assert.match(manual()[1].log.at(-1), / \| sprint-start \(run now\) \| notify \| exit 0 \| \d+ ms \| ran fine$/);
  got = await call(instance, `/sprints/${A.sprint}/run-script`, 'POST', { name: 'notify' });
  assert.deepEqual([got.status, got.body.error], [409, 'script-not-approved'], JSON.stringify(got.body));
  assert.equal((await call(instance, `/sprints/${B.sprint}/run-script`, 'POST', { name: 'notify', command: bad })).status, 400);
  read = await B.tool('sprint_scripts', { sprint: B.sprint });
  assert.equal(read.log.filter((l) => / \| sprint-start \(run now\) \| notify \| exit 0 \| /.test(l)).length, 2, read.log.join('\n'));
  assert.equal(read.pending, false);

  // The owner's library routes: read, save, remove; a refused row names its field.
  got = await call(instance, '/sprint-scripts'); assert.deepEqual([got.status, got.body.library.map((x) => x.name)], [200, ['notify']]);
  got = await call(instance, '/sprint-scripts', 'POST', { save: { name: 'mine', command: cmd, point: 'before-start', blocking: true } });
  assert.deepEqual([got.status, got.body.library.map((x) => [x.name, x.blocking])], [200, [['notify', false], ['mine', true]]], JSON.stringify(got.body));
  got = await call(instance, '/sprint-scripts', 'POST', { save: { name: 'mine', command: cmd, point: 'whenever' } });
  assert.deepEqual([got.status, got.body.error], [400, 'scripts-refused']); assert.match(got.body.detail, /\(mine\), point/);
  assert.equal((await call(instance, '/sprint-scripts', 'POST', { save: { name: 'x', command: cmd, point: 'before-start' }, remove: 'mine' })).status, 400);
  got = await call(instance, '/sprint-scripts', 'POST', { remove: 'notify' }); assert.deepEqual([got.status, got.body.library.map((x) => x.name)], [200, ['mine']]);
  assert.equal((await call(instance, '/sprint-scripts', 'POST', { remove: 'notify' })).status, 404);
  // The same routes with a sprint named write that sprint's hooks.json (the page's Sprint scripts window), checked the same way.
  got = await call(instance, '/sprint-scripts'); assert.deepEqual([got.body.points, got.body.blocking], [POINTS, BLOCKING]);
  got = await call(instance, '/sprint-scripts', 'POST', { add: 'mine', sprint: A.sprint });
  assert.deepEqual([got.status, got.body.file.scripts.map((x) => x.name), got.body.pending], [200, ['notify', 'mine'], true], JSON.stringify(got.body));
  got = await call(instance, '/sprint-scripts', 'POST', { save: { name: 'own', command: cmd, point: 'after-close' }, sprint: A.sprint });
  assert.deepEqual([got.status, A.file().map((x) => x.name)], [200, ['notify', 'mine', 'own']], JSON.stringify(got.body));
  got = await call(instance, '/sprint-scripts', 'POST', { save: { name: 'own', command: cmd, point: 'after-close', blocking: true }, sprint: A.sprint });
  assert.deepEqual([got.status, got.body.error], [400, 'scripts-refused'], JSON.stringify(got.body));
  got = await call(instance, '/sprint-scripts', 'POST', { remove: 'mine', sprint: A.sprint }); assert.deepEqual([got.status, A.file().map((x) => x.name)], [200, ['notify', 'own']]);
  assert.equal((await call(instance, '/sprint-scripts', 'POST', { remove: 'mine', sprint: A.sprint })).status, 404);
  assert.equal((await call(instance, '/sprint-scripts', 'POST', { add: 'mine' })).status, 400);
  assert.equal((await call(instance, '/sprint-scripts', 'POST', { add: 'mine', sprint: '00000000-0000-4000-8000-000000000000' })).status, 404);
  assert.deepEqual((await call(instance, '/sprint-scripts')).body.library.map((x) => x.name), ['mine'], 'a sprint write changed the library');
  assert.deepEqual((await A.tool('sprint_scripts')).error, 'unknown-sprint'); // A's chat leads no sprint: it names one
  assert.deepEqual((await A.tool('sprint_scripts', { sprint: A.sprint })).library.map((x) => x.name), ['mine']);
  assert.deepEqual(B.file(), [kept]); assert.deepEqual((await B.page()).started.scripts, [kept]);

  // The agent lock: no tool writes or runs.
  assert.equal((await call(instance, '/agent-lock', 'POST', { on: true })).status, 200);
  for (const [name, args] of [['sprint_script_save', { ...row, library: true }], ['sprint_script_save', { ...row, name: 'two', sprint: B.sprint }], ['sprint_script_remove', { name: 'mine', library: true }],
    ['sprint_script_remove', { name: 'notify', sprint: B.sprint }], ['sprint_script_add', { name: 'mine', sprint: B.sprint }], ['run_sprint_script', { name: 'notify', sprint: B.sprint }]]) {
    assert.equal((await B.tool(name, args)).error, 'agent-lock-on', name + ' ' + JSON.stringify(args));
  }
  assert.equal((await call(instance, '/agent-lock', 'POST', { on: false })).status, 200);
  assert.deepEqual((await call(instance, '/sprint-scripts')).body.library.map((x) => x.name), ['mine']); assert.deepEqual(B.file(), [kept]);
  assert.equal(manual().length, 2, 'a locked run ran'); assert.equal(await asks(B.chat), 3, 'a locked run asked');
  // Unrestricted mode (the user turned the asks off): the approved script runs with no question; the refusal stays.
  assert.equal((await call(instance, '/file-protection', 'POST', { on: false })).status, 200);
  got = await B.tool('run_sprint_script', { name: 'notify', sprint: B.sprint });
  assert.deepEqual([got.exit, manual().length, await asks(B.chat)], [0, 3, 3], JSON.stringify(got));
  assert.equal((await B.tool('run_sprint_script', { name: 'mine', sprint: B.sprint })).error, 'script-not-approved');
  noEvil('a script nobody approved ran');
  console.log('PASS S18: library saved in A, added in B, approved at Start and run there; a library edit changed no sprint; run_sprint_script asked, ran the approved copy, ran nothing when the approved copy changed while it asked, refused unapproved and library-only scripts; the lock refused every write and run');
});

// The state a run is given is gathered with waits (the usage reading among them). A lock, a cancel or a new Start that
// lands in that wait must still stop the run: the checks are repeated right before the start. The hooks are built here
// on a stand-in chat service whose usage reading is held open, so the test decides what happens during the wait.
test('Sprint scripts S18 held: run_sprint_script checks the cancel, the agent lock and the approved copy again right before it starts the script', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-held-')), mark = path.join(dir, 'ran'), prog = path.join(dir, 'mark.mjs');
  fs.writeFileSync(prog, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(mark)}, 'x');\n`);
  const id = '11111111-1111-4111-8111-111111111111', script = { name: 'mark', command: `${process.execPath} ${prog}`, point: 'sprint-start', blocking: false };
  const held = async (during) => {
    let lock = false, scripts = [script], reached, release; const at = new Promise((r) => { reached = r; }), ac = new AbortController();
    const chat = { lock: () => ({ on: lock }), info: (c) => (c === id ? { title: 'S', provider: 'fake' } : null), family: () => [{ id }], list: () => [{ id }],
      sprint: () => ({}), gauge: () => null, startFolder: async () => dir, scriptLibrary: () => [], allowScripts: () => false,
      sprintFiles: { exists: (c) => c === id, read: () => null, folderOf: () => dir, log: () => {} },
      projects: { merge: () => true, started: () => ({ at: 1, by: 'owner', plan: null, scripts }), closed: () => null, prepOf: () => null, record: async () => null } };
    const hooks = createHooks({ chat, usage: () => { reached(); return new Promise((r) => { release = r; }); }, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
    const going = hooks.run(id, { name: 'mark' }, ac.signal);
    await at; // the user said yes, every first check passed, and the run now waits for the state
    during({ lockOn: () => { lock = true; }, cancel: () => ac.abort(), restart: () => { scripts = [{ ...script, command: script.command + ' changed' }]; } });
    release(null);
    return going;
  };
  assert.equal((await held((d) => d.cancel())).error, 'cancelled');
  assert.equal((await held((d) => d.lockOn())).error, 'agent-lock-on');
  assert.equal((await held((d) => d.restart())).error, 'scripts-changed');
  assert.equal(fs.existsSync(mark), false, 'a script ran after a cancel, the lock or a new Start landed while its state was gathered');
  const ran = await held(() => {});
  assert.deepEqual([ran.exit, ran.script, fs.readFileSync(mark, 'utf8')], [0, 'mark', 'x'], JSON.stringify(ran));
  console.log('PASS S18 held: a cancel, the agent lock and a changed approval during the wait for the state each ran nothing; with none of them the script ran once');
});

// #232 FIX1 (c): the owner's Run now waits for the state too; a Close landing in that wait runs nothing.
test('Sprint scripts held: the owner\'s Run now checks for a Close again right before it starts the script', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-held-owner-')), mark = path.join(dir, 'ran'), prog = path.join(dir, 'mark.mjs');
  fs.writeFileSync(prog, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(mark)}, 'x');\n`);
  const id = '22222222-2222-4222-8222-222222222222', script = { name: 'mark', command: `${process.execPath} ${prog}`, point: 'sprint-start', blocking: false };
  const held = async (during) => {
    let closed = null, reached, release; const at = new Promise((r) => { reached = r; });
    const chat = { lock: () => ({ on: false }), info: (c) => (c === id ? { title: 'S', provider: 'fake' } : null), family: () => [{ id }], list: () => [{ id }],
      sprint: () => ({}), gauge: () => null, startFolder: async () => dir, scriptLibrary: () => [], allowScripts: () => false,
      sprintFiles: { exists: (c) => c === id, read: () => null, folderOf: () => dir, log: () => {} },
      projects: { merge: () => true, started: () => ({ at: 1, by: 'owner', plan: null, scripts: [script] }), closed: () => closed, prepOf: () => null, record: async () => null } };
    const hooks = createHooks({ chat, usage: () => { reached(); return new Promise((r) => { release = r; }); }, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true });
    const going = hooks.owner.run(id, 'mark');
    await at; // every first check passed and the run now waits for the state
    during({ close: () => { closed = { at: 2, by: 'owner' }; } });
    release(null);
    return going;
  };
  assert.equal((await held((d) => d.close())).error, 'sprint-closed');
  assert.equal(fs.existsSync(mark), false, 'the owner\'s Run now started its script after the sprint closed during the wait for the state');
  const ran = await held(() => {});
  assert.deepEqual([ran.exit, ran.script, fs.readFileSync(mark, 'utf8')], [0, 'mark', 'x'], JSON.stringify(ran));
  console.log('PASS owner held: a Close during the wait for the state ran nothing (sprint-closed); with no Close the script ran once');
});

// #229 FIX1. The window's Approve sends the hash of the hooks.json it showed. The hash check and the rows approved must
// come from one read of the file: with two reads, a writer between them gets a row nobody saw approved under the hash
// of the row that was shown. The stand-in file here answers A to the first read and B to every later one.
test('Sprint scripts S20 one read: the owner\'s Approve approves the rows of the text whose hash it checked, and the window is given the hash of the rows it is shown, when hooks.json is replaced between two reads', { timeout: 60000 }, async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const file = (command) => JSON.stringify({ scripts: [{ name: 'x', command, point: 'sprint-start' }] });
  const A = file('/bin/echo shown'), B = file('/bin/echo unseen');
  const made = (texts) => {
    let n = 0, record = { at: 1, by: 'owner', plan: null, scripts: [] };
    const chat = { lock: () => ({ on: false }), info: () => ({ title: 'S', provider: 'fake' }), family: () => [{ id }], list: () => [{ id }],
      sprint: () => ({}), gauge: () => null, scriptLibrary: () => [], allowScripts: () => false,
      sprintFiles: { exists: (c) => c === id, read: (c, name) => (name === 'hooks.json' ? texts[Math.min(n++, texts.length - 1)] : null), log: () => {} },
      projects: { merge: () => true, started: () => record, closed: () => null, prepOf: () => null, recordStart: (c, next) => { record = next; } } };
    return { owner: createHooks({ chat, usage: () => null, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true }).owner, extra: () => record.extra ?? [] };
  };
  const shown = made([A, B]), lib = shown.owner.library(id);
  assert.deepEqual([lib.hash, lib.waiting.map((r) => r.command)], [hashOf(A), ['/bin/echo shown']], 'the window was given the hash of one text and the rows of another');
  const swapped = made([A, B]), got = swapped.owner.approve(id, hashOf(A), ['x']);
  assert.deepEqual([got.approved?.map((r) => r.command), swapped.extra().map((r) => r.command)], [['/bin/echo shown'], ['/bin/echo shown']], 'Approve approved a row it never checked: ' + JSON.stringify(got));
  assert.deepEqual(got.additional.waiting.map((r) => r.command), ['/bin/echo unseen'], 'the row written after the check must wait');
  const late = made([B]), refused = late.owner.approve(id, hashOf(A), ['x']);
  assert.deepEqual([refused.error, late.extra()], ['scripts-changed', []], JSON.stringify(refused));
  console.log('PASS S20 one read: a hooks.json replaced between two reads never has its unseen row approved; the window\'s hash is of the rows it is shown; a file already replaced refuses');
});

test('Sprint scripts S20: a script added after Start waits with "Allow additional scripts" off until the user approves it (one question for a batch, a change asks again) and runs with no question when the switch is on', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo'), node = process.execPath;
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false }); // Unrestricted: the question below is still asked
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  // Each script leaves its own mark; a gate exits with its own code, so which copy ran is read from the refusal.
  const script = (name, exit) => { const f = path.join(ws, name + '.mjs'); fs.writeFileSync(f, `import fs from 'node:fs'; import path from 'node:path'; fs.appendFileSync(path.join(import.meta.dirname, '${name}.ran'), '1'); process.exit(${exit});`); return `${node} ${f}`; };
  const ran = (name) => (fs.existsSync(path.join(ws, name + '.ran')) ? fs.readFileSync(path.join(ws, name + '.ran'), 'utf8').length : 0);
  const project = (await call(instance, '/projects', 'POST', { name: 'Gamma', work: { kind: 'new', parent: '', name: 'gamma' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Later scripts' })).body, sprint = s.sprint;
  const low = { provider: 'claude', model: 'haiku', effort: 'low' };
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  const atStart = { name: 'notify', command: script('notify', 0), point: 'sprint-start', blocking: false };
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: [atStart] }));
  const page = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint);
  const hash = async () => (await page()).files.find((f) => f.name === 'hooks.json').hash;
  assert.equal((await call(instance, `/sprints/${sprint}/approve-scripts`, 'POST', { hash: await hash() })).body.error, 'sprint-not-started');
  assert.equal((await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: await hash() })).status, 200);
  await eventually(() => ran('notify') === 1, 'sprint-start never ran');
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill({ agent: 'claude', model: 'haiku', effort: 'low' }) })).status, 200);
  const L = await attach(t, instance, sprint);
  // The worker roles come after Start, so Start made no chat for them: each open_chat below is a new worker and fires before-new-worker.
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'w1', ...low }, { key: 'w2', ...low }] }));
  const asked = async () => (await events(instance, sprint)).filter((e) => e.type === 'approval');
  const answer = async (seen, optionId) => {
    const q = await eventually(async () => (await asked())[seen], 'the approve question');
    await call(instance, `/chat/${sprint}/answer`, 'POST', { request: q.data.request, answer: { optionId } }); return q.data.toolCall.title;
  };
  const names = (rows) => rows.map((r) => r.name);
  const stands = async () => { const r = await L.tool('sprint_scripts'); return [r.additional.allowed, names(r.additional.running), names(r.additional.waiting)]; };

  // Off is the default. Nothing waits right after Start, and there is nothing to ask.
  assert.deepEqual(await stands(), [false, [], []]);
  let got = await L.tool('request_sprint_scripts');
  assert.deepEqual([got.error, got.approved, (await asked()).length], [undefined, [], 0], JSON.stringify(got));

  // The agent adds a blocking gate after Start: it waits. The worker it would refuse is made, and Run now refuses it.
  const stop = { name: 'stop', command: script('stop', 3), point: 'before-new-worker', blocking: true };
  got = await L.tool('sprint_script_save', stop); assert.equal(got.error, undefined, JSON.stringify(got));
  assert.deepEqual(await stands(), [false, [], ['stop']]);
  const w1 = await L.tool('open_chat', { text: 'config', key: 'w1' });
  assert.ok(w1.chat && !w1.error && !w1.existing, 'a waiting script refused the worker: ' + JSON.stringify(w1)); assert.equal(ran('stop'), 0, 'a script nobody approved ran');
  assert.equal((await L.tool('run_sprint_script', { name: 'stop' })).error, 'script-not-approved');
  assert.equal((await call(instance, `/sprints/${sprint}/run-script`, 'POST', { name: 'stop' })).body.error, 'script-not-approved');

  // A batch is one question, each row whole. No: nothing is approved.
  const two = { name: 'two', command: script('two', 0), point: 'worker-folder-made', blocking: false };
  await L.tool('sprint_script_save', two);
  let ask = L.tool('request_sprint_scripts'), title = await answer(0, 'reject'); got = await ask;
  assert.ok(title.includes('these 2 scripts') && title.includes(`stop (before-new-worker, blocking): ${stop.command}`) && title.includes(`two (worker-folder-made): ${two.command}`), title);
  assert.deepEqual([got.error, await stands()], ['not-allowed', [false, [], ['stop', 'two']]], JSON.stringify(got));
  // Changed while the user is asked: the yes approves nothing.
  const three = { name: 'three', command: script('three', 0), point: 'worker-folder-made', blocking: false };
  ask = L.tool('request_sprint_scripts'); await eventually(async () => (await asked())[1], 'the second question');
  assert.equal((await call(instance, '/sprint-scripts', 'POST', { save: three, sprint })).status, 200);
  await answer(1, 'allow'); got = await ask;
  assert.deepEqual([got.error, await stands()], ['scripts-changed', [false, [], ['stop', 'two', 'three']]], JSON.stringify(got));
  // The owner's own Approve: refused on a file that is not the one shown, then one row by name.
  got = await call(instance, `/sprints/${sprint}/approve-scripts`, 'POST', { hash: 'f'.repeat(64), names: ['three'] });
  assert.deepEqual([got.status, got.body.error], [409, 'scripts-changed'], JSON.stringify(got.body));
  assert.equal((await call(instance, `/sprints/${sprint}/approve-scripts`, 'POST', { hash: await hash(), names: [] })).status, 400);
  got = await call(instance, `/sprints/${sprint}/approve-scripts`, 'POST', { hash: await hash(), names: ['three'] });
  assert.deepEqual([got.status, names(got.body.approved), await stands()], [200, ['three'], [false, ['three'], ['stop', 'two']]], JSON.stringify(got.body));
  // Yes: the two left are approved by one question, and the gate now refuses the next worker with its own exit.
  ask = L.tool('request_sprint_scripts'); title = await answer(2, 'allow'); got = await ask;
  assert.ok(title.includes('these 2 scripts') && !title.includes('three ('), title);
  assert.deepEqual([got.error, names(got.approved), await stands(), (await asked()).length], [undefined, ['stop', 'two'], [false, ['three', 'stop', 'two'], []], 3], JSON.stringify(got));
  got = await L.tool('open_chat', { text: 'config', key: 'w2' });
  assert.deepEqual([got.error, got.script, got.exit, ran('stop')], ['script-refused', 'stop', 3, 1], JSON.stringify(got));

  // A change asks again: until the yes, the copy the user approved keeps running, not the new text.
  const stop2 = { ...stop, command: script('stop2', 4) };
  await L.tool('sprint_script_save', stop2);
  assert.deepEqual(await stands(), [false, ['three', 'stop', 'two'], ['stop']]);
  got = await L.tool('open_chat', { text: 'config', key: 'w2' });
  assert.deepEqual([got.error, got.exit, ran('stop2')], ['script-refused', 3, 0], 'the changed row ran on the old yes: ' + JSON.stringify(got));
  ask = L.tool('request_sprint_scripts'); title = await answer(3, 'allow'); got = await ask;
  assert.ok(title.includes('this script') && title.includes(stop2.command), title);
  got = await L.tool('open_chat', { text: 'config', key: 'w2' });
  assert.deepEqual([got.error, got.exit, ran('stop2')], ['script-refused', 4, 1], JSON.stringify(got));
  // A row approved at Start is removed from the file by the agent: it still runs (only the next Start drops it).
  assert.equal((await L.tool('sprint_script_remove', { name: 'notify' })).error, undefined);
  got = await call(instance, `/sprints/${sprint}/run-script`, 'POST', { name: 'notify' });
  assert.deepEqual([got.status, got.body.exit, ran('notify')], [200, 0, 2], JSON.stringify(got.body));
  // The agent lock refuses the ask.
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await L.tool('request_sprint_scripts')).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });

  // The switch is the owner's: a route, checked. On: a row the agent adds runs with no question, and a row it removes stops.
  assert.equal((await call(instance, '/sprint-scripts/allow', 'POST', { on: 'yes' })).status, 400);
  got = await call(instance, '/sprint-scripts/allow', 'POST', { on: true }); assert.deepEqual([got.status, got.body], [200, { allowed: true }]);
  await L.tool('sprint_script_remove', { name: 'stop' });
  const free = { name: 'free', command: script('free', 5), point: 'before-new-worker', blocking: true };
  await L.tool('sprint_script_save', free);
  assert.deepEqual(await stands(), [true, ['two', 'three', 'free'], []]);
  got = await L.tool('open_chat', { text: 'config', key: 'w2' });
  assert.deepEqual([got.error, got.script, got.exit, ran('free'), (await asked()).length], ['script-refused', 'free', 5, 1, 4], JSON.stringify(got));
  got = await L.tool('request_sprint_scripts'); assert.deepEqual([got.approved, (await asked()).length], [[], 4]); assert.match(got.detail, /Allow additional scripts is on/);
  // Off again: what ran only because the switch was on waits; what the user approved by name runs as approved.
  await call(instance, '/sprint-scripts/allow', 'POST', { on: false });
  assert.deepEqual(await stands(), [false, ['three', 'two', 'stop'], ['free']]); // stop: the copy approved last, though the file no longer has it
  assert.equal((await L.tool('run_sprint_script', { name: 'free' })).error, 'script-not-approved');
  // The next Start approves the file as it is and drops everything approved since the last one.
  // (Lead only again: Start would make w2's chat, and the gate "free" it approves here would refuse that.)
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  got = await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: await hash() }); assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.deepEqual([await stands(), names((await page()).started.scripts)], [[false, [], []], ['two', 'three', 'free']]);
  console.log('PASS S20: off, an added script waited (worker made, Run now refused); a batch was one question; no and changed-while-asked approved nothing; owner Approve by hash and name; yes ran the gate; a changed row ran the old copy until asked again; a removed Start row still ran; lock refused; on ran an added row with no question; off again it waited; the next Start reset');
});

// Sprint View: the page's route and the agent's tool give one answer, and its numbers are the plan file's.
test('Sprint status: the sprint_status tool and the desktop\'s status route give the same answer, with the plan\'s items, the count done, the time since Start and each worker\'s own work', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  const project = (await call(instance, '/projects', 'POST', { name: 'Delta', work: { kind: 'new', parent: '', name: 'delta' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Watched' })).body, sprint = s.sprint;
  const plan = (two) => `# Plan\n\n- [x] A1: the first thing; role w1\n- [${two ? 'x' : ' '}] A2: the second thing; role w1\n- [ ] B1: the lead's own; role lead\n`;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), plan(false));
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  const route = async (id = sprint) => call(instance, `/sprints/${id}/status`);
  // Not started: the plan's items are there, nothing runs yet.
  let got = await route();
  assert.deepEqual([got.status, got.body.sprint.started, got.body.running_ms, got.body.done, got.body.workers], [200, null, null, { merged: 0, ticked: 1, unproven: 0, total: 3 }, []], JSON.stringify(got.body));
  assert.equal(got.body.prs_per_hour, null, 'PRs an hour before Start'); // O162
  assert.deepEqual([(await route('11111111-1111-4111-8111-111111111111')).status, (await route('nope')).body.error], [404, 'unknown-sprint']);
  assert.equal((await call(instance, `/sprints/${sprint}/start`, 'POST', {})).status, 200);
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill({ agent: 'claude', model: 'haiku', effort: 'low' }) })).status, 200);
  const L = await attach(t, instance, sprint);
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  const w1 = await L.tool('open_chat', { text: 'config', key: 'w1' }); assert.ok(w1.chat && !w1.error, JSON.stringify(w1));
  await replied(instance, w1.chat, 'config:');
  // The moving parts (the clock, a chat's last use and state) are compared apart; the rest must be the same answer.
  const still = (v) => ({ ...v, at: 0, running_ms: 0, workers: v.workers.map((w) => ({ ...w, active: 0, state: 0, waiting: 0, context: 0 })) });
  const both = async () => eventually(async () => { const tool = await L.tool('sprint_status'), page = (await route()).body; try { assert.deepEqual(still(tool), still(page)); return { tool, page }; } catch { return null; } }, 'the tool and the route never agreed');
  let { tool, page } = await both();
  assert.deepEqual([tool.error, 'contract' in tool, 'script' in tool, 'point' in tool], [undefined, false, false, false], JSON.stringify(tool).slice(0, 400));
  assert.deepEqual(tool.items.map((i) => [i.id, i.role, i.ticked]), planItems(plan(false)).map((i) => [i.id, i.role, i.ticked]));
  assert.deepEqual([tool.done, tool.sprint.id, tool.sprint.title, tool.project.id, tool.scripts], [{ merged: 0, ticked: 1, unproven: 0, total: 3 }, sprint, 'Watched', project, { running: 0, additional: 0, waiting: 0 }]);
  assert.deepEqual(tool.workers.map((w) => [w.key, w.chat, w.model, w.work]), [['lead', sprint, 'opus', tool.workers[0].work], ['w1', w1.chat, 'haiku', { done: 0, total: 2 }]], JSON.stringify(tool.workers));
  assert.ok(tool.sprint.started.at && Number.isInteger(tool.running_ms) && tool.running_ms >= 0 && page.running_ms >= tool.running_ms, JSON.stringify([tool.sprint.started, tool.running_ms, page.running_ms]));
  // O162: PRs an hour is the same answer's merged count over its running time, for the tool and the page's route.
  // The rule, written out here: merged per hour since Start, one decimal; within the first hour, the count merged so far.
  const perHour = (merged, ms) => Math.round((merged * 10) / Math.max(1, ms / 3_600_000)) / 10;
  assert.deepEqual([tool.prs_per_hour, page.prs_per_hour], [perHour(tool.done.merged, tool.running_ms), perHour(page.done.merged, page.running_ms)]);
  // A sprint named from a chat of the same project, and from the worker with no name: the same sprint.
  assert.equal((await L.tool('sprint_status', { sprint })).sprint.id, sprint);
  assert.equal((await L.tool('sprint_status', { sprint: '11111111-1111-4111-8111-111111111111' })).error, 'unknown-sprint');
  // The plan changes on disk: both follow.
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), plan(true));
  ({ tool, page } = await both());
  assert.deepEqual([tool.done, page.done], [{ merged: 0, ticked: 2, unproven: 0, total: 3 }, { merged: 0, ticked: 2, unproven: 0, total: 3 }]);
  // Scripts: running is every script that runs (Start's and the ones approved after), additional is the part of it
  // approved after Start, waiting is apart. One of each kind: 2, 1, 1, from the tool and the route.
  const row = (name) => ({ name, command: `/usr/bin/touch ${name}.txt`, point: 'after-close', blocking: false });
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: [row('base')] }));
  got = await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: (await call(instance, '/sprint-scripts?sprint=' + sprint)).body.hash }); assert.equal(got.status, 200, JSON.stringify(got.body));
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: [row('base'), row('later'), row('unseen')] }));
  const shown = (await call(instance, '/sprint-scripts?sprint=' + sprint)).body;
  got = await call(instance, `/sprints/${sprint}/approve-scripts`, 'POST', { hash: shown.hash, names: ['later'] });
  assert.deepEqual([got.status, got.body.approved?.map((r) => r.name)], [200, ['later']], JSON.stringify(got.body));
  ({ tool, page } = await both());
  assert.deepEqual([tool.scripts, page.scripts], [{ running: 2, additional: 1, waiting: 1 }, { running: 2, additional: 1, waiting: 1 }]);
  console.log('PASS Sprint status: scripts 2 running (1 of them additional), 1 waiting; before Start the route gave the plan and no clock; after it the tool and the route agreed, with the plan\'s three items, 1 then 2 ticked, the lead and w1 with w1\'s 0 of 2, the time since Start, and unknown-sprint for a sprint that is not there');
});

// O134 sprint_status: a stopped worker's model comes from its newest config event (chat.gauge, the same read as list_chats).
// A helper's config written before O130 (one model, no pickers, in a chat that lists more) is skipped there, so the
// worker shows its own model. Planted after the worker stops and before anything has read its gauge.
test('O134 sprint_status: a stopped worker shows its own model, not a stored helper config', { timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  fs.mkdirSync(path.join(instance.workspace, 'repo'));
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation; // P9 reads claude's model list
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  const project = (await call(instance, '/projects', 'POST', { name: 'Echo', work: { kind: 'new', parent: '', name: 'echo' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Helped' })).body, sprint = s.sprint;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Plan\n\n- [ ] A1: one thing; role w1\n');
  const roles = [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low' }];
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: roles.slice(0, 1) }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  const started = await call(instance, `/sprints/${sprint}/start`, 'POST', {}); assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill({ agent: 'claude', model: 'haiku', effort: 'low' }) })).status, 200);
  const L = await attach(t, instance, sprint);
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles }));
  const w1 = await L.tool('open_chat', { text: 'config', key: 'w1' }); assert.ok(w1.chat && !w1.error, JSON.stringify(w1));
  await replied(instance, w1.chat, 'config:');
  const own = (await events(instance, w1.chat)).filter((e) => e.type === 'config').at(-1)?.data;
  assert.ok(own?.model?.options?.length > 1 && own.model.current === 'haiku', 'the worker\'s own config: ' + JSON.stringify(own));
  assert.equal((await call(instance, `/chat/${w1.chat}/stop`, 'POST', {})).status < 300, true);
  await eventually(async () => (await rows(instance)).find((c) => c.id === w1.chat)?.state !== 'running', 'the worker never stopped');
  const db = new DatabaseSync(path.join(instance.directory, '.local/state/p9-foundation/p9.db'), { timeout: 5000 });
  db.prepare('INSERT INTO events (conversation, type, data, at) VALUES (?, ?, ?, ?)').run(w1.chat, 'config', JSON.stringify({ model: { current: 'opus', options: [{ value: 'opus', name: 'Opus' }] }, pickers: [] }), Date.now());
  db.close();
  const worker = (await L.tool('sprint_status')).workers.find((w) => w.chat === w1.chat);
  assert.equal(worker?.model, 'haiku', 'sprint_status showed a helper\'s model: ' + JSON.stringify(worker));
  console.log(`PASS O134 sprint_status: the stopped worker shows ${worker.model}; the planted helper Opus config was skipped`);
});

// Close sprint: one action for the button's route and the agent's tool. before-close may refuse it; every chat of the
// sprint is stopped; the record is the status as it stood and no longer moves; the scripts are off afterwards.
test('Close sprint: a before-close script refuses it, the close_sprint tool asks first, every chat of the sprint is stopped, and the status is the kept record afterwards', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo'), node = process.execPath;
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false }); // Unrestricted: the close question is still asked
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'mcp' });
  const outside = await attach(t, instance, first);
  const script = (name, exit) => { const f = path.join(ws, name + '.mjs'); fs.writeFileSync(f, `import fs from 'node:fs'; import path from 'node:path'; fs.appendFileSync(path.join(import.meta.dirname, '${name}.ran'), '1'); console.log('${name} says ${exit}'); process.exit(${exit});`); return `${node} ${f}`; };
  const ran = (name) => (fs.existsSync(path.join(ws, name + '.ran')) ? fs.readFileSync(path.join(ws, name + '.ran'), 'utf8').length : 0);
  const project = (await call(instance, '/projects', 'POST', { name: 'Omega', work: { kind: 'new', parent: '', name: 'omega' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'To close' })).body, sprint = s.sprint;
  const plan = (two) => `# Plan\n\n- [x] A1: the first thing; role w1\n- [${two ? 'x' : ' '}] A2: the second thing; role w1\n`;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), plan(false));
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: [
    { name: 'gate', command: script('gate', 1), point: 'before-close', blocking: true }, { name: 'tidy', command: script('tidy', 0), point: 'after-close', blocking: false }] }));
  const row = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint);
  const close = async () => call(instance, `/sprints/${sprint}/close`, 'POST', {}), status = async () => (await call(instance, `/sprints/${sprint}/status`)).body;
  // Only a started sprint is closed.
  let got = await close();
  assert.deepEqual([got.status, got.body.error], [409, 'sprint-not-started'], JSON.stringify(got.body));
  assert.equal((await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: (await row()).files.find((f) => f.name === 'hooks.json').hash })).status, 200);
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill({ agent: 'claude', model: 'haiku', effort: 'low' }) })).status, 200);
  const L = await attach(t, instance, sprint);
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  const w1 = await L.tool('open_chat', { text: 'config', key: 'w1' }); assert.ok(w1.chat && !w1.error, JSON.stringify(w1));
  await replied(instance, w1.chat, 'config:');
  // A second chat of the same project: its agent may ask to close the sprint, and it is not one of the sprint's chats.
  const peer = (await call(instance, '/chat', 'POST', { provider: 'claude', project })).body.conversation;
  await call(instance, `/chat/${peer}/prompt`, 'POST', { text: 'mcp' });
  const P = await attach(t, instance, peer);
  const states = async () => (await status()).workers.map((w) => [w.key, w.state]);
  assert.equal((await status()).closed, null);

  // The before-close script exits 1: the owner's press is refused with its last line, and nothing changed.
  got = await close();
  assert.deepEqual([got.status, got.body.error, got.body.script, got.body.point], [400, 'script-refused', 'gate', 'before-close'], JSON.stringify(got.body));
  assert.match(got.body.detail, /exit 1: gate says 1$/);
  assert.deepEqual([ran('gate'), ran('tidy'), (await row()).closed, (await status()).closed, (await states()).some(([, st]) => st === 'stopped')], [1, 0, undefined, null, false]);

  // The tool: a chat outside the project has no such sprint; one with no sprint of its own must name it; the lock refuses.
  fs.writeFileSync(path.join(ws, 'gate.mjs'), fs.readFileSync(path.join(ws, 'gate.mjs'), 'utf8').replaceAll('says 1', 'says 0').replace('process.exit(1)', 'process.exit(0)'));
  assert.equal((await outside.tool('close_sprint', { sprint })).error, 'unknown-sprint');
  assert.equal((await P.tool('close_sprint')).error, 'unknown-sprint');
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await P.tool('close_sprint', { sprint })).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });
  // It asks the user first, in Unrestricted too. No: nothing ran, nothing closed.
  const asked = async () => (await events(instance, peer)).filter((e) => e.type === 'approval');
  const answer = async (seen, optionId) => {
    const q = await eventually(async () => (await asked())[seen], 'the close question');
    await call(instance, `/chat/${peer}/answer`, 'POST', { request: q.data.request, answer: { optionId } }); return q.data.toolCall.title;
  };
  let going = P.tool('close_sprint', { sprint });
  const title = await answer(0, 'reject');
  assert.match(title, /^P9: close the sprint "To close": stop every chat of it/);
  assert.equal((await going).error, 'not-allowed');
  assert.deepEqual([ran('gate'), ran('tidy'), (await status()).closed], [1, 0, null]);
  // Yes: the gate passes now, the worker and then the lead are stopped, the close is recorded, after-close runs.
  const before = await status();
  going = P.tool('close_sprint', { sprint }); await answer(1, 'allow');
  const done = await going;
  assert.deepEqual([done.error, done.sprint, done.closed.by, done.stopped, done.note], [undefined, sprint, peer, [w1.chat, sprint], undefined], JSON.stringify(done));
  await eventually(() => ran('tidy') === 1, 'after-close never ran');
  assert.equal(ran('gate'), 2);
  const chats = await rows(instance), stateOf = (id) => chats.find((c) => c.id === id)?.state;
  assert.deepEqual([stateOf(w1.chat), stateOf(sprint), stateOf(peer) === 'stopped'], ['stopped', 'stopped', false], JSON.stringify(chats.map((c) => [c.id, c.state])));

  // The record: the status as it stood, each chat marked stopped, and the same answer from the tool and the route, twice.
  const kept = await status(), fromTool = await P.tool('sprint_status', { sprint });
  assert.deepEqual(fromTool, kept);
  assert.deepEqual([kept.closed, kept.done, kept.items, kept.sprint, kept.workers.map((w) => [w.key, w.chat, w.state])],
    [done.closed, before.done, before.items, before.sprint, [['lead', sprint, 'stopped'], ['w1', w1.chat, 'stopped']]], JSON.stringify(kept).slice(0, 600));
  assert.ok(Number.isInteger(kept.running_ms) && kept.running_ms >= before.running_ms && !Number.isNaN(Date.parse(kept.closed.at)), JSON.stringify([kept.running_ms, kept.closed]));
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), plan(true)); // the plan changes after Close: the record does not
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await status(), kept);
  assert.deepEqual((await row()).closed, { at: Date.parse(kept.closed.at), by: peer });

  // Closed once: a second close, a Start and Run now are refused, and no script stands.
  got = await close();
  assert.deepEqual([got.status, got.body.error, got.body.closed], [409, 'sprint-closed', kept.closed], JSON.stringify(got.body));
  assert.equal((await P.tool('close_sprint', { sprint })).error, 'sprint-closed');
  assert.equal((await call(instance, `/sprints/${sprint}/start`, 'POST', {})).body.error, 'sprint-closed');
  got = await call(instance, `/sprints/${sprint}/run-script`, 'POST', { name: 'tidy' });
  assert.notEqual(got.status, 200, JSON.stringify(got.body));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([ran('gate'), ran('tidy')], [2, 1]);
  // The lead, written to again after Close, starts no more chats.
  const chatsBefore = (await rows(instance)).length;
  const mcps = async () => (await events(instance, sprint)).filter((e) => e.data?.content?.text?.startsWith('mcp:'));
  // A role row added after Close (the closed page still edits roles): only the closed sprint stands in the new worker's way.
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low' }, { key: 'w2', provider: 'claude', model: 'haiku', effort: 'low' }] }));
  const had = (await mcps()).length;
  await call(instance, `/chat/${sprint}/prompt`, 'POST', { text: 'mcp' });
  const [entry] = JSON.parse((await eventually(async () => { const all = await mcps(); return all.length > had && all.at(-1); }, 'the reopened lead never said its tools')).data.content.text.slice(4));
  const again = new Client({ name: 'p9-test', version: '1' });
  await again.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => again.close());
  got = JSON.parse((await again.callTool({ name: 'open_chat', arguments: { text: 'config', key: 'w2' } })).content[0].text);
  assert.deepEqual([got.error, got.chat, (await rows(instance)).length], ['sprint-closed', undefined, chatsBefore], JSON.stringify(got));
  console.log('PASS Close sprint: the reopened lead\'s open_chat was refused sprint-closed;not started 409; a before-close exit 1 refused the press with its last line and changed nothing; the tool was unknown outside the project, refused by the lock, asked first and closed nothing on no; on yes the worker then the lead were stopped, after-close ran once, the tool and the route gave the same kept record, a later plan edit did not move it, and a second close, Start and Run now were refused');
});

// #232 FIX1 (a, b): a worker's own close_sprint leaves the worker running (its lead's stop does not take it), and an
// agent lock turned on while a blocking before-close script runs stops nothing and records nothing.
test('Close sprint held: a lock during before-close stops nothing; a worker that closes its sprint is not stopped with its lead', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo'), node = process.execPath, held = path.join(ws, 'gate.held'), go = path.join(ws, 'gate.go');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false }); // Delegation's Agent decides, as the Close test sets it
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation; // P9 reads claude's model list, which Start checks the roles against
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  // The gate says it started, then waits for the test's go.
  const gate = path.join(ws, 'gate.mjs');
  const why = path.join(ws, 'gate.err');
  fs.writeFileSync(gate, `import fs from 'node:fs'; process.on('uncaughtException', (e) => { fs.writeFileSync(${JSON.stringify(why)}, String(e?.stack ?? e)); process.exit(1); });
fs.appendFileSync(${JSON.stringify(held)}, '1'); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(go)})) { clearInterval(t); console.log('gate says go'); } }, 50);`);
  const project = (await call(instance, '/projects', 'POST', { name: 'Held', work: { kind: 'new', parent: '', name: 'held' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Held close' })).body, sprint = s.sprint;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Plan\n\n- [ ] A1: the thing; role w1\n');
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: [{ name: 'gate', command: `${node} ${gate}`, point: 'before-close', blocking: true }] }));
  const row = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint);
  const started = await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: (await row()).files.find((f) => f.name === 'hooks.json').hash });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal((await call(instance, '/delegation', 'POST', { start: 'agent', max: 5, workers: Array(5).fill({ agent: 'claude', model: 'haiku', effort: 'low' }) })).status, 200);
  const L = await attach(t, instance, sprint);
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }, { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low' }] })); // as the Close test: the worker's role after Start
  const w1 = await L.tool('open_chat', { text: 'config', key: 'w1' }); assert.ok(w1.chat && !w1.error, JSON.stringify(w1));
  await replied(instance, w1.chat, 'config:');
  await call(instance, `/chat/${w1.chat}/prompt`, 'POST', { text: 'mcp' }); // its first message carries its role's rules; this one is only mcp
  const W = await attach(t, instance, w1.chat);
  const status = async () => (await call(instance, `/sprints/${sprint}/status`)).body;
  const stateOf = async (id) => (await rows(instance)).find((c) => c.id === id)?.state;
  const asked = async () => (await events(instance, w1.chat)).filter((e) => e.type === 'approval');
  const allow = async (seen) => { const q = await eventually(async () => (await asked())[seen], 'the close question'); await call(instance, `/chat/${w1.chat}/answer`, 'POST', { request: q.data.request, answer: { optionId: 'allow' } }); };

  // (b) The worker asks, the user says yes, the gate starts and waits; the agent lock goes on; then the gate passes.
  let going = W.tool('close_sprint'); await allow(0);
  await eventually(() => fs.existsSync(held), 'the gate never started');
  assert.equal((await call(instance, '/agent-lock', 'POST', { on: true })).status, 200);
  fs.writeFileSync(go, '1');
  const locked = await going;
  assert.equal(locked.error, 'agent-lock-on', JSON.stringify(locked) + (fs.existsSync(why) ? ' gate.err: ' + fs.readFileSync(why, 'utf8') : ''));
  assert.deepEqual([(await status()).closed, await stateOf(sprint) === 'stopped', await stateOf(w1.chat) === 'stopped'], [null, false, false], 'a lock turned on during before-close still closed or stopped something');
  await call(instance, '/agent-lock', 'POST', { on: false });

  // (a) The same worker closes it: the lead is stopped, the worker is not.
  going = W.tool('close_sprint'); await allow(1);
  const done = await going;
  assert.deepEqual([done.error, done.stopped, typeof done.note], [undefined, [sprint], 'string'], JSON.stringify(done));
  assert.deepEqual([await stateOf(sprint), await stateOf(w1.chat) === 'stopped'], ['stopped', false], 'the calling worker was stopped with its lead');
  assert.equal((await status()).closed.by, w1.chat);
  console.log('PASS Close held: the lock turned on during a blocking before-close refused agent-lock-on with nothing stopped or recorded; the worker\'s own close stopped only the lead and left the worker running');
});

// Sprint Setup as tools (row 697: an agent can read and change Setup the same way the page does): sprint_setup reads every Setup field with its file's hash; sprint_setup_save writes one file or one role row
// through the page's guarded save, so a stale hash is refused and nothing is written. A role's owns and mode are kept,
// and Start takes a row with owns. Sprint View's phases come from the plan's "## Phase" headings.
test('Sprint Setup tools: every field read with its hash, a file and a role row saved, a stale hash refused for each, owns taken at Start, the plan\'s phases counted', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  const project = (await call(instance, '/projects', 'POST', { name: 'Setup', work: { kind: 'new', parent: '', name: 'setup' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Tooled' })).body, sprint = s.sprint;
  // owns and mode on a row: Start takes them (main refused any key but key, provider, model, effort, mode).
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high', mode: 'Auto', owns: 'the plan and the merges' }] }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  let got = await call(instance, `/sprints/${sprint}/start`, 'POST', {});
  assert.equal(got.status, 200, 'Start with owns on the lead\'s row: ' + JSON.stringify(got.body));
  const L = await attach(t, instance, sprint);
  const file = (name) => fs.readFileSync(path.join(s.folder, name), 'utf8');

  // Read: every Setup file with its hash, the missing ones, the rows.
  let setup = await L.tool('sprint_setup');
  assert.equal(setup.error, undefined, JSON.stringify(setup).slice(0, 300));
  const hashIn = (name) => setup.files.find((f) => f.name === name)?.hash;
  assert.equal(hashIn('roles.json'), hashOf(file('roles.json')));
  assert.ok(setup.files.every((f) => !f.name.startsWith('notes/') && f.name !== 'hooks.json'), 'only Setup files: ' + setup.files.map((f) => f.name));
  assert.deepEqual([setup.roles[0].owns, setup.roles[0].mode, setup.started, setup.missing.includes('rules.md')], ['the plan and the merges', 'Auto', true, true], JSON.stringify(setup).slice(0, 400));

  // A whole file: saved with its hash; a stale hash refused, the file as the other writer left it.
  const plan0 = file('sprint.md');
  got = await L.tool('sprint_setup_save', { name: 'sprint.md', text: '# Plan\n', hash: hashIn('sprint.md') });
  assert.deepEqual([got.error, got.hash, file('sprint.md')], [undefined, hashOf('# Plan\n'), '# Plan\n'], JSON.stringify(got));
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Theirs\n'); // another writer, after the read
  got = await L.tool('sprint_setup_save', { name: 'sprint.md', text: '# Mine\n', hash: hashOf('# Plan\n') });
  assert.deepEqual([got.error, file('sprint.md'), got.files?.find((f) => f.name === 'sprint.md')?.text], ['sprint-file-changed', '# Theirs\n', '# Theirs\n'], 'stale hash, file: ' + JSON.stringify(got).slice(0, 300));
  assert.notEqual(plan0, '# Theirs\n');
  // A file not made yet: "" makes it, and "" again is refused (it is there now).
  got = await L.tool('sprint_setup_save', { name: 'rules.md', text: 'Be brief.', hash: '' });
  assert.deepEqual([got.error, file('rules.md')], [undefined, 'Be brief.']);
  assert.equal((await L.tool('sprint_setup_save', { name: 'rules.md', text: 'x', hash: '' })).error, 'sprint-file-changed');
  // Names outside Setup are refused: hooks.json, notes, the review trail, a way out of the folder.
  for (const name of ['hooks.json', 'notes/lead.md', 'review-trail.md', '../x.md', 'roles/../../x.instructions.md'])
    assert.equal((await L.tool('sprint_setup_save', { name, text: 'x', hash: '' })).error, 'request-refused', name);

  // One role row: a new worker added, owns and mode set, then a stale roles.json hash refused with nothing written.
  setup = await L.tool('sprint_setup');
  got = await L.tool('sprint_setup_save', { role: { key: 'w1', provider: 'claude', model: 'haiku', effort: 'low', owns: 'the window' }, hash: hashIn('roles.json') });
  assert.equal(got.error, undefined, JSON.stringify(got));
  let rows = JSON.parse(file('roles.json')).roles;
  assert.deepEqual(rows.map((r) => [r.key, r.owns ?? null]), [['lead', 'the plan and the merges'], ['w1', 'the window']]);
  assert.equal(JSON.parse(file('roles.json')).folder, 'repo', 'the rest of roles.json is kept');
  got = await L.tool('sprint_setup_save', { role: { key: 'w1', mode: 'Plan', owns: '' }, hash: got.hash });
  rows = JSON.parse(file('roles.json')).roles;
  assert.deepEqual([got.error, rows[1].mode, 'owns' in rows[1], rows[1].model], [undefined, 'Plan', false, 'haiku'], JSON.stringify(rows));
  const before = file('roles.json');
  got = await L.tool('sprint_setup_save', { role: { key: 'w1', owns: 'stale' }, hash: hashIn('roles.json') }); // the hash of the first read
  assert.deepEqual([got.error, file('roles.json')], ['sprint-file-changed', before], 'stale hash, role row');
  got = await L.tool('sprint_setup_save', { remove_role: 'w1', hash: hashIn('roles.json') });
  assert.deepEqual([got.error, file('roles.json')], ['sprint-file-changed', before], 'stale hash, remove_role');
  setup = await L.tool('sprint_setup');
  assert.ok(setup.missing.includes('roles/w1.instructions.md'), 'a new role\'s three files are listed as missing: ' + setup.missing);
  assert.equal((await L.tool('sprint_setup_save', { remove_role: 'lead', hash: hashIn('roles.json') })).error, 'request-refused');
  assert.equal((await L.tool('sprint_setup_save', { role: { key: 'w1', shell: 'yes' }, hash: hashIn('roles.json') })).error, 'request-refused');
  assert.equal((await L.tool('sprint_setup_save', { role: { key: 'w1', owns: 'x'.repeat(501) }, hash: hashIn('roles.json') })).error, 'request-refused');
  got = await L.tool('sprint_setup_save', { remove_role: 'w1', hash: hashIn('roles.json') });
  assert.deepEqual([got.error, JSON.parse(file('roles.json')).roles.map((r) => r.key)], [undefined, ['lead']]);
  // A roles.json that does not parse: the read says why; a row save is refused; the whole file can still be saved.
  fs.writeFileSync(path.join(s.folder, 'roles.json'), '{ "roles": [');
  setup = await L.tool('sprint_setup');
  assert.match(setup.roles_error ?? '', /does not parse/);
  assert.equal((await L.tool('sprint_setup_save', { role: { key: 'w2' }, hash: hashIn('roles.json') })).error, 'request-refused');
  // The agent lock refuses a save and leaves the read.
  assert.equal((await call(instance, '/agent-lock', 'POST', { on: true })).status, 200);
  assert.equal((await L.tool('sprint_setup_save', { name: 'rules.md', text: 'locked', hash: hashOf('Be brief.') })).error, 'agent-lock-on');
  assert.equal(file('rules.md'), 'Be brief.');
  assert.equal((await L.tool('sprint_setup')).error, undefined);
  await call(instance, '/agent-lock', 'POST', { on: false });

  // Phases: the plan's "## Phase" headings, each with its items merged and total; none: [] and no current phase.
  const status = async () => (await call(instance, `/sprints/${sprint}/status`)).body;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Plan\n\n- [ ] Z0: above any phase\n\n## Phase 1: install\n- [x] A1: one; role w1\n- [ ] A2: two\n\n### Phase 2 — ship\n- [ ] B1: three\n');
  let st = await status();
  assert.deepEqual([st.phases, st.phase_now], [[{ title: 'Phase 1: install', merged: 0, total: 2 }, { title: 'Phase 2 — ship', merged: 0, total: 1 }], 0], JSON.stringify([st.phases, st.phase_now]));
  assert.deepEqual((await L.tool('sprint_status')).phases, st.phases, 'the tool gives the same phases');
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Plan\n\n- [ ] A1: one\n');
  st = await status();
  assert.deepEqual([st.phases, st.phase_now], [[], null]);
  console.log('PASS Sprint Setup tools: read every Setup file with its hash and the rows (owns, mode); a file, a new file ("") and a role row saved; a stale hash refused for a file, a row and a removal with nothing written; names outside Setup refused; lock refuses the save; Start took owns; phases 2 from the headings (0 of 2, 0 of 1, current 0), none = [] / null');
});

// O189 (1): a row at point every runs again and again, N minutes apart, while its sprint is started, not paused and not
// closed. The clock is the test's: tick(now) is called with made-up times (ticking: false), and a minute is 1000 of them.
// Two sprints, A and B, each with the row approved at Start (at 0). Each run appends "<sprint> <token>" to ran.txt; a run
// whose sprint has a hold-<id> file waits until it is removed, and every run exits 1 while the file 'fail' exists.
const M = 1000, EA = '33333333-3333-4333-8333-333333333333', EB = '44444444-4444-4444-8444-444444444444';
function everyRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-every-')), prog = path.join(dir, 'every.mjs'), ranFile = path.join(dir, 'ran.txt');
  fs.writeFileSync(prog, `import fs from 'node:fs'; import path from 'node:path'; const j = JSON.parse(fs.readFileSync(0, 'utf8')), hold = path.join(${JSON.stringify(dir)}, 'hold-' + j.sprint.id);
fs.appendFileSync(${JSON.stringify(ranFile)}, j.sprint.id + ' ' + (process.env.P9_SCRIPT_TOKEN ?? 'none') + '\\n');
while (fs.existsSync(hold)) await new Promise((r) => setTimeout(r, 20));
process.exit(fs.existsSync(path.join(${JSON.stringify(dir)}, 'fail')) ? 1 : 0);\n`);
  const row = { name: 'pace', command: `${process.execPath} ${prog}`, point: 'every', blocking: false, every: 10 };
  const r = { dir, row, paused: new Set(), closed: new Set(), gone: new Set(), files: {}, logs: [], allow: false, start: { at: 0, by: 'owner', plan: null, scripts: [row] }, gate: null, asked: 0, closing: false };
  const chat = { lock: () => ({ on: false }), info: () => ({ title: 'S', provider: 'fake' }), family: () => [{ id: EA }, { id: EB }].filter((c) => !r.gone.has(c.id)), list: () => [],
    sprint: () => ({}), gauge: () => null, startFolder: async () => dir, scriptLibrary: () => [], allowScripts: () => r.allow, paused: (c) => r.paused.has(c),
    socketPath: '/nowhere', note: async () => ({}), closing: () => r.closing,
    sprintFiles: { exists: () => true, read: (c, f) => (f === 'hooks.json' ? r.files[c] ?? null : null), folderOf: () => dir, log: (c, line) => r.logs.push(c + ' ' + line) },
    projects: { merge: () => true, started: () => r.start, closed: (c) => (r.closed.has(c) ? { at: 1, by: 'owner' } : null), prepOf: () => null, record: async () => null } };
  // usage is read inside each run's state: r.gate (a promise) holds every run there, before its spawn.
  r.make = (bootAt = 0) => createHooks({ chat, usage: () => { r.asked += 1; return r.gate; }, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true, minute: M, bootAt, ticking: false });
  r.ran = () => (fs.existsSync(ranFile) ? fs.readFileSync(ranFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')) : []);
  r.count = (s) => r.ran().filter((x) => x[0] === s).length;
  r.hooks = r.make();
  return r;
}

test('Sprint scripts every: the approval text says the row repeats; every is needed at point every and refused elsewhere', () => {
  const row = { name: 'pace', command: 'node pace.mjs', point: 'every', every: 10 };
  assert.equal(said(row), 'pace (repeats every 10 minutes while the sprint is started and not paused, until it is closed): node pace.mjs');
  assert.deepEqual(parse(JSON.stringify({ scripts: [row] })).scripts, [{ ...row, blocking: false }]);
  for (const bad of [{ ...row, every: 121 }, { ...row, every: 9 }, { ...row, every: 10.5 }, { ...row, every: '10' }, { name: 'x', command: 'x', point: 'every' }, { name: 'x', command: 'x', point: 'pause', every: 10 }, { ...row, blocking: true }])
    assert.match(parse(JSON.stringify({ scripts: [bad] })).error ?? 'accepted', /every|blocking/, JSON.stringify(bad));
  console.log('PASS every: the approval text says it repeats every 10 minutes until closed; seven bad rows refused');
});

test('Sprint scripts every: each sprint\'s row runs once each N minutes, each run with its own token that dies when the run ends', { timeout: 60000 }, async () => {
  const r = everyRig();
  assert.deepEqual(await r.hooks.tick(9 * M), []);
  await r.hooks.tick(10 * M);
  assert.deepEqual([r.count(EA), r.count(EB)], [1, 1], JSON.stringify(r.ran()));
  await r.hooks.tick(15 * M);
  assert.deepEqual([r.count(EA), r.count(EB)], [1, 1], 'a row ran before its N minutes had passed since its last run');
  await r.hooks.tick(20 * M);
  const tokens = r.ran().map((x) => x[1]);
  assert.equal(tokens.length, 4);
  for (const t of tokens) assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(new Set(tokens).size, 4, 'two runs shared a token');
  assert.equal((await r.hooks.say(tokens[0], { action: 'note', chat: EA, text: 'late' })).status, 401, 'a finished run\'s token still worked');
  assert.match(r.logs[0], /\| every \| pace \| exit 0 \|/);
  console.log('PASS every: runs at 10 and 20, not at 9 or 15, in both sprints; four runs, four tokens, a finished one refused (401)');
});

test('Sprint scripts every: a tick is skipped while the row\'s last run is still going, and the first tick after it ends runs it once', { timeout: 60000 }, async () => {
  const r = everyRig();
  fs.writeFileSync(path.join(r.dir, 'hold-' + EA), '');
  const slow = r.hooks.tick(10 * M);
  await eventually(() => r.count(EA) === 1, 'the held run started');
  await r.hooks.tick(20 * M); await r.hooks.tick(30 * M);
  assert.equal(r.count(EA), 1, 'a tick started a second run while the last one was still going');
  assert.equal(r.count(EB), 3, 'a slow run in one sprint held another sprint\'s row');
  fs.rmSync(path.join(r.dir, 'hold-' + EA)); await slow;
  await r.hooks.tick(31 * M); await r.hooks.tick(32 * M);
  assert.equal(r.count(EA), 2, 'the first tick after the slow run ended did not run it once');
  console.log('PASS every: while A\'s run was held the ticks at 20 and 30 skipped it (B ran each time); after it ended, one run at 31');
});

test('Sprint scripts every: a failing run is logged and the row keeps its clock', { timeout: 60000 }, async () => {
  const r = everyRig();
  fs.writeFileSync(path.join(r.dir, 'fail'), '');
  await r.hooks.tick(10 * M);
  assert.match(r.logs.find((l) => l.startsWith(EA)), /\| every \| pace \| exit 1 \|/);
  await r.hooks.tick(20 * M);
  assert.equal(r.count(EA), 2, 'a row stopped after a failed run');
  console.log('PASS every: exit 1 logged, the row ran again at 20');
});

test('Sprint scripts every: a paused sprint runs nothing however long, another sprint keeps running, and resume runs the row once', { timeout: 60000 }, async () => {
  const r = everyRig();
  r.paused.add(EA);
  for (let m = 10; m <= 40; m += 10) await r.hooks.tick(m * M);
  assert.deepEqual([r.count(EA), r.count(EB)], [0, 4], 'a paused sprint ran its every row, or pausing it stopped the other');
  r.paused.delete(EA);
  await r.hooks.tick(41 * M); await r.hooks.tick(42 * M);
  assert.equal(r.count(EA), 1, 'resume ran the row other than once for the ticks missed while paused');
  console.log('PASS every: paused 40 minutes, A ran 0 times and B 4; after resume A ran once');
});

test('Sprint scripts every: a closed sprint runs its row no more', { timeout: 60000 }, async () => {
  const r = everyRig();
  await r.hooks.tick(10 * M);
  r.closed.add(EA);
  for (let m = 20; m <= 50; m += 10) await r.hooks.tick(m * M);
  assert.deepEqual([r.count(EA), r.count(EB)], [1, 5], 'a closed sprint ran its every row');
  console.log('PASS every: after Close A ran no more (1 run), B ran 5');
});

test('Sprint scripts every: after a restart the row waits N minutes from P9\'s own start, not running at once for a Start long ago', { timeout: 60000 }, async () => {
  const r = everyRig(), after = r.make(105 * M);
  await after.tick(106 * M);
  assert.equal(r.count(EA), 0, 'a restart ran the row at once');
  await after.tick(115 * M);
  assert.equal(r.count(EA), 1);
  console.log('PASS every: a P9 started at 105 (Start at 0) ran nothing at 106 and the row at 115');
});

test('Sprint scripts every: a row added after Start runs while it stands and stops when it is removed; the Start-approved row keeps running', { timeout: 60000 }, async () => {
  const r = everyRig();
  r.allow = true; r.files[EA] = JSON.stringify({ scripts: [r.row, { ...r.row, name: 'added' }] });
  await r.hooks.tick(10 * M);
  assert.equal(r.logs.filter((l) => l.includes('| added |')).length, 1, 'an added every row did not run');
  r.files[EA] = JSON.stringify({ scripts: [] });
  await r.hooks.tick(20 * M);
  assert.equal(r.logs.filter((l) => l.includes('| added |')).length, 1, 'a removed added row kept running');
  assert.equal(r.count(EA), 3, 'the row approved at Start stopped when hooks.json dropped it');
  console.log('PASS every: the added row ran once and stopped after its removal; the approved row ran at 10 and 20');
});

// FIX1 (review): a run held in its state read, then the sprint changes under it. The tick read the row before the wait;
// the spawn must not use that read. Each case holds both sprints' runs, changes sprint A (or P9 itself), then releases.
test('Sprint scripts every held: a run held before its spawn starts nothing after a pause, a close, a delete, a new Start, an added row removed, or shutdown', { timeout: 60000 }, async () => {
  const cases = {
    pause: (r) => r.paused.add(EA),
    close: (r) => r.closed.add(EA),
    delete: (r) => r.gone.add(EA), // the lead's conversations row is gone; its saved Start survives (r.start)
    'Start again without the row': (r) => { r.start = { at: 5 * M, by: 'owner', plan: null, scripts: [] }; },
    'Start again with the row changed': (r) => { r.start = { at: 5 * M, by: 'owner', plan: null, scripts: [{ ...r.row, every: 20 }] }; },
    'added row removed': (r) => { r.files[EA] = JSON.stringify({ scripts: [] }); },
    shutdown: (r) => { r.closing = true; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const r = everyRig();
    if (name === 'added row removed') { r.start = { ...r.start, scripts: [] }; r.allow = true; r.files[EA] = JSON.stringify({ scripts: [r.row] }); r.files[EB] = r.files[EA]; }
    let release; r.gate = new Promise((ok) => { release = ok; });
    const going = r.hooks.tick(10 * M);
    await eventually(() => r.asked === 2, name + ': both runs reached their state read');
    change(r); release(null); await going;
    assert.equal(r.count(EA), 0, name + ': the held run spawned the old command');
    // The rig's Start is shared by both sprints, so a new Start (and shutdown) stops B's held run too.
    assert.equal(r.count(EB), name === 'shutdown' || name.startsWith('Start again') ? 0 : 1, name + ': sprint B\'s run');
    if (name === 'shutdown') assert.deepEqual(await r.hooks.tick(20 * M), [], 'a tick after shutdown began ran something');
  }
  console.log('PASS every held: pause, close, delete, a new Start without or with a changed row, an added row removed and shutdown each stopped the held run of sprint A; B ran (not at shutdown or a new Start, which the rig shares)');
});

test('Sprint scripts every clock: a new Start counts its first wait afresh, and still waits for a run going from before it', { timeout: 60000 }, async () => {
  const r = everyRig();
  await r.hooks.tick(10 * M); assert.equal(r.count(EA), 1);
  r.start = { ...r.start, at: 100 * M };
  await r.hooks.tick(101 * M);
  assert.equal(r.count(EA), 1, 'a new Start at 100 ran the row at 101, one minute in, from the old clock');
  await r.hooks.tick(110 * M); assert.equal(r.count(EA), 2, 'the row did not run 10 minutes after the new Start');
  fs.writeFileSync(path.join(r.dir, 'hold-' + EA), '');
  const slow = r.hooks.tick(120 * M);
  await eventually(() => r.count(EA) === 3, 'the held run started');
  r.start = { ...r.start, at: 121 * M };
  await r.hooks.tick(140 * M);
  assert.equal(r.count(EA), 3, 'a new Start let a second run start while the first still runs');
  fs.rmSync(path.join(r.dir, 'hold-' + EA)); await slow;
  console.log('PASS every clock: run at 10; Start at 100; not at 101, run at 110; a run held from 120 kept a Start at 121 from starting another at 140');
});

// The same, wired: the daemon's own timer (its minute shortened to 100 ms, honoured only under the test home) runs the
// row, each run with a new token, and Pause and Resume reach the tick. The rig tests above call tick by hand.
test('Sprint scripts every live: the daemon\'s own timer runs the row, each run with a new token; Pause stops it and Resume starts it again', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake], env: { P9_EVERY_MINUTE_MS: '100' } }));
  const ws = instance.workspace, repo = path.join(ws, 'repo');
  fs.mkdirSync(repo); g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-qm', 'a');
  const project = (await call(instance, '/projects', 'POST', { name: 'Fresh', work: { kind: 'new', parent: '', name: 'fresh' } })).body.project.id;
  await call(instance, '/file-protection', 'POST', { on: false });
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'config' }); await replied(instance, first, 'config:');
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Pace' })).body, sprint = s.sprint;
  const write = (name, body) => fs.writeFileSync(path.join(s.folder, name), body);
  write('roles.json', JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] })); write('roles/lead.work.md', 'mcp');
  write('sprint.md', '# Pace\n\n- [ ] B4: the one item. Role w1\n');
  const hook = path.join(ws, 'pace.mjs'), outFile = path.join(ws, 'pace-out.jsonl');
  fs.writeFileSync(hook, `import fs from 'node:fs'; let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => fs.appendFileSync(${JSON.stringify(outFile)}, JSON.stringify({ point: JSON.parse(s).point, token: process.env.P9_SCRIPT_TOKEN ?? null }) + '\\n'));`);
  const out = () => (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  write('hooks.json', JSON.stringify({ scripts: [{ name: 'pace', command: `${process.execPath} ${hook}`, point: 'every', every: 10 }] }));
  const shown = (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint).files.find((f) => f.name === 'hooks.json');
  const got = await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: shown.hash });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const runs = await eventually(() => out().length >= 2 && out(), 'the every row did not run twice on the daemon\'s own timer');
  assert.ok(runs.every((r) => r.point === 'every' && typeof r.token === 'string' && r.token.length > 0), JSON.stringify(runs));
  assert.notEqual(runs[0].token, runs[1].token, 'two runs shared a token');
  assert.equal((await call(instance, `/sprints/${sprint}/pause`, 'POST', {})).status, 200);
  await new Promise((r) => setTimeout(r, 500)); const held = out().length; // a run started just before the pause may land
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(out().length, held, 'a paused sprint\'s every row ran');
  assert.equal((await call(instance, `/sprints/${sprint}/resume`, 'POST', {})).status, 200);
  await eventually(() => out().length > held, 'Resume did not start the row again');
});

// O202: the five points that were accepted and never run. A rig like everyRig: one sprint (EA), started at 0, with one
// approved row at each point. Each run appends "<point> <subject as JSON>" to ran.txt; hold-<point> holds the run until
// removed, refuse-<point> makes it exit 4 with "no: <point>".
function pointRig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-points-')), prog = path.join(dir, 'point.mjs'), ranFile = path.join(dir, 'ran.txt');
  fs.writeFileSync(prog, `import fs from 'node:fs'; import path from 'node:path'; const j = JSON.parse(fs.readFileSync(0, 'utf8')), d = ${JSON.stringify(dir)};
fs.writeFileSync(path.join(d, 'project-' + j.point + '.json'), JSON.stringify(j));
fs.appendFileSync(path.join(d, 'ran.txt'), j.point + ' ' + JSON.stringify(j.subject) + '\\n');
while (fs.existsSync(path.join(d, 'hold-' + j.point))) await new Promise((r) => setTimeout(r, 20));
fs.appendFileSync(path.join(d, 'ran.txt'), 'end ' + j.point + '\\n');
if (fs.existsSync(path.join(d, 'refuse-' + j.point))) { console.log('no: ' + j.point); process.exit(4); }\n`);
  const cmd = `${process.execPath} ${prog}`;
  const scripts = ['before-merge', 'ci-red', 'gate-passed', 'pause', 'resume'].map((point) => ({ name: 'at ' + point, command: cmd, point, blocking: point === 'before-merge' }));
  const r = { dir, lock: false, closed: false, closing: false, gone: false, startAt: 0, stateHold: null, started: true, scripts, logs: [] };
  const chat = { lock: () => ({ on: r.lock }), info: (c) => (c === EA ? { title: 'S', provider: 'fake' } : c === EB ? { title: 'W', provider: 'fake', parent: EA } : null), family: () => (r.gone ? [] : [{ id: EA, ...(r.source !== undefined && { project: 'P1' }) }]), list: () => [],
    sprint: () => ({}), gauge: () => null, startFolder: async () => dir, scriptLibrary: () => [], allowScripts: () => false, paused: () => false,
    socketPath: '/nowhere', note: async () => ({}), closing: () => r.closing,
    sprintFiles: { exists: (c) => c === EA, read: () => null, folderOf: () => dir, log: (c, line) => r.logs.push(line) },
    projects: { merge: () => r.merge ?? true, started: () => (r.started ? { at: r.startAt, by: 'owner', plan: null, scripts: r.scripts } : null), closed: () => (r.closed ? { at: 1, by: 'owner' } : null), prepOf: () => null, record: async () => null, sprintSet: async () => ({ source: r.source, setup: '' }) } };
  r.chat = chat; // usage is read inside the state every run gets, so stateHold holds a run between its rows and its start
  r.hooks = createHooks({ chat, usage: async () => r.stateHold, stateOf: () => 'idle', rolesOf: () => ({ error: 'none' }), allowed: async () => true, ticking: false });
  r.ran = () => (fs.existsSync(ranFile) ? fs.readFileSync(ranFile, 'utf8').split('\n').filter(Boolean) : []);
  r.hold = (point) => fs.writeFileSync(path.join(dir, 'hold-' + point), ''); r.free = (point) => fs.rmSync(path.join(dir, 'hold-' + point));
  return r;
}

test('Sprint scripts O202: every point is fired; sprint_event runs a reported point\'s scripts with its subject, and before-merge refuses by name', { timeout: 60000 }, async () => {
  assert.deepEqual(FIRED, POINTS, 'a point is still accepted and never run');
  const r = pointRig();
  assert.deepEqual(await r.hooks.event(EA, { point: 'before-merge', subject: { pr: 12, commit: 'abc1234', item: 'B4', branch: 'p/x' } }), { point: 'before-merge', scripts: 1, merge: 'allowed' });
  assert.equal(r.ran()[0], 'before-merge {"pr":12,"commit":"abc1234","item":"B4","branch":"p/x","by":"lead"}');
  fs.writeFileSync(path.join(r.dir, 'refuse-before-merge'), '');
  const no = await r.hooks.event(EA, { point: 'before-merge', subject: { pr: 13 } });
  assert.deepEqual([no.error, no.script, no.point, no.exit], ['script-refused', 'at before-merge', 'before-merge', 4], JSON.stringify(no));
  assert.match(no.detail, /refused this: exit 4: no: before-merge$/);
  r.hold('ci-red'); // O216: held after it started, as a slow runner leaves it: its log line comes only once it ends
  assert.deepEqual(await r.hooks.event(EA, { point: 'ci-red', subject: { run: '987654' } }), { point: 'ci-red', scripts: 1 });
  assert.deepEqual(await r.hooks.event(EA, { point: 'gate-passed', subject: { gate: 'gate 3' } }), { point: 'gate-passed', scripts: 1 });
  await eventually(() => r.ran().includes('ci-red {"run":"987654","by":"lead"}') && r.ran().includes('gate-passed {"gate":"gate 3","by":"lead"}'), 'the notices ran with their subject');
  r.free('ci-red');
  await eventually(() => r.logs.some((l) => / \| ci-red \| at ci-red \| exit 0 \| /.test(l)), 'the run is a line in hooks.log'); // written as it ends
  console.log('PASS O202: FIRED is every point; before-merge allowed then refused by name (exit 4); ci-red and gate-passed ran with their subject and were logged');
});

test('Sprint scripts H2: with the owner\'s standing merge off, before-merge answers merge-is-the-owners and runs no script; the status says so', { timeout: 60000 }, async () => {
  const r = pointRig(); r.merge = false;
  const no = await r.hooks.event(EA, { point: 'before-merge', subject: { pr: 12 } });
  assert.equal(no.error, 'merge-is-the-owners', JSON.stringify(no)); assert.match(no.detail, /do not merge\. Tell the owner the PR is ready to merge\.$/);
  assert.deepEqual(await r.hooks.event(EA, { point: 'ci-red', subject: { run: '987654' } }), { point: 'ci-red', scripts: 1 }, 'the switch held back a point other than before-merge');
  await eventually(() => r.ran().includes('end ci-red'), 'ci-red ran');
  assert.deepEqual(r.ran(), ['ci-red {"run":"987654","by":"lead"}', 'end ci-red'], 'a before-merge script ran with merge the owner\'s');
  assert.equal((await r.hooks.view(EA)).standing_merge, false);
  r.merge = true;
  assert.equal((await r.hooks.view(EA)).standing_merge, true);
  assert.deepEqual(await r.hooks.event(EA, { point: 'before-merge', subject: { pr: 12 } }), { point: 'before-merge', scripts: 1, merge: 'allowed' });
  console.log('PASS H2: switch off refused before-merge by name with no script run (ci-red still ran); on, it was allowed; the status showed each');
});

test('Sprint scripts O211: a ci-red script is told the project\'s Clone from as project.source, without any user or password, and null when unset', { timeout: 60000 }, async () => {
  const r = pointRig(), told = async (source) => {
    r.source = source; fs.rmSync(path.join(r.dir, 'project-ci-red.json'), { force: true });
    // O216: the script writes its state, then is held before it exits (the gap a slow runner leaves on its own).
    r.hold('ci-red');
    const ended = () => r.logs.filter((l) => l.includes(' | ci-red | ')).length, before = ended();
    assert.deepEqual(await r.hooks.event(EA, { point: 'ci-red', subject: { run: '123456' } }), { point: 'ci-red', scripts: 1 });
    const whole = await eventually(() => fs.existsSync(path.join(r.dir, 'project-ci-red.json')) && fs.readFileSync(path.join(r.dir, 'project-ci-red.json'), 'utf8'), 'ci-red did not run');
    r.free('ci-red');
    // Then the next call waits for this run's end (its sprint log line, written before the point is free again). A retry
    // on point-busy instead would pass a real second run of one call.
    await eventually(() => ended() > before, 'ci-red did not end');
    assert.ok(!whole.includes('hunter2'), 'hunter2 is in the script\'s state for ' + JSON.stringify(source));
    return JSON.parse(whole).project.source;
  };
  assert.equal(await told('https://github.com/o/r.git'), 'https://github.com/o/r.git', 'ci-red was not told the Clone from');
  assert.equal(await told('ssh://git:hunter2@example.com:22/o/r.git'), 'ssh://example.com:22/o/r.git', 'a password reached the script');
  assert.equal(await told('https://u:tok@github.com/o/r'), 'https://github.com/o/r', 'a token reached the script');
  assert.equal(await told('git@github.com:o/r.git'), 'github.com:o/r.git');
  // Reviewer on #400: a token can ride in the query or fragment, or hide behind an encoding. Each is an address the
  // project page saves (remoteOk); none of the secret reaches the script, and an odd form gives null, not a guess.
  const cases = [['https://example.com/o/r.git?access_token=hunter2', 'https://example.com/o/r.git'],
    ['ssh://git@example.com/o/r.git#token=hunter2', 'ssh://example.com/o/r.git'],
    ['https://example.com/o/r.git?a=1#hunter2', 'https://example.com/o/r.git'], ['git@example.com:o/r.git?hunter2', 'example.com:o/r.git'],
    ['https://example.com/o/r.git?x=%3F#y%23hunter2', 'https://example.com/o/r.git'],
    ['https://example.com/o/r.git;token=hunter2', null], ['https://example.com/o%2Fhunter2/r.git', null],
    ['ssh://example.com/hunter2%40x/r.git', null], ['https://example.com/o/r.git%3Faccess_token=hunter2', null],
    ['https://example.com/o/r.git%23token=hunter2', null], ['HTTPS://example.com/o/r.git?access_token=hunter2', 'HTTPS://example.com/o/r.git'],
    ['SSH://git:hunter2@example.com/o/r.git', 'SSH://example.com/o/r.git']];
  for (const [address, want] of cases) {
    assert.ok(remoteOk(address), 'not an address the project page saves: ' + address);
    assert.equal(await told(address), want, address);
  }
  // Forms the save refuses (it trims and checks), as if a record was written another way: still never passed raw.
  for (const address of ['https://example.com/o/r.git?access_token=hunter2 ', 'https://exa%40hunter2.com/o/r.git', 'https://example.com/o/r.git\thunter2', 'https://hunter2@example.com/o/r.git#x']) {
    assert.equal(remoteOk(address), false, 'the save accepts ' + JSON.stringify(address));
    const got = await told(address);
    assert.ok(got === null || got === 'https://example.com/o/r.git', JSON.stringify(address) + ' gave ' + got);
  }
  assert.equal(await told(''), null, 'an unset Clone from is not null');
  console.log('PASS O211: ci-red got project.source equal to Clone from, user and password taken out, null when unset');
});

test('Sprint scripts O202: sprint_event is refused for a wrong point or subject, a caller not the lead, the lock, before Start and after Close', { timeout: 60000 }, async () => {
  const r = pointRig(), ev = (args, caller = EA) => r.hooks.event(caller, args).then((x) => x.error);
  for (const point of ['pause', 'resume', 'before-start', 'every', undefined]) assert.equal(await ev({ point }), 'request-refused', String(point));
  for (const subject of [{ pr: '12' }, { pr: 0 }, { pr: 1.5 }, { run: 'abc' }, { run: 12 }, { commit: 'XYZ1234' }, { commit: 'abc' }, { branch: 'a\nb' }, { branch: '' }, { item: 'a b' }, { gate: 'x'.repeat(61) }, { evil: 1 }, [], 'x', null])
    assert.equal(await ev({ point: 'ci-red', subject }), 'request-refused', JSON.stringify(subject));
  assert.equal(await ev({ point: 'ci-red' }, EB), 'not-a-sprint-lead', 'a worker reported a point');
  assert.equal(await ev({ point: 'ci-red' }, 'nobody'), 'not-a-sprint-lead');
  r.lock = true; assert.equal(await ev({ point: 'ci-red' }), 'agent-lock-on'); r.lock = false;
  r.started = false; assert.equal(await ev({ point: 'ci-red' }), 'sprint-not-started'); r.started = true;
  r.closed = true; assert.equal(await ev({ point: 'before-merge' }), 'sprint-closed');
  assert.deepEqual(r.ran(), [], 'a refused call ran a script');
  console.log('PASS O202: 5 wrong points, 15 wrong subjects, a worker, a stranger, the lock, before Start and after Close all refused; nothing ran');
});

test('Sprint scripts O202: a second call of a point while its last scripts run is refused (point-busy), and taken once they end', { timeout: 60000 }, async () => {
  const r = pointRig();
  r.hold('ci-red');
  assert.equal((await r.hooks.event(EA, { point: 'ci-red', subject: { run: '1' } })).point, 'ci-red');
  await eventually(() => r.ran().length === 1, 'the held run started');
  assert.equal((await r.hooks.event(EA, { point: 'ci-red', subject: { run: '2' } })).error, 'point-busy');
  assert.equal((await r.hooks.event(EA, { point: 'gate-passed' })).point, 'gate-passed', 'a busy point held another');
  r.free('ci-red');
  await eventually(() => r.ran().includes('end ci-red'), 'the held run ended');
  await eventually(async () => (await r.hooks.event(EA, { point: 'ci-red', subject: { run: '3' } })).point === 'ci-red', 'the point was taken again');
  await eventually(() => r.ran().includes('ci-red {"run":"3","by":"lead"}'), 'run 3 ran (a notice: not waited for)');
  assert.deepEqual(r.ran().filter((l) => l.startsWith('ci-red')), ['ci-red {"run":"1","by":"lead"}', 'ci-red {"run":"3","by":"lead"}']);
  console.log('PASS O202: run 2 refused while run 1 was held, gate-passed not held by it, run 3 taken after run 1 ended');
});

test('Sprint scripts O202: pause and resume run in the order pressed, each after the last one\'s scripts ended; one still waiting at Close or at shutdown runs nothing', { timeout: 60000 }, async () => {
  const r = pointRig();
  r.hold('pause');
  const p = r.hooks.ordered(EA, 'pause', { by: 'owner' }), q = r.hooks.ordered(EA, 'resume', { by: 'owner', sent: 0 });
  await eventually(() => r.ran().length === 1, 'the pause run started');
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(r.ran(), ['pause {"by":"owner"}'], 'resume ran while the pause script was still running');
  r.free('pause'); await p; await q;
  assert.deepEqual(r.ran(), ['pause {"by":"owner"}', 'end pause', 'resume {"by":"owner","sent":0}', 'end resume']);
  r.hold('pause');
  const p2 = r.hooks.ordered(EA, 'pause', { by: 'lead' }), q2 = r.hooks.ordered(EA, 'resume', { by: 'lead', sent: 1 });
  await eventually(() => r.ran().length === 5, 'the second pause started');
  r.closed = true; r.free('pause'); await p2; await q2;
  assert.deepEqual(r.ran().slice(4), ['pause {"by":"lead"}', 'end pause'], 'a resume still waiting at Close ran');
  r.closed = false; r.hold('pause');
  const p3 = r.hooks.ordered(EA, 'pause', { by: 'owner' }), q3 = r.hooks.ordered(EA, 'resume', { by: 'owner', sent: 2 });
  await eventually(() => r.ran().length === 7, 'the third pause started');
  r.closing = true; r.free('pause'); await p3; await q3;
  assert.deepEqual(r.ran().slice(6), ['pause {"by":"owner"}', 'end pause'], 'a resume still waiting while P9 shuts down ran');
  console.log('PASS O202: resume waited for the held pause script; after Close and at shutdown the waiting resume ran nothing');
});

test('Sprint scripts O202 live: the lead\'s sprint_event and pause_sprint, and the owner\'s Pause and Resume, run the approved scripts of those points', { timeout: 300000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const ws = instance.workspace, prog = path.join(ws, 'pt.mjs'), outFile = path.join(ws, 'pt.jsonl');
  fs.writeFileSync(prog, `import fs from 'node:fs'; import path from 'node:path'; const j = JSON.parse(fs.readFileSync(0, 'utf8')), here = import.meta.dirname;
fs.appendFileSync(path.join(here, 'pt.jsonl'), JSON.stringify({ point: j.point, subject: j.subject, blocking: j.blocking }) + '\\n');
if (fs.existsSync(path.join(here, 'refuse-' + j.point))) { console.log('no merge: ' + j.point); process.exit(4); }\n`);
  const cmd = `${process.execPath} ${prog}`, seen = () => (fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const first = (await call(instance, '/chat', 'POST', { provider: 'claude' })).body.conversation;
  await call(instance, `/chat/${first}/prompt`, 'POST', { text: 'mcp' });
  const outside = await attach(t, instance, first);
  const project = (await call(instance, '/projects', 'POST', { name: 'Points', work: { kind: 'new', parent: '', name: 'points' } })).body.project.id;
  const s = (await call(instance, '/projects/' + project + '/sprints', 'POST', { title: 'Points' })).body, sprint = s.sprint;
  fs.writeFileSync(path.join(s.folder, 'sprint.md'), '# Plan\n\n- [ ] A1: one; role w1\n');
  fs.writeFileSync(path.join(s.folder, 'roles.json'), JSON.stringify({ folder: 'repo', roles: [{ key: 'lead', provider: 'claude', model: 'opus', effort: 'high' }] }));
  fs.writeFileSync(path.join(s.folder, 'roles/lead.work.md'), 'mcp');
  fs.writeFileSync(path.join(s.folder, 'hooks.json'), JSON.stringify({ scripts: ['before-merge', 'ci-red', 'gate-passed', 'pause', 'resume']
    .map((point) => ({ name: 'at ' + point, command: cmd, point, blocking: point === 'before-merge' })) }));
  assert.equal((await outside.tool('sprint_event', { point: 'ci-red' })).error, 'not-a-sprint-lead');
  const row = async () => (await call(instance, '/projects/' + project)).body.project.sprints.find((x) => x.lead === sprint);
  assert.equal((await call(instance, `/sprints/${sprint}/start`, 'POST', { hooks: (await row()).files.find((f) => f.name === 'hooks.json').hash })).status, 200);
  const L = await attach(t, instance, sprint);
  // H2 (SECURITY.md § Standing merge): a sprint made now starts with merge the owner's; only the owner's route turns it on.
  const off = await L.tool('sprint_event', { point: 'before-merge', subject: { pr: 11 } });
  assert.equal(off.error, 'merge-is-the-owners', JSON.stringify(off)); assert.deepEqual(seen(), [], 'a before-merge script ran with merge the owner\'s');
  assert.equal((await call(instance, `/sprints/${sprint}/status`)).body.standing_merge, false);
  assert.equal((await L.tool('sprint_status')).standing_merge, false); assert.equal((await L.tool('sprint_setup')).standing_merge, false);
  assert.equal((await row()).merge, false);
  for (const [body, status] of [[{ on: 'true' }, 400], [{ on: true, by: 'lead' }, 400], [{}, 400], [[true], 400]]) assert.equal((await call(instance, `/sprints/${sprint}/merge`, 'POST', body)).status, status, JSON.stringify(body));
  assert.equal((await call(instance, '/sprints/11111111-1111-4111-8111-111111111111/merge', 'POST', { on: true })).status, 404);
  assert.equal((await row()).merge, false, 'a refused press changed the switch');
  const on = await call(instance, `/sprints/${sprint}/merge`, 'POST', { on: true });
  assert.deepEqual([on.status, on.body], [200, { merge: true }]);
  assert.equal((await call(instance, `/sprints/${sprint}/status`)).body.standing_merge, true); assert.equal((await L.tool('sprint_setup')).standing_merge, true);
  assert.deepEqual(await L.tool('sprint_event', { point: 'before-merge', subject: { pr: 12, commit: 'abc1234' } }), { point: 'before-merge', scripts: 1, merge: 'allowed' });
  assert.deepEqual(seen().at(-1), { point: 'before-merge', subject: { pr: 12, commit: 'abc1234', by: 'lead' }, blocking: true });
  fs.writeFileSync(path.join(ws, 'refuse-before-merge'), '');
  const no = await L.tool('sprint_event', { point: 'before-merge', subject: { pr: 13 } });
  assert.equal(no.error, 'script-refused', JSON.stringify(no)); assert.match(no.detail, /"at before-merge" \(before-merge\) refused this: exit 4: no merge: before-merge$/);
  assert.deepEqual(await L.tool('sprint_event', { point: 'ci-red', subject: { run: '987654' } }), { point: 'ci-red', scripts: 1 });
  await eventually(() => seen().some((x) => x.point === 'ci-red' && x.subject.run === '987654'), 'ci-red ran');
  const count = (point) => seen().filter((x) => x.point === point).length;
  assert.equal((await call(instance, `/sprints/${sprint}/pause`, 'POST', {})).status, 200);
  await eventually(() => seen().some((x) => x.point === 'pause' && x.subject.by === 'owner'), 'the owner\'s Pause ran the pause script');
  assert.equal((await call(instance, `/sprints/${sprint}/pause`, 'POST', {})).status, 200);
  assert.equal((await call(instance, `/sprints/${sprint}/resume`, 'POST', {})).status, 200);
  await eventually(() => seen().some((x) => x.point === 'resume' && x.subject.by === 'owner'), 'the owner\'s Resume ran the resume script');
  assert.equal(count('pause'), 1, 'a press on a sprint already paused ran the pause script again');
  assert.deepEqual(await L.tool('pause_sprint'), { paused: true });
  await eventually(() => seen().some((x) => x.point === 'pause' && x.subject.by === 'lead'), 'the lead\'s pause_sprint ran the pause script');
  assert.equal(count('resume'), 1);
  assert.match(fs.readFileSync(path.join(s.folder, 'hooks.log'), 'utf8'), / \| pause \| at pause \| exit 0 \| /);
  console.log('PASS O202 live: H2 new sprint refused before-merge (merge-is-the-owners, no script) until the owner\'s route turned standing merge on; sprint_event before-merge allowed, then refused by name; ci-red ran; owner Pause (twice, one run), Resume, and the lead\'s pause_sprint each ran their script');
});

test('Sprint scripts O202: a run whose state read is held while the sprint is closed, deleted, started again or P9 shuts down starts nothing', { timeout: 60000 }, async () => {
  const r = pointRig(), wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const cases = [['closed', (v) => { r.closed = v; }], ['deleted', (v) => { r.gone = v; }], ['started again', (v) => { r.startAt = v ? 5 : 0; }], ['shutdown', (v) => { r.closing = v; }]];
  for (const [what, set] of cases) {
    let release; r.stateHold = new Promise((done) => { release = done; });
    const p = r.hooks.ordered(EA, 'pause', { by: 'owner' }), e = r.hooks.event(EA, { point: 'ci-red' }), m = r.hooks.event(EA, { point: 'before-merge' });
    await wait(100); set(true); release(null); r.stateHold = null;
    await p; await e;
    assert.equal((await m).error, 'sprint-gone', what + ': before-merge was not refused');
    await wait(300);
    assert.deepEqual(r.ran(), [], what + ': a script started after the state read');
    set(false); await wait(50);
  }
  // Between two blocking scripts: the sprint closed while the first runs, the second does not start.
  r.scripts = [...r.scripts, { ...r.scripts[0], name: 'at before-merge 2' }];
  r.hold('before-merge');
  const m = r.hooks.event(EA, { point: 'before-merge' });
  await eventually(() => r.ran().length === 1, 'the first before-merge script started');
  r.closed = true; r.free('before-merge');
  assert.equal((await m).error, 'sprint-gone');
  assert.deepEqual(r.ran(), ['before-merge {"by":"lead"}', 'end before-merge'], 'the second blocking script started after Close');
  console.log('PASS O202: closed, deleted, started again and shutdown during the state read started nothing; before-merge refused; the second blocking script after Close did not start');
});

test('Sprint scripts O202: a Pause pressed while a Resume still sends its kept messages runs its script after the resume script', { timeout: 60000 }, async () => {
  const r = pointRig();
  let paused = true, release;
  const held = new Promise((done) => { release = done; });
  // createDelegate registers listeners on the real chat when it is made (settled, restarted); here they do nothing.
  const chat = { ...r.chat, settled: () => {}, restarted: () => new Promise(() => {}), paused: () => paused, pause: () => { if (paused) return false; paused = true; return true; },
    resume: async (lead, narrow, resumed) => { if (!paused) return null; paused = false; resumed?.(2); await held; return 2; } };
  const tools = createDelegate({ chat, usage: async () => null });
  const q = tools.resume_sprint({}, EA);
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(await tools.pause_sprint({}, EA), { paused: true });
  release(); assert.deepEqual(await q, { paused: false, sent: 2 });
  await eventually(() => r.ran().length === 4, 'both scripts ran');
  assert.deepEqual(r.ran(), ['resume {"by":"lead","sent":2}', 'end resume', 'pause {"by":"lead"}', 'end pause'], 'the scripts ran out of the order of the presses');
  console.log('PASS O202: Resume (delivery held) then Pause ran resume, then pause');
});
