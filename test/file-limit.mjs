// A per-file time limit for node --test, as a reporter (the Linux CI Tests line adds it beside spec). The hang row, 0.1.9
// phase 4.5: a test file whose event loop is blocked (a synchronous child run) or that hangs outside any test never trips
// --test-timeout, which runs inside that file's own process, and spec reports files in order, so the job log stopped at the
// file before it and named nothing for up to 29 minutes. A reporter runs in the parent runner, which is not blocked: a
// file still running after P9_FILE_LIMIT_S seconds is named here, and on Linux its process tree is killed so the runner
// fails it by name and the files after it report. 600 s: the longest whole Linux shard in CI ran 612 s, under the 30 min job.
// ponytail: a grandchild that left the tree (setsid then reparented) is not killed; --test-force-exit still ends the run.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const limit = Number(process.env.P9_FILE_LIMIT_S || 600);
// The file's own test (the runner's per-file entry) is named by the file's path; tests inside it carry their own names.
const fileOf = (data) => data?.file && data.nesting === 0 && path.resolve(String(data.name)) === path.resolve(data.file) ? path.resolve(data.file) : null;

function killTree(file) {
  const all = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      all.push({ pid: Number(pid), ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), args: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0') });
    } catch {} // gone meanwhile
  }
  const root = all.find((p) => p.ppid === process.pid && p.args.some((arg) => arg && path.resolve(arg) === file));
  if (!root) return 'its process was not found';
  const tree = [root.pid];
  for (let i = 0; i < tree.length; i++) for (const p of all) if (p.ppid === tree[i]) tree.push(p.pid);
  for (const pid of tree) try { process.kill(pid, 'SIGKILL'); } catch {}
  return `killed its ${tree.length} processes`;
}

export default async function* fileLimit(source) {
  const timers = new Map();
  for await (const event of source) {
    const file = fileOf(event.data);
    if (!file) continue;
    if (event.type === 'test:dequeue' && !timers.has(file)) {
      timers.set(file, setTimeout(() => {
        const how = process.platform === 'linux' ? killTree(file) : 'not killed off Linux';
        process.stderr.write(`✖ ${path.relative(process.cwd(), file)} still running after ${limit} s (per-file limit, P9_FILE_LIMIT_S); ${how}\n`);
      }, limit * 1000).unref());
    } else if (event.type === 'test:complete') {
      clearTimeout(timers.get(file));
      timers.delete(file);
    }
  }
}
