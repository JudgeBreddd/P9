// Phase 12: run inside an ACP agent or a P9 terminal (working directory = the workspace). Looks for the fake API key the
// test put in the daemon's environment, reads the locked names straight from disk (same user: SECURITY.md says this works),
// and asks P9's remote file route for them with no credentials. Prints one JSON line; never prints a file's contents.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const [port, host, marker] = process.argv.slice(2);
const LOCKED = ['.p9-locked.txt', '.env', 'secrets/key.txt', '.git/config'];
const sentinelNames = Object.entries(process.env).filter(([, value]) => value?.includes(marker)).map(([name]) => name);
const disk = Object.fromEntries(LOCKED.map((name) => {
  try { return [name, readFileSync(name, 'utf8').includes(marker)]; } catch (error) { return [name, error.code]; }
}));
const ask = (name) => new Promise((resolve) => {
  const req = request({ hostname: '127.0.0.1', port, path: '/files?path=' + encodeURIComponent(name), headers: { host } }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, leaked: body.includes(marker) }));
  });
  req.on('error', () => resolve({ status: 'error', leaked: false }));
  req.end();
});
const remote = {};
for (const name of LOCKED) remote[name] = await ask(name);
console.log('PROBE ' + JSON.stringify({ sentinelNames, disk, remote }));
