// CI's Tests job runs on several runners at once (0.1.8 F1): this prints the test files for one shard. Files go longest
// first to the least loaded shard, by test/timings.json (seconds per file, summed from one CI run's log; a file not in it
// counts 8 s). node test/shard.mjs <index> <count>. ponytail: timings.json is a snapshot; refresh it when a shard runs long.
// O208: a file that times the app runs alone, never beside other files: `node test/shard.mjs together|alone <files>` prints
// the files of the list that run together, or the ones that each run alone after them (test.yaml). shell-bundle's warm usable
// median (300 ms budget; 221 ms on CI when it was set) went to 334-631 ms when a new file moved it into a busier shard (#398, #406).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ALONE = new Set(['shell-bundle.test.mjs']);
const [mode, ...list] = process.argv.slice(2);
// C1 (O286): test/quarantine.json lists flaky tests taken off the blocking path, { file, name, row, since }. `pattern` prints
// one regex matching exactly their names (empty when there are none): the shards pass it to --test-skip-pattern and the
// quarantine job to --test-name-pattern. `quarantine` prints their files. test/quarantine.test.mjs keeps the list honest.
if (mode === 'pattern' || mode === 'quarantine') {
  const q = JSON.parse(readFileSync(new URL('quarantine.json', import.meta.url), 'utf8'));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  console.log(mode === 'pattern' ? (q.length ? `^(${q.map((t) => esc(t.name)).join('|')})$` : '') : [...new Set(q.map((t) => t.file))].join(' '));
  process.exit(0);
}
if (mode === 'together' || mode === 'alone') {
  console.log(list.filter((file) => ALONE.has(path.basename(file)) === (mode === 'alone')).join(' '));
  process.exit(0);
}
const [index, count] = process.argv.slice(2).map(Number);
if (!(count > 0 && index >= 0 && index < count)) throw new Error('usage: node test/shard.mjs <index> <count>');
const dir = new URL('./', import.meta.url);
const timings = JSON.parse(readFileSync(new URL('timings.json', dir), 'utf8'));
const files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort()
  .map((name) => ({ name, seconds: timings[name] ?? 8 })).sort((a, b) => b.seconds - a.seconds);
const shards = Array.from({ length: count }, () => ({ seconds: 0, names: [] }));
for (const file of files) {
  const least = shards.reduce((a, b) => (b.seconds < a.seconds ? b : a));
  least.seconds += file.seconds;
  least.names.push('test/' + file.name);
}
console.log(shards[index].names.join(' '));
