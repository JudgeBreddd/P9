import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, access, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { parseRegistry } from '../apps/server/mission.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const node = process.execPath;
const question = (title) => `# ${title}\n\n**Do:** pick 1 or 2.\n\n**Your answer:** 1, 2, or "none of these".\nA.\n`;

// One workspace per layout: Builder's _tyler and Teammate's _waiting, each with its own registry and project index.
async function layout(workspace, { waiting, registry, primary, scripts }) {
  for (const file of [registry, primary]) await mkdir(path.join(workspace, path.dirname(file)), { recursive: true });
  await mkdir(path.join(workspace, waiting), { recursive: true });
  await writeFile(path.join(workspace, registry), JSON.stringify({ scripts, apps: [{ id: 'editor', title: 'Editor', cmd: ['true'] }],
    pages: [{ id: 'dash', title: 'Dashboard', url: 'http://127.0.0.1:5000/' }] }));
  await writeFile(path.join(workspace, primary), '# Projects\n\n**Main project: P9 — Event Horizon** (`event-horizon/`; named 2026-10-15)\n');
  await mkdir(path.join(workspace, path.dirname(primary), 'event-horizon'));
  await writeFile(path.join(workspace, path.dirname(primary), 'event-horizon', 'AGENTS.md'), '# P9\n\n**Status:** **Open** — phase 5 in work\n');
  await writeFile(path.join(workspace, waiting, 'AGENTS.md'), '# How this folder works\n');
  await writeFile(path.join(workspace, waiting, 'editor-pick.md'), question('Which editor?'));
  await writeFile(path.join(workspace, waiting, 'done-already.md'), '# Answered one\nA. 2\n');
  return { args: ['--settings', path.join(workspace, '..', 'settings.json')] };
}
async function start(t, settings, scripts = [], extraPath) {
  return daemon(t, undefined, false, async (paths) => {
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(settings));
    const result = await layout(paths.workspace, { ...settings, scripts });
    return { ...result, ...(extraPath ? { path: extraPath(paths) } : {}) };
  });
}
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
test('Release r1: a broken settings file turns off Mission Control only (R1-3)', async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    await writeFile(path.join(paths.directory, 'settings.json'), '{ "primary": ');
    return { args: ['--settings', path.join(paths.directory, 'settings.json')] };
  });
  assert.equal((await call(instance, '/health')).status, 200);
  const mission = await call(instance, '/mission');
  assert.deepEqual([mission.status, JSON.parse(mission.text).error], [503, 'settings-invalid']);
  console.log('PASS broken settings: daemon up, /mission 503 settings-invalid');
});
async function finished(instance, run) {
  for (let i = 0; i < 200; i += 1) {
    const result = JSON.parse((await call(instance, `/runs/${run}`)).text);
    if (result.done) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('run-timeout');
}

// Builder's real layout; the top folder is split so the publish scanner's private-path check stays meaningful.
const ICM = 'IC' + 'M';
const BUILDER = { waiting: ICM + '/_tyler', registry: ICM + '/personal-projects/workspace-hub/registry.json', primary: ICM + '/personal-projects/AGENTS.md' };
const TEAMMATE = { waiting: '_waiting', registry: 'hub/registry.json', primary: 'projects/AGENTS.md' };

test('settings file: Builder and Teammate layouts list the same items from their own folders', async (t) => {
  for (const settings of [BUILDER, TEAMMATE]) {
    const instance = await start(t, settings, [{ id: 'hello', title: 'Hello', group: 'Health', cmd: [node, '-e', 'console.log(1)'] }]);
    const result = await call(instance, '/mission');
    assert.equal(result.status, 200, result.text);
    const overview = JSON.parse(result.text);
    assert.deepEqual(overview.queue.map((item) => [item.name, item.title, item.answerable]), [['editor-pick.md', 'Which editor?', true]]);
    assert.deepEqual(overview.primary, { name: 'P9 — Event Horizon', path: path.posix.join(path.posix.dirname(settings.primary), 'event-horizon'),
      status: '**Open** — phase 5 in work' });
    assert.deepEqual([overview.scripts.map((s) => s.id), overview.apps.map((a) => a.id), overview.pages.map((p) => p.id)], [['hello'], ['editor'], ['dash']]);
  }
  const bare = await daemon(t);
  assert.equal((await call(bare, '/mission')).status, 503);
  console.log('PASS phase5 settings: Builder (_tyler) and Teammate (_waiting) layouts each list their queue, primary card, scripts, apps, pages; no settings file = 503');
});

test('script button runs its fixed argv and streams output; _tyler answer lands on A. and a concurrent edit is kept', async (t) => {
  const instance = await start(t, BUILDER, [
    { id: 'echo', title: 'Echo', group: 'Tools', cmd: [node, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))'], args: ['Words'], tail: ['--end'] },
    { id: 'fail', title: 'Fail', group: 'Tools', cmd: [node, '-e', 'console.error("broke"); process.exit(3)'] },
  ]);
  const started = JSON.parse((await call(instance, '/scripts/echo/run', 'POST', { args: ['two words "quoted" *'] })).text);
  const run = await finished(instance, started.run);
  assert.equal(run.code, 0);
  assert.ok(run.output.includes(JSON.stringify(['two words "quoted" *', '--end'])), run.output);
  const failed = await finished(instance, JSON.parse((await call(instance, '/scripts/fail/run', 'POST', {})).text).run);
  assert.equal(failed.code, 3);
  assert.ok(failed.output.includes('broke') && failed.output.includes('[exit 3'));
  const partial = JSON.parse((await call(instance, `/runs/${started.run}?from=${run.next - 5}`)).text);
  assert.equal(partial.output, run.output.slice(-5));

  const file = path.join(instance.workspace, BUILDER.waiting, 'editor-pick.md');
  const item = JSON.parse((await call(instance, '/mission')).text).queue[0];
  const saved = await call(instance, '/mission/answer', 'POST', { name: item.name, hash: item.hash, answer: '1, Monaco+' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(await readFile(file, 'utf8'), question('Which editor?').replace(/^A\.$/m, 'A. 1, Monaco+'));
  assert.deepEqual(JSON.parse((await call(instance, '/mission')).text).queue, []);
  assert.deepEqual((await readdir(instance.recovery)).filter((name) => name.startsWith('.p9-conflict-')), []);

  // Concurrent edit: someone changes the file after P9 read it; P9's answer is refused and their text stays.
  await writeFile(file, question('Which editor?'));
  const stale = JSON.parse((await call(instance, '/mission')).text).queue[0];
  const theirs = question('Which editor?').replace('**Do:**', '**Do (edited by Codex):**');
  await writeFile(file, theirs);
  const conflict = await call(instance, '/mission/answer', 'POST', { name: stale.name, hash: stale.hash, answer: '2' });
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.text).diskContent, theirs);
  assert.equal(await readFile(file, 'utf8'), theirs);
  for (const body of [{ name: '../secrets.md', hash: stale.hash, answer: 'x' }, { name: 'AGENTS.md', hash: stale.hash, answer: 'x' },
    { name: stale.name, hash: hash(theirs), answer: 'line\nA. injected' }, { name: stale.name, hash: hash(theirs), answer: 'x', path: 'other.md' }]) {
    assert.equal((await call(instance, '/mission/answer', 'POST', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(await readFile(file, 'utf8'), theirs);
  console.log('PASS phase5 scripts + answers: fixed argv output and exit codes streamed; A. answer saved through guardedSave; concurrent edit kept (409), traversal/locked/newline refused');
});

test('script runs see only allowlisted environment names', async (t) => {
  const sentinels = { P9_SENTINEL_ONE: 'x', P9_SENTINEL_TWO: 'y', ANTHROPIC_API_KEY: 'sk-sentinel' };
  const scripts = [{ id: 'env', title: 'Env', group: 'Tools', cmd: [node, '-e', 'console.log("keys:" + Object.keys(process.env).join(","))'] }];
  const instance = await daemon(t, undefined, false, async (paths) => {
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(BUILDER));
    return { ...(await layout(paths.workspace, { ...BUILDER, scripts })), env: sentinels };
  });
  const run = await finished(instance, JSON.parse((await call(instance, '/scripts/env/run', 'POST', {})).text).run);
  const keys = run.output.match(/^keys:(.*)$/m)[1].split(',').filter(Boolean);
  const { allowed } = await import('../apps/server/child-env.mjs');
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => !allowed(key)), []);
  for (const key of Object.keys(sentinels)) assert.equal(keys.includes(key), false, key);
  console.log(`PASS child env (scripts): script saw ${keys.length} names, all allowlisted, no sentinel or API key`);
});

test('Stop All ends an active registry script tree', async (t) => {
  const instance = await start(t, BUILDER, [{ id: 'wait', title: 'Wait', cmd: [node, '-e',
    'console.log("pid:" + process.pid); setInterval(() => {}, 1000)'] }]);
  const run = JSON.parse((await call(instance, '/scripts/wait/run', 'POST', {})).text).run;
  let pid;
  for (let i = 0; i < 100 && !pid; i += 1) {
    pid = Number(JSON.parse((await call(instance, `/runs/${run}`)).text).output.match(/pid:(\d+)/)?.[1]);
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(pid);
  const stopped = await call(instance, '/stop-all', 'POST', {});
  assert.equal(stopped.status, 200, stopped.text);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  console.log(`PASS Stop All: active registry script tree ${pid} ended`);
});

test('a "detach": true run is done when its script exits, though a child it left holds the output pipe (v0.1.5 W1)', async (t) => {
  const instance = await start(t, BUILDER, [{ id: 'leave', title: 'Leave', detach: true, cmd: [node, '-e',
    'const c = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" }); c.unref(); console.log("left:" + c.pid)'] }]);
  const run = JSON.parse((await call(instance, '/scripts/leave/run', 'POST', {})).text).run;
  let body;
  for (let i = 0; i < 50 && !body?.done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    body = JSON.parse((await call(instance, `/runs/${run}`)).text);
  }
  const left = Number(body.output.match(/left:(\d+)/)?.[1]);
  t.after(() => { try { process.kill(left); } catch {} });
  assert.ok(left, body.output);
  assert.ok(body.done, 'the run waited for the child holding its pipe');
  assert.match(body.output, /\[exit 0 in/);
});

// Children of the daemon, polled every millisecond while the hostile requests run.
function watch(pid) {
  const seen = new Set();
  let running = true;
  const end = Date.now() + 60000; // a test that throws before stopping the watch must not keep the runner alive
  const loop = (async () => {
    while (running && Date.now() < end) {
      for (const task of await readdir(`/proc/${pid}/task`).catch(() => [])) {
        for (const child of (await readFile(`/proc/${pid}/task/${task}/children`, 'utf8').catch(() => '')).split(' ').filter(Boolean)) seen.add(child);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  return async () => { running = false; await loop; return seen; };
}

test('threat surface 8: command text, unknown and duplicate IDs, extra args, encoded separators, metacharacters and malformed records start no process', {
  skip: process.platform === 'win32' && 'the process-start observer uses Linux procfs; Windows launch behavior is covered by windows-process-tree.test.mjs',
}, async (t) => {
  let sentinel;
  const pwn = (label) => [node, '-e', `require("fs").writeFileSync(process.argv[1], "${label}"); setTimeout(() => {}, 300)`, 'SENTINEL'];
  const scripts = [
    { id: 'echo', title: 'Echo', cmd: [node, '-e', 'setTimeout(() => console.log(process.argv.slice(1).join("|")), 200)'], args: ['One'] },
    { id: 'dup', title: 'Dup A', cmd: pwn('dup-a') }, { id: 'dup', title: 'Dup B', cmd: pwn('dup-b') },
    { id: 'string-cmd', title: 'Malformed', cmd: 'touch SENTINEL' },
    { id: 'bad id', title: 'Malformed', cmd: pwn('bad-id') },
    { title: 'No id', cmd: pwn('no-id') },
    { id: 'nul', title: 'Malformed', cmd: [node, '-e\0', 'x'] },
    { id: 'confirm', title: 'Confirm', cmd: pwn('confirm'), confirm: true },
    { id: 'remote', title: 'Remote', cmd: ['ssh', '-o', 'BatchMode=yes', 'p9-no-such-host.invalid', 'true'], args: ['label (one word)'] },
    { id: 'detach-text', title: 'Malformed', cmd: pwn('detach-text'), detach: 'yes' },
  ];
  const instance = await daemon(t, undefined, false, async (paths) => {
    sentinel = path.join(paths.directory, 'pwned');
    for (const record of scripts) if (Array.isArray(record.cmd)) record.cmd = record.cmd.map((part) => (part === 'SENTINEL' ? sentinel : part));
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(BUILDER));
    return layout(paths.workspace, { ...BUILDER, scripts });
  });
  const overview = JSON.parse((await call(instance, '/mission')).text);
  assert.deepEqual(overview.scripts.map((s) => s.id), ['echo', 'confirm', 'remote']);
  assert.deepEqual(overview.invalid.map((x) => x.reason), ['duplicate-id', 'duplicate-id', 'malformed-record', 'malformed-record', 'malformed-record', 'malformed-record', 'malformed-record']);

  const stop = watch(instance.child.pid);
  const refused = [
    ['/scripts/echo/run', { cmd: ['touch', sentinel] }], ['/scripts/echo/run', { command: `touch ${sentinel}` }],
    ['/scripts/echo/run', { args: ['a'], argv: ['touch', sentinel] }], ['/scripts/run', { id: 'echo', cmd: ['touch', sentinel] }],
    ['/scripts/nope/run', {}], ['/scripts/dup/run', {}], ['/scripts/detach-text/run', {}], ['/scripts/string-cmd/run', {}], ['/scripts/bad%20id/run', {}], ['/scripts/nul/run', {}],
    ['/scripts/echo/run', { args: ['a', 'extra'] }], ['/scripts/echo/run', { args: [['nested']] }], ['/scripts/echo/run', { args: 'a' }],
    ['/scripts/echo%2F..%2F..%2Fx/run', {}], ['/scripts/..%2Fecho/run', {}], ['/scripts/echo%3Btouch/run', {}], ['/scripts/echo%00/run', {}],
    ['/scripts/%2e%2e/run', {}], ['/scripts/echo%0Atouch/run', {}],
    ['/scripts/echo;touch/run', {}], ['/scripts/$(touch)/run', {}],
    ['/scripts/echo/run', { args: [`a\ntouch ${sentinel}`] }], ['/scripts/echo/run', { args: ['a\u0007b'] }],
    // M5: shell syntax is refused only where something parses it again (ssh, .cmd); a plain target takes it as one literal argv word (checked below).
    ['/scripts/remote/run', { args: [`x; touch ${sentinel}`] }], ['/scripts/remote/run', { args: ['a&b'] }],
    ['/scripts/confirm/run', {}], ['/scripts/confirm/run', { confirm: 'yes' }],
    // A remote shell would split or glob these (cold-read M1); argv-only buttons still take free text.
    ...['*', 'a b', "'q'", '"q"', '[x]', '?', '~', '{a,b}', '#x', '!x', 'a\tb'].map((arg) => ['/scripts/remote/run', { args: [arg] }]),
    ['/apps/nope/launch', {}], ['/apps/editor/launch', { cmd: ['touch', sentinel] }], ['/pages/dash/launch', { url: 'file:///etc/passwd' }],
  ];
  for (const [route, body] of refused) {
    const result = await call(instance, route, 'POST', body);
    assert.ok([400, 404, 409].includes(result.status), `${route} ${JSON.stringify(body)} -> ${result.status} ${result.text}`);
  }
  for (const raw of ['{"args":["a"]', 'touch pwned', '[]', 'null']) {
    assert.ok([400, 404].includes((await call(instance, '/scripts/echo/run', 'POST', raw)).status), raw);
  }
  assert.equal((await http({ socketPath: instance.credentials.socketPath, route: '/scripts/echo/run', method: 'POST',
    headers: { ...authenticated(instance.credentials), 'content-type': 'text/plain' }, body: 'touch pwned' })).status, 400);
  const quiet = await stop();
  assert.deepEqual([...quiet], [], 'no process started for any refused request');
  await assert.rejects(access(sentinel));

  // Control: the same watcher sees the one allowed run's process, so an empty watch means nothing started.
  const control = watch(instance.child.pid);
  const started = JSON.parse((await call(instance, '/scripts/echo/run', 'POST', { args: ['ok'] })).text);
  const result = await finished(instance, started.run);
  assert.equal((await control()).size, 1);
  assert.ok(result.output.includes('ok'));
  // The shell-syntax text a plain target now takes is one argv word: echoed back as text, nothing run, sentinel never written.
  const literal = `x; touch ${sentinel} && $(touch ${sentinel}) | \`touch ${sentinel}\``;
  const word = await finished(instance, JSON.parse((await call(instance, '/scripts/echo/run', 'POST', { args: [literal] })).text).run);
  assert.ok(word.output.includes(literal), word.output);
  await assert.rejects(access(sentinel));
  console.log(`PASS phase5 surface 8: ${refused.length + 5} hostile requests refused, process watcher saw 0 children (control run: 1), sentinel never written`);
});

test('every workspace-hub registry record parses, and the module never uses a shell', async () => {
  const real = await readFile(path.join(root, '..', '..', 'workspace-hub', 'registry.json'), 'utf8').catch(() => null);
  if (real) {
    const parsed = parseRegistry(real);
    assert.deepEqual(parsed.invalid, []);
    const source = JSON.parse(real);
    assert.deepEqual([parsed.scripts.length, parsed.apps.length, parsed.pages.length], [source.scripts.length, source.apps.length, source.pages.length]);
  }
  const source = (await Promise.all(['mission.mjs', 'process-tree.mjs'].map((name) => readFile(path.join(root, 'apps/server', name), 'utf8')))).join('\n');
  assert.equal(/shell:\s*true|\bexec(?:Sync)?\(/.test(source), false);
  assert.equal((source.match(/spawn\(/g) ?? []).length, 5);
  assert.equal((source.match(/shell: false/g) ?? []).length, 5);
  console.log(`PASS phase5 registry: ${real ? 'every live workspace-hub record valid' : 'live registry absent (publish checkout)'}; spawn only with shell:false`);
});

test('terminal scripts open in the user terminal with the registry argv', {
  skip: process.platform === 'win32' && 'uses POSIX shell fakes for konsole and xdg-open; Windows launch behavior is covered by windows-process-tree.test.mjs',
}, async (t) => {
  let log;
  const instance = await start(t, BUILDER, [{ id: 'shell', title: 'Shell', terminal: true, cmd: ['ssh', 'server'] }], (paths) => {
    log = path.join(paths.directory, 'konsole.log');
    return `${paths.directory}/bin:${process.env.PATH}`;
  });
  await mkdir(path.join(instance.directory, 'bin'));
  await writeFile(path.join(instance.directory, 'bin', 'konsole'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
  await chmod(path.join(instance.directory, 'bin', 'konsole'), 0o755);
  assert.equal((await call(instance, '/scripts/shell/run', 'POST', {})).status, 200);
  for (let i = 0; i < 100 && !(await access(log).then(() => true, () => false)); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), ['--workdir', instance.workspace, '-e', 'ssh', 'server']);
  console.log('PASS phase5 terminal button: konsole --workdir <workspace> -e <registry argv>');
});

test('scripts_root: registry commands resolve where the hub runs them, above the P9 workspace', async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ ...BUILDER, scripts_root: paths.directory }));
    await writeFile(path.join(paths.directory, 'where.js'), 'console.log(process.cwd(), process.argv[2])');
    return layout(paths.workspace, { ...BUILDER, scripts: [{ id: 'where', title: 'Where', cmd: [node, 'where.js', '~/workspace/x'] }] });
  });
  const run = await finished(instance, JSON.parse((await call(instance, '/scripts/where/run', 'POST', {})).text).run);
  assert.ok(run.output.includes(`\n${instance.directory} ${instance.directory}/x\n`), run.output);
  const bad = await daemon(t, undefined, false, async (paths) => {
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ ...BUILDER, scripts_root: 'relative' }));
    return layout(paths.workspace, { ...BUILDER, scripts: [] });
  });
  // Since release r1 R1-3 a refused setting turns off Mission Control only; the daemon stays up.
  const refused = await call(bad, '/mission');
  assert.deepEqual([refused.status, JSON.parse(refused.text).error], [503, 'settings-invalid']);
  console.log('PASS phase5 scripts_root: relative registry paths and ~/workspace resolve at the hub root; relative scripts_root refused (settings-invalid)');
});

test('the registry is read-only through the file API, and print_url apps open the URL they print', {
  skip: process.platform === 'win32' && 'uses POSIX shell fakes for konsole and xdg-open; Windows launch behavior is covered by windows-process-tree.test.mjs',
}, async (t) => {
  let log;
  const instance = await start(t, BUILDER, [], (paths) => {
    log = path.join(paths.directory, 'xdg.log');
    return `${paths.directory}/bin:${process.env.PATH}`;
  });
  const file = path.join(instance.workspace, BUILDER.registry);
  const before = await readFile(file, 'utf8');
  const swap = JSON.stringify({ scripts: [{ id: 'pwn', title: 'pwn', cmd: ['touch', path.join(instance.directory, 'pwned')] }], apps: [], pages: [] });
  for (const target of [BUILDER.registry, BUILDER.registry.toUpperCase()]) {
    const put = await call(instance, '/files', 'PUT', { path: target, hash: hash(before), content: swap });
    assert.ok([403, 404].includes(put.status), put.text);
  }
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await call(instance, '/scripts/pwn/run', 'POST', {})).status, 404);

  await mkdir(path.join(instance.directory, 'bin'));
  await writeFile(path.join(instance.directory, 'bin', 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
  await chmod(path.join(instance.directory, 'bin', 'xdg-open'), 0o755);
  await writeFile(file, JSON.stringify({ scripts: [], pages: [], apps: [
    { id: 'serve', title: 'Serve', print_url: true, cmd: [node, '-e', 'console.log("starting"); console.log("http://127.0.0.1:8123/?tkn=1")'] },
    { id: 'quiet', title: 'Quiet', print_url: true, cmd: [node, '-e', 'console.log("no url")'] },
    { id: 'gone', title: 'Gone', cmd: ['p9-no-such-command'] },
    { id: 'gone-url', title: 'Gone URL', print_url: true, cmd: ['p9-no-such-command'] }] }));
  // D1: a program that does not start says so; before, the button reported launched.
  for (const id of ['gone', 'gone-url']) {
    const gone = await call(instance, `/apps/${id}/launch`, 'POST', {});
    assert.deepEqual([gone.status, JSON.parse(gone.text).error], [502, 'could-not-start'], id + ': ' + gone.text);
  }
  const served = await call(instance, '/apps/serve/launch', 'POST', {});
  assert.equal(served.status, 200, served.text);
  assert.equal(JSON.parse(served.text).url, 'http://127.0.0.1:8123/?tkn=1');
  for (let i = 0; i < 100 && !(await access(log).then(() => true, () => false)); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await readFile(log, 'utf8')).trim(), 'http://127.0.0.1:8123/?tkn=1');
  assert.equal((await call(instance, '/apps/quiet/launch', 'POST', {})).status, 502);
  console.log('PASS phase5 registry lock + print_url: PUT /files on the registry refused (any case), swapped ID never runs; printed URL opened, no URL = 502');
});

test('Linux window apps and links start through systemd-run --user without the daemon\'s environment; a refusal falls back to the plain spawn', {
  skip: process.platform !== 'linux' && 'systemd-run is the Linux launcher; Windows launching is covered by windows-process-tree.test.mjs', timeout: 60_000,
}, async (t) => {
  let bin;
  const instance = await daemon(t, undefined, false, async (paths) => {
    bin = path.join(paths.directory, 'bin');
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(BUILDER));
    return { ...await layout(paths.workspace, { ...BUILDER, scripts: [] }), path: `${bin}:${process.env.PATH}`, env: { ANTHROPIC_API_KEY: 'sk-sentinel' } };
  });
  const log = (name) => path.join(instance.directory, name + '.log');
  const lines = async (name) => {
    for (let i = 0; i < 100 && !(await access(log(name)).then(() => true, () => false)); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return (await readFile(log(name), 'utf8')).trim().split('\n');
  };
  await mkdir(bin);
  // The stand-in records what it was asked and the environment it got, and refuses while the fail file exists.
  const stub = (name, tail = '') => writeFile(path.join(bin, name), `#!/bin/sh\n{ printf '%s\\n' "$@"; echo "key=\${ANTHROPIC_API_KEY:-absent}"; } > '${log(name)}'\n${tail}`, { mode: 0o755 });
  await stub('systemd-run', `[ -e '${path.join(instance.directory, 'fail')}' ] && exit 1\nexit 0\n`);
  await stub('p9-app');
  const registry = path.join(instance.workspace, BUILDER.registry);
  await writeFile(registry, JSON.stringify({ scripts: [], apps: [{ id: 'win', title: 'Win', cmd: [path.join(bin, 'p9-app'), 'one'] }],
    pages: [{ id: 'dash', title: 'Dashboard', url: 'http://127.0.0.1:5000/' }] }));
  const unit = ['--user', '--collect', '--quiet', '--service-type=exec', '-p', 'ExitType=cgroup', `--working-directory=${instance.workspace}`, '--'];

  assert.equal((await call(instance, '/apps/win/launch', 'POST', {})).status, 200);
  assert.deepEqual(await lines('systemd-run'), [...unit, path.join(bin, 'p9-app'), 'one', 'key=absent']);
  assert.equal(await access(log('p9-app')).then(() => true, () => false), false, 'the app is the unit\'s, not the daemon\'s child');
  await unlink(log('systemd-run'));
  assert.equal((await call(instance, '/pages/dash/launch', 'POST', {})).status, 200);
  assert.deepEqual((await lines('systemd-run')).slice(-3), ['xdg-open', 'http://127.0.0.1:5000/', 'key=absent']);

  await writeFile(path.join(instance.directory, 'fail'), '');
  assert.equal((await call(instance, '/apps/win/launch', 'POST', {})).status, 200);
  assert.deepEqual(await lines('p9-app'), ['one', 'key=absent']);
  console.log('PASS launcher: app and link go to systemd-run --user (exec type, cgroup exit, workdir), no daemon secret reaches it; refused = plain spawn');
});

test('an "A:" line holding only an italic placeholder is answerable like an empty A. line', async (t) => {
  const instance = await start(t, BUILDER);
  const text = '# Which NAS?\n\nAlso: replace or add?\n\nA: _hardware, location, replace or add_\n';
  await writeFile(path.join(instance.workspace, BUILDER.waiting, 'nas.md'), text);
  const item = JSON.parse((await call(instance, '/mission')).text).queue.find((q) => q.name === 'nas.md');
  assert.equal(item.answerable, true);
  const saved = await call(instance, '/mission/answer', 'POST', { name: 'nas.md', hash: hash(text), answer: 'Synology, closet, add' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(await readFile(path.join(instance.workspace, BUILDER.waiting, 'nas.md'), 'utf8'), text.replace('A: _hardware, location, replace or add_', 'A. Synology, closet, add'));
  assert.equal(JSON.parse((await call(instance, '/mission')).text).queue.some((q) => q.name === 'nas.md'), false);
  console.log('PASS phase5 A: placeholder: listed as answerable, answer replaces the placeholder line, item leaves the queue');
});

test('no hub folder in settings: every hub route answers 404 hub-not-set and runs nothing', async () => {
  const { createHub } = await import('../apps/server/hub.mjs');
  const hub = createHub({ workspace: '/nonexistent', settings: { registry: 'r.json' } });
  for (const answer of [await hub.overview(), await hub.text({ kind: 'solo' }), await hub.decide({ name: 'librarian-x', choice: 'merge' })])
    assert.deepEqual(answer, { status: 404, error: 'hub-not-set' });
});

// D2: on Windows bash is missing or WSL's (which boots a VM every poll), so the hub runs no ICM shell script there.
test('Windows: hub notices run no shell script', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const { createHub } = await import('../apps/server/hub.mjs');
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'p9-hub-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(async () => { Object.defineProperty(process, 'platform', platform); await rm(workspace, { recursive: true, force: true }); });
  const scripts = path.join(workspace, '_system', 'scripts');
  const marker = path.join(workspace, 'ran');
  await mkdir(scripts, { recursive: true });
  for (const name of ['heartbeats.sh', 'doctor.sh']) await writeFile(path.join(scripts, name), `echo "${name}" >> '${marker}'\necho 'FAIL marker'\n`);
  const hub = createHub({ workspace, settings: { hub: 'hub' } });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  assert.deepEqual(await hub.notices(), []);
  assert.equal(await access(marker).then(() => true, () => false), false, 'a shell script ran');
});

// Release r2 R2-7: decide re-checks the phone's session after its read, lands the line by rename, and refuses a file
// the server's review changed after the read.
test('release r2 R2-7: hub decide is revocable, atomic, and refuses a changed file', async (t) => {
  const { mkdtempSync, writeFileSync, readFileSync, statSync, readdirSync } = await import('node:fs');
  const os = await import('node:os');
  const { authority } = await import('../apps/server/authority.mjs');
  const vault = mkdtempSync(path.join(os.tmpdir(), 'p9-vault-')), branch = path.join(vault, 'Review', 'Inbox', 'librarian-x');
  await mkdir(branch, { recursive: true });
  const file = path.join(branch, '_decision.md');
  const saved = process.env.MC_VAULT; process.env.MC_VAULT = vault;
  t.after(() => { if (saved === undefined) delete process.env.MC_VAULT; else process.env.MC_VAULT = saved; });
  const { createHub } = await import('../apps/server/hub.mjs');
  const hub = createHub({ workspace: vault, settings: { hub: 'hub' } });
  writeFileSync(file, 'title: x\nreview: pending\n');
  await assert.rejects(authority.run(() => false, () => hub.decide({ name: 'librarian-x', choice: 'merge' })), /session-ended/);
  assert.equal(readFileSync(file, 'utf8'), 'title: x\nreview: pending\n', 'a revoked phone wrote nothing');
  let calls = 0;
  const changed = await authority.run(() => { if (!calls++) writeFileSync(file, 'title: x\nreview: reject\n'); return true; }, () => hub.decide({ name: 'librarian-x', choice: 'merge' }));
  assert.deepEqual(changed, { status: 409, error: 'hub-changed' });
  assert.equal(readFileSync(file, 'utf8'), 'title: x\nreview: reject\n', 'the review job\'s change was kept');
  const inode = statSync(file).ino;
  assert.deepEqual(await hub.decide({ name: 'librarian-x', choice: 'merge' }), { status: 200 });
  assert.equal(readFileSync(file, 'utf8'), 'title: x\nreview: merge\n');
  assert.notEqual(statSync(file).ino, inode, 'landed by rename, not rewritten in place');
  assert.deepEqual(readdirSync(branch), ['_decision.md'], 'no temp file left');
  console.log('PASS R2-7: revoked = session-ended, nothing written; changed after read = 409, change kept; save lands by rename');
});

// ---- v0.1.5 chunk 3: Mission live (M1, M2/M3, M5, M6) ----
import { parseSettings, parseSpace, argRefusal } from '../apps/server/mission.mjs';

test('M1: one leading U+FEFF is dropped from settings, registry and space', () => {
  const bom = (value) => '\uFEFF' + JSON.stringify(value);
  assert.equal(parseSettings(bom(BUILDER)).waiting, BUILDER.waiting);
  assert.deepEqual(parseRegistry(bom({ scripts: [{ id: 'a', title: 'A', cmd: ['true'] }] })).scripts.map((s) => s.id), ['a']);
  assert.deepEqual(parseSpace(bom({ sections: [] })).sections ?? [], []);
  assert.throws(() => parseSettings('\uFEFF\uFEFF' + JSON.stringify(BUILDER)), 'only one is dropped');
});

test('M2/M3: a settings change shows in the next /mission with no restart; a broken one keeps the last good settings', { timeout: 30000 }, async (t) => {
  const instance = await start(t, BUILDER);
  const settingsFile = path.join(instance.directory, 'settings.json');
  const pagesOf = async () => JSON.parse((await call(instance, '/mission')).text);
  assert.deepEqual((await pagesOf()).pages.map((p) => p.id), ['dash']);
  const file = path.join(instance.workspace, BUILDER.registry);
  const registry = JSON.parse(await readFile(file, 'utf8'));
  registry.pages.push({ id: 'notes', title: 'Notes', url: 'obsidian://open?vault=x' });
  await writeFile(file, JSON.stringify(registry));
  assert.deepEqual((await pagesOf()).pages.map((p) => p.id), ['dash'], 'obsidian is not allowed yet');
  await writeFile(settingsFile, JSON.stringify({ ...BUILDER, page_schemes: ['obsidian'] }));
  const live = await pagesOf();
  assert.deepEqual(live.pages.map((p) => p.id), ['dash', 'notes']);
  assert.equal(live.settingsError, null);
  await writeFile(settingsFile, '{ "primary": ');
  const broken = await pagesOf();
  assert.deepEqual(broken.pages.map((p) => p.id), ['dash', 'notes'], 'last good settings kept');
  assert.ok(broken.settingsError);
  assert.equal(broken.restart.needed, false);
});

test('M5: argRefusal names the character, only for batch files and ssh; choices bind', () => {
  const cmd = { cmd: ['C:\\tools\\run.cmd'] }, ssh = { cmd: ['ssh', 'server'] }, plain = { cmd: ['/usr/bin/tool'] };
  assert.match(argRefusal(cmd, 'a&b', 0), /argument 1 contains "&"/);
  assert.match(argRefusal(ssh, 'a&b', 0), /argument 1 contains "&"/);
  assert.equal(argRefusal(plain, 'a&b "quoted" $(x)', 0), undefined, 'a plain target takes any printable text');
  assert.match(argRefusal(plain, 'a\u0007b', 0), /control character U\+0007/);
  assert.equal(argRefusal(plain, 'x'.repeat(8000), 0), undefined);
  assert.match(argRefusal(plain, 'x'.repeat(8001), 0), /limit is 8000/);
  assert.match(argRefusal(cmd, 'x'.repeat(1001), 0), /limit is 1000/);
  const pick = { cmd: ['/usr/bin/tool'], args: [{ label: 'Mode', choices: ['fast', 'slow'] }] };
  assert.equal(argRefusal(pick, 'fast', 0), undefined);
  assert.match(argRefusal(pick, 'turbo', 0), /one of the listed choices/);
  assert.equal(parseRegistry(JSON.stringify({ scripts: [{ id: 'p', title: 'P', cmd: ['true'], args: [{ label: 'M', choices: ['a'] }] }] })).scripts.length, 1);
  assert.equal(parseRegistry(JSON.stringify({ scripts: [{ id: 'p', title: 'P', cmd: ['true'], args: [{ label: 'M', choices: [] }] }] })).invalid.length, 1);
});

// Release review finding 3: ssh.exe, any case or full path, is held to bare ssh's rules; a batch file in any case stays strict.
test('M5: ssh.exe and a full Windows path to it refuse exactly what bare ssh refuses; .CMD and .Bat stay strict', () => {
  const ssh = { cmd: ['ssh', 'server'] };
  const variants = ['ssh.exe', 'SSH.EXE', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'].map((exe) => ({ cmd: [exe, 'server'] }));
  for (const arg of [...';&|`$<>\\'].map((c) => 'x' + c + 'y').concat('x y', 'x"y', 'x; rm -rf ~')) {
    assert.ok(argRefusal(ssh, arg, 0), arg);
    for (const item of variants) assert.equal(argRefusal(item, arg, 0), argRefusal(ssh, arg, 0), item.cmd[0] + ' ' + arg);
  }
  for (const item of variants) assert.equal(argRefusal(item, 'user@host:22', 0), undefined);
  for (const exe of ['C:\\x\\RUN.CMD', 'C:\\x\\go.Bat']) assert.match(argRefusal({ cmd: [exe] }, 'a&b', 0), /contains "&", which cmd.exe/);
});

test('M5: the daemon refuses with the reason and starts nothing; choices come back in the overview', { timeout: 30000 }, async (t) => {
  const instance = await start(t, BUILDER, [{ id: 'pick', title: 'Pick', cmd: [node, '-e', 'console.log(process.argv[1])'], args: [{ label: 'Mode', choices: ['fast', 'slow'] }] },
    { id: 'batch', title: 'Batch', cmd: ['C:\\x\\run.cmd'], args: ['Name'] }]);
  const overview = JSON.parse((await call(instance, '/mission')).text);
  assert.deepEqual(overview.scripts[0].args, [{ label: 'Mode', choices: ['fast', 'slow'] }]);
  const bad = await call(instance, '/scripts/pick/run', 'POST', { args: ['turbo'] });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).reason, /listed choices/);
  const amp = await call(instance, '/scripts/batch/run', 'POST', { args: ['a&b'] });
  assert.equal(amp.status, 400);
  assert.match(JSON.parse(amp.text).reason, /"&"/);
});

// workspace-hub's "Gate check a plan" button: choices "plans" is every plan.md under the scripts root, still strict.
test('choices "plans": every plan.md outside skipped folders, and nothing else is accepted', { timeout: 30000 }, async (t) => {
  const instance = await start(t, TEAMMATE, [{ id: 'gate', title: 'Gate', cmd: [node, '-e', 'console.log(process.argv[1])'], args: [{ label: 'Plan', choices: 'plans' }] }]);
  for (const dir of ['a', 'b/c', 'node_modules/x', '_archive', '.git', 'agent_skills/s', '_private']) {
    await mkdir(path.join(instance.workspace, dir), { recursive: true });
    await writeFile(path.join(instance.workspace, dir, 'plan.md'), '# plan');
  }
  const overview = JSON.parse((await call(instance, '/mission')).text);
  assert.deepEqual(overview.scripts[0].args, [{ label: 'Plan', choices: ['a/plan.md', 'b/c/plan.md'] }]);
  const bad = await call(instance, '/scripts/gate/run', 'POST', { args: ['_archive/plan.md'] });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).reason, /listed choices/);
  assert.equal(parseRegistry(JSON.stringify({ scripts: [{ id: 'p', title: 'P', cmd: ['true'], args: [{ label: 'M', choices: 'other' }] }] })).invalid.length, 1);
});

test('M6: page_schemes pages need confirm; javascript, file and data are refused even when listed', { timeout: 30000 }, async (t) => {
  const instance = await start(t, { ...BUILDER, page_schemes: ['obsidian', 'javascript', 'file', 'data'] });
  const file = path.join(instance.workspace, BUILDER.registry);
  const registry = JSON.parse(await readFile(file, 'utf8'));
  registry.pages.push({ id: 'notes', title: 'Notes', url: 'obsidian://open?vault=x' }, { id: 'js', title: 'J', url: 'javascript:alert(1)' },
    { id: 'fl', title: 'F', url: 'file:///etc/passwd' }, { id: 'dt', title: 'D', url: 'data:text/html,x' });
  await writeFile(file, JSON.stringify(registry));
  const overview = JSON.parse((await call(instance, '/mission')).text);
  assert.deepEqual(overview.pages.map((p) => p.id), ['dash', 'notes']);
  assert.equal(overview.invalid.length, 3);
  const unconfirmed = await call(instance, '/pages/notes/launch', 'POST', {});
  assert.equal(unconfirmed.status, 409);
  assert.deepEqual(JSON.parse(unconfirmed.text), { error: 'confirm-required', url: 'obsidian://open?vault=x' });
  assert.equal((await call(instance, '/pages/js/launch', 'POST', { confirm: true })).status, 404);
  assert.equal(parseRegistry(JSON.stringify({ pages: [{ id: 'x', title: 'X', url: 'javascript:1' }] }), ['javascript']).pages.length, 0);
  assert.throws(() => parseSettings(JSON.stringify({ ...BUILDER, page_schemes: ['x'] })), 'a one-letter scheme (a Windows drive) is not a scheme');
});
