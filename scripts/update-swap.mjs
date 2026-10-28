// The server update's swap (item 14, apps/server/update.mjs), run by systemd-run outside the service it restarts.
// Node builtins only, and loaded before any rename, so moving the checkout under it changes nothing here.
// Swaps <root> for the built <next>, restarts the service and waits for /health to name the new version; if it does not
// within START_MS, the new tree goes aside as <root>.failed-<version>-<time>, the old one comes back and restarts
// (rollback/restart-tracker.sh's pattern). The old checkout stays as <root>.previous either way. Writes --result.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({ options: Object.fromEntries(['root', 'next', 'version', 'from', 'id', 'state', 'result', 'service', 'wait']
  .map((key) => [key, { type: 'string' }])) });
const START_MS = Number(a.wait ?? 60_000), stamp = new Date().toISOString().replace(/[:.]/g, '-');
const previous = a.root + '.previous', older = a.root + '.previous-' + stamp, failed = a.root + '.failed-' + a.version + '-' + stamp;
const steps = [];
// result.steps leave the server (the laptop shows them): file names only, never where they are (a URL stays whole).
const say = (line) => { steps.push(new Date().toISOString() + ' ' + line.replace(/(^|[\s'"(=])(\/[^\s'",:)]+)/g, (_, before, p) => before + path.basename(p))); };
const done = (result) => {
  writeFileSync(a.result + '.tmp', JSON.stringify({ id: a.id, version: a.version, from: a.from, at: Date.now(), ...result, steps }), { mode: 0o600 });
  renameSync(a.result + '.tmp', a.result);
  process.exit(0);
};

// rollback.mjs's rule: a start is healthy when the daemon's /health answers with that version.
const health = () => new Promise((resolve) => {
  let credentials;
  try { credentials = JSON.parse(readFileSync(path.join(a.state, 'desktop.json'), 'utf8')); } catch { return resolve(null); }
  const req = request({ socketPath: credentials.socketPath ?? path.join(a.state, 'daemon.sock'), path: '/health', timeout: 2000,
    headers: { host: 'p9.local', origin: 'http://p9.local', cookie: 'p9=' + credentials.cookie } }, (res) => {
    let body = '';
    res.setEncoding('utf8').on('data', (chunk) => { body += chunk; }).on('end', () => { try { resolve(JSON.parse(body).version ?? null); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null)).on('timeout', () => req.destroy());
  req.end();
});
const active = () => { try { return execFileSync('systemctl', ['--user', 'is-active', a.service], { encoding: 'utf8', timeout: 10_000 }).trim() === 'active'; } catch { return false; } };
async function startsAs(version) {
  try { execFileSync('systemctl', ['--user', 'restart', a.service], { stdio: 'ignore', timeout: 120_000 }); } catch (error) { say('restart failed: ' + error.message.split('\n')[0]); }
  // The health clock (--wait, which the update passes in) starts once systemd says the service is active: a slow stop of
  // the old daemon or a slow start of the unit is not counted against the new version.
  for (const end = Date.now() + 120_000; Date.now() < end && !active(); await new Promise((resolve) => setTimeout(resolve, 1000)));
  for (const end = Date.now() + START_MS; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 1000))) {
    const seen = await health();
    if (seen === version) return true;
  }
  say('no /health with ' + version + ' within ' + START_MS / 1000 + ' s');
  return false;
}

try {
  // The checkout kept from the last update moves aside until this one is healthy.
  if (existsSync(previous)) renameSync(previous, older);
  renameSync(a.root, previous);
  try { renameSync(a.next, a.root); } catch (error) { renameSync(previous, a.root); if (existsSync(older)) renameSync(older, previous); throw error; }
  say('swapped ' + a.from + ' for ' + a.version);
} catch (error) {
  say('swap failed: ' + error.message);
  rmSync(a.next, { recursive: true, force: true });
  done({ ok: false, rolledBack: true, reason: 'swap-failed' });
}
if (await startsAs(a.version)) {
  rmSync(older, { recursive: true, force: true });
  say('healthy');
  done({ ok: true });
}
try {
  renameSync(a.root, failed);
  renameSync(previous, a.root);
  if (existsSync(older)) renameSync(older, previous);
  say('put ' + a.from + ' back; the new tree is ' + path.basename(failed));
} catch (error) {
  say('could not put the old checkout back: ' + error.message);
  done({ ok: false, rolledBack: false, reason: 'rollback-failed' });
}
const back = await startsAs(a.from);
done({ ok: false, rolledBack: back, reason: back ? 'start-failed' : 'rollback-start-failed', failed: path.basename(failed) });
