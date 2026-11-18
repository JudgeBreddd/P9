// O189 test hook (script-say.test.mjs): an approved sprint script that hands the test what P9 put in its environment,
// prints its token (P9 must keep it out of hooks.log), starts a program that outlives it holding its output, then stays
// running until the test says go. Run as `late`, it is that program: once its parent has exited it calls /script with
// the inherited token and writes the answer's status to late-status (P9 must have revoked the token by then: 401).
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
const go = async () => { for (let i = 0; i < 1200 && !fs.existsSync('script-go'); i += 1) await new Promise((r) => setTimeout(r, 100)); };
if (process.argv[2] === 'late') {
  const parent = Number(process.argv[3]);
  await go();
  const alive = () => { try { process.kill(parent, 0); return true; } catch { return false; } };
  for (let i = 0; i < 2000 && alive(); i += 1) await new Promise((r) => setTimeout(r, 5));
  const status = await new Promise((resolve) => {
    const req = http.request({ socketPath: process.env.P9_SCRIPT_SOCKET, path: '/script', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-p9-script': process.env.P9_SCRIPT_TOKEN ?? '' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', (e) => resolve('error ' + e.message));
    req.end(JSON.stringify({ action: 'note', chat: process.argv[4], text: 'after my parent ended' }));
  });
  fs.writeFileSync('late-status', String(status));
  process.exit(0);
}
fs.writeFileSync('script-env.json', JSON.stringify({ socket: process.env.P9_SCRIPT_SOCKET ?? null, token: process.env.P9_SCRIPT_TOKEN ?? null }));
process.stdout.write('my token is ' + (process.env.P9_SCRIPT_TOKEN ?? 'none') + '\n');
const lead = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')?.sprint?.id ?? '';
spawn(process.execPath, [process.argv[1], 'late', String(process.pid), lead], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
await go();
