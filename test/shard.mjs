// CI's Tests job runs on several runners at once (0.1.8 F1): this prints the test files for one shard. Files go longest
// first to the least loaded shard, by test/timings.json (seconds per file, summed from one CI run's log; a file not in it
// counts 8 s). node test/shard.mjs <index> <count>. ponytail: timings.json is a snapshot; refresh it when a shard runs long.
// O208: a file that times the app runs alone, never beside other files: `node test/shard.mjs together|alone <files>` prints
// the files of the list that run together, or the ones that each run alone after them (test.yaml). shell-bundle's warm usable
// median (300 ms budget; 221 ms on CI when it was set) went to 334-631 ms when a new file moved it into a busier shard (#398, #406).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ALONE = new Set(['shell-bundle.test.mjs']);
// C2 (O287): convention tests that need no build and no browser run in CI's `quick` job, first, never in a shard.
// `node test/shard.mjs quick` prints them. acp-contract is the fixture-version check (an adapter bump with a stale fixture).
const QUICK = new Set(['inventory.test.mjs', 'agent-literals.test.mjs', 'acp-contract.test.mjs', 'ruleset-main.test.mjs']);
const [mode, ...list] = process.argv.slice(2);
// C1 (O286): test/quarantine.json lists flaky tests taken off the blocking path, { file, name, row, since }. `pattern` prints
// one regex matching exactly their names (empty when there are none), for the quarantine job's --test-name-pattern;
// `pattern <files>` only the entries of those files, for --test-skip-pattern on a quarantined file's own call (#573 r1: a
// title alone would also skip a same-title test in another file). A quarantined file runs alone, one call each, as
// shell-bundle does, so no other file shares its skip. `quarantine` prints their files. test/quarantine.test.mjs keeps it honest.
if (mode === 'pattern' || mode === 'quarantine') {
  const q = JSON.parse(readFileSync(new URL('quarantine.json', import.meta.url), 'utf8'));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mine = list.length ? q.filter((t) => list.includes(t.file)) : q;
  console.log(mode === 'pattern' ? (mine.length ? `^(${mine.map((t) => esc(t.name)).join('|')})$` : '') : [...new Set(q.map((t) => t.file))].join(' '));
  process.exit(0);
}
// #573 r1 #4-#5 (O293): `report <log>` prints each entry's outcome in the quarantine job's log: passed (its P9_PASS line,
// which names the file), failed (a ✖ line with its name), or no result, which is an entry whose test no longer runs.
if (mode === 'report') {
  const q = JSON.parse(readFileSync(new URL('quarantine.json', import.meta.url), 'utf8')), log = readFileSync(list[0], 'utf8').split('\n');
  for (const t of q) {
    const outcome = log.some((l) => l.includes(`P9_PASS ${t.file} :: ${t.name}`)) ? 'passed'
      : log.some((l) => /^\s*✖ /.test(l.replace(/^\S+Z /, '')) && l.includes('✖ ' + t.name)) ? 'failed' : 'no result (the test did not run: fix the entry)';
    console.log(`- ${outcome}: ${t.name} (${t.file}, ${t.row})`);
  }
  process.exit(0);
}
if (mode === 'quick') {
  console.log([...QUICK].sort().map((name) => 'test/' + name).join(' '));
  process.exit(0);
}
if (mode === 'together' || mode === 'alone') {
  const quarantined = new Set(JSON.parse(readFileSync(new URL('quarantine.json', import.meta.url), 'utf8')).map((t) => path.basename(t.file)));
  const alone = (file) => ALONE.has(path.basename(file)) || quarantined.has(path.basename(file));
  console.log(list.filter((file) => alone(file) === (mode === 'alone')).join(' '));
  process.exit(0);
}
const [index, count] = process.argv.slice(2).map(Number);
if (!(count > 0 && index >= 0 && index < count)) throw new Error('usage: node test/shard.mjs <index> <count>');
const dir = new URL('./', import.meta.url);
const timings = JSON.parse(readFileSync(new URL('timings.json', dir), 'utf8'));
const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs') && !QUICK.has(name)).sort()
  .map((name) => ({ name, seconds: timings[name] ?? 8 })).sort((a, b) => b.seconds - a.seconds);
const shards = Array.from({ length: count }, () => ({ seconds: 0, names: [] }));
for (const file of files) {
  const least = shards.reduce((a, b) => (b.seconds < a.seconds ? b : a));
  least.seconds += file.seconds;
  least.names.push('test/' + file.name);
}
console.log(shards[index].names.join(' '));
