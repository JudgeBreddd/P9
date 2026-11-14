import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { daemon, http, authenticated, root } from './helpers.mjs';

// Phase 4 F5 (daemon CPU and memory per turn): one measurement that runs unchanged on main and on the branch. It reads the
// daemon process's own CPU time and memory from /proc (the agent is a separate process and not counted). Linux only.
// A: 20 turns of 300 streamed updates each while three clients long-poll /chat/events (a window and two phones).
// B: 200 rounds of what an open window polls: /mission, /mission/icons, /health, /chat and each data tile.
// Prints one PERF line; the numbers go in numbers.md. ponytail: /proc CPU ticks are 10 ms; the totals are seconds.
const TURNS = 20, ROUNDS = 200, TILES = ['a', 'b', 'c', 'd'];
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const SCRIPTS = TILES.map((id) => ({ id, title: 'Tile ' + id, cmd: ['echo', '{"type":"stat","value":1}'] }))
  .concat(Array.from({ length: 30 }, (_, i) => ({ id: 's' + i, title: 'Script ' + i, desc: 'x'.repeat(80), cmd: ['echo', String(i)] })));
const SPACE = { sections: [{ id: 'home', title: 'Home', data: TILES.map((id) => ({ id: 'tile-' + id, title: id, script: id })),
  links: Array.from({ length: 10 }, (_, i) => ({ id: 'l' + i, title: 'Link ' + i, url: 'https://example.com/' + i })) }] };

const tick = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const cpuMs = async (pid) => { const f = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) * 1000 / tick; };
const memMiB = async (pid) => { const s = await readFile(`/proc/${pid}/status`, 'utf8'); const kb = (k) => Number(new RegExp(k + ':\\s+(\\d+)').exec(s)[1]); return { rss: kb('VmRSS') / 1024, hwm: kb('VmHWM') / 1024 }; };

test('perf F5: daemon CPU and memory per streamed turn and per window poll round', { skip: process.platform !== 'linux', timeout: 600000 }, async (t) => {
  const fake = path.join(root, 'test/fake-acp-agent.mjs');
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace;
    for (const folder of ['hub', 'projects', '_waiting']) await mkdir(path.join(w, folder), { recursive: true });
    await writeFile(path.join(w, SETTINGS.registry), JSON.stringify({ scripts: SCRIPTS, apps: [], pages: [] }));
    await writeFile(path.join(w, SETTINGS.primary), '# Projects\n');
    await writeFile(path.join(w, SETTINGS.space), JSON.stringify(SPACE));
    for (let i = 0; i < 5; i++) await writeFile(path.join(w, '_waiting', `q${i}.md`), `# Question ${i}\n\nQ. Which?\n\nA.\n`);
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify(SETTINGS));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const call = async (route, method = 'GET', body) => {
    const result = await http({ socketPath: instance.credentials.socketPath, route, method, timeout: 30000,
      headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, body: JSON.parse(result.text) };
  };
  const pid = instance.child.pid;
  const id = (await call('/chat', 'POST', { provider: 'claude' })).body.conversation;
  assert.ok(id);
  for (const tileId of TILES) await call('/mission/data/allow', 'POST', { id: 'tile-' + tileId });

  // A: streamed turns under three long-pollers.
  let cursor = (await call('/chat/events?after=0')).body.cursor, polling = true, ends = 0;
  const poller = async () => { let at = cursor; while (polling) { const page = (await call(`/chat/events?after=${at}&wait=8000`)).body; at = page.cursor; } };
  const pollers = [poller(), poller(), poller()];
  const turn = async (text) => {
    assert.equal((await call(`/chat/${id}/prompt`, 'POST', { text })).status, 202);
    for (;;) {
      const page = (await call(`/chat/events?after=${cursor}&wait=8000`)).body;
      cursor = page.cursor;
      if (page.events.some((e) => e.conversation === id && ['turn-end', 'error'].includes(e.type))) return;
    }
  };
  await turn('stream 5'); // warm-up: the agent process and first-turn work are not measured
  const cpuA = await cpuMs(pid), startedA = performance.now();
  for (let i = 0; i < TURNS; i++) { await turn('stream 100'); ends += 1; }
  const wallA = performance.now() - startedA, usedA = await cpuMs(pid) - cpuA, memA = await memMiB(pid);
  polling = false;
  await call(`/chat/${id}/prompt`, 'POST', { text: 'stream 1' }); // wakes the pollers so they end
  await Promise.all(pollers);

  // B: what an open window polls, ROUNDS times.
  const statuses = new Set();
  for (const route of ['/mission', '/mission/icons', '/health', '/chat', ...TILES.map((x) => '/mission/data?id=tile-' + x)]) statuses.add((await call(route)).status);
  const cpuB = await cpuMs(pid), startedB = performance.now();
  for (let i = 0; i < ROUNDS; i++) {
    await Promise.all([call('/mission'), call('/mission/icons'), call('/health'), call('/chat'), ...TILES.map((x) => call('/mission/data?id=tile-' + x))]);
  }
  const wallB = performance.now() - startedB, usedB = await cpuMs(pid) - cpuB, memB = await memMiB(pid);
  assert.deepEqual([...statuses], [200], 'every polled route answers');
  const out = { turnCpuMs: +(usedA / TURNS).toFixed(1), turnWallMs: +(wallA / TURNS).toFixed(0), roundCpuMs: +(usedB / ROUNDS).toFixed(2),
    roundWallMs: +(wallB / ROUNDS).toFixed(1), rssAfterTurnsMiB: +memA.rss.toFixed(1), rssEndMiB: +memB.rss.toFixed(1), peakMiB: +memB.hwm.toFixed(1), turns: ends, rounds: ROUNDS };
  console.log('PERF ' + JSON.stringify(out));
});
