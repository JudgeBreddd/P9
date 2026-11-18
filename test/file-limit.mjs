// A per-file time limit for node --test, as a reporter (the Linux CI Tests line adds it beside spec). The hang row, 0.1.9
// phase 4.5: a test file whose event loop is blocked (a synchronous child run) or that hangs outside any test never trips
// --test-timeout, which runs inside that file's own process, and spec reports files in order, so the job log stopped at the
// file before it and named nothing for up to 29 minutes. A reporter runs in the parent runner, which is not blocked: a
// file still running after P9_FILE_LIMIT_S seconds is named here, and on Linux its process tree is killed so the runner
// fails it by name and the files after it report. 600 s: settings.test.mjs alone ran 548 to 600 s of its own tests in
// green Linux runs (n = 5; slowest test 87 s), so at 600 s it was right at the limit — O117 raised the limit to 1200 s
// as a stopgap, and O120 split the file into area files (settings-{looks,wizard,modes,chats,pages}.test.mjs), each
// well under 400 s, and put the limit back at 600 s: a real hang is still named well inside the 30 min job.
// A failed test is also written here the moment it fails (dogfood 3.5 red, 0.1.9 phase 4.5): spec prints a failure's
// assertion only in its end-of-run summary, so a runner that ended early (CI 43790793989 shard 4) left a bare ✖ and no cause.
// When the runner ends (its stream ends, or the process exits: --test-force-exit, a SIGTERM), every file on its command
// line that never reported is named with how it ended (hang row, second part: CI 43790793989 shard 4 stopped after 24 of
// 27 files and nothing said which 3), and a file whose process exited before reporting says its exit code when it fails.
// ponytail: a grandchild that left the tree (setsid then reparented) is not killed; --test-force-exit still ends the run.
// ponytail: a runner killed with SIGKILL runs no handler, so it names nothing; the job log then ends at its last line.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  const timers = new Map(), started = new Set(), reported = new Set(), killed = new Set();
  // The runner's command line: node --test [flags] files. Flags start with '-'; the files are the rest that exist.
  const files = process.argv.slice(1).filter((arg) => !arg.startsWith('-') && existsSync(arg) && statSync(arg).isFile()).map((arg) => path.resolve(arg));
  let named = false;
  const unreported = (ended) => {
    if (named) return;
    named = true;
    const left = files.filter((file) => !reported.has(file));
    if (!left.length) return;
    process.stderr.write(`✖ the runner ended (${ended}) with ${left.length} of ${files.length} files unreported:\n`);
    for (const file of left) process.stderr.write(`✖ ${path.relative(process.cwd(), file)} never reported: ${killed.has(file) ? 'killed by the per-file limit' : started.has(file) ? 'still running when the runner ended' : 'never started'}\n`);
  };
  process.once('exit', (code) => unreported('exit code ' + code));
  for await (const event of source) {
    if (event.type === 'test:fail' && event.data.details?.error?.failureType !== 'subtestsFailed') {
      const { name, file: where, line, details } = event.data, error = details?.error?.cause ?? details?.error;
      const why = String(error?.stack || error?.message || error).split('\n').slice(0, 8).join('\n  ');
      const exit = details?.error?.exitCode != null || details?.error?.signal ? ` exited with ${details.error.signal ? 'signal ' + details.error.signal : 'code ' + details.error.exitCode}` : '';
      process.stderr.write(`✖ failed now: ${name} (${where ? path.relative(process.cwd(), where) : '?'}:${line ?? '?'})${exit}\n  ${why}\n`);
    }
    const file = fileOf(event.data);
    if (!file) continue;
    if (event.type === 'test:dequeue' && !timers.has(file)) {
      started.add(file);
      timers.set(file, setTimeout(() => {
        const how = process.platform === 'linux' ? killTree(file) : 'not killed off Linux';
        killed.add(file);
        process.stderr.write(`✖ ${path.relative(process.cwd(), file)} still running after ${limit} s (per-file limit, P9_FILE_LIMIT_S); ${how}\n`);
      }, limit * 1000).unref());
    } else if (event.type === 'test:complete') {
      reported.add(file);
      clearTimeout(timers.get(file));
      timers.delete(file);
    }
  }
  unreported('its stream ended');
}
