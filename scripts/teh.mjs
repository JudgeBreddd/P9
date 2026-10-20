import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ORIGIN } from '../packages/protocol/index.mjs';

// One version, package.json's (release r2 R2-9).
const VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

export async function health(state) {
  const credentials = JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: credentials.socketPath ?? path.join(state, 'daemon.sock'), path: '/health',
      headers: { host: 'p9.local', origin: ORIGIN, cookie: `p9=${credentials.cookie}` }, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error('unhealthy')));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// One authenticated request to the daemon over its Unix socket; resolves { status, body }.
export async function daemonRequest(state, method, route, body, op = randomUUID()) {
  const credentials = JSON.parse(await readFile(path.join(state, 'desktop.json'), 'utf8'));
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: credentials.socketPath ?? path.join(state, 'daemon.sock'), path: route, method, timeout: 10000,
      headers: { host: 'p9.local', origin: ORIGIN, cookie: `p9=${credentials.cookie}`, 'x-p9-csrf': credentials.csrf,
        ...(method === 'GET' ? {} : { 'x-p9-op': op }), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { reject(new Error('bad-response')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

export function collectBundle({ status, journal, daemon }) {
  const allowed = new Set(['P9_READY', 'P9_START_FAILED']);
  return {
    version: VERSION, node: process.versions.node, platform: process.platform,
    daemon: daemon?.status === 'ok' ? { status: 'ok', phase: 3, writes: daemon.writes === 'guarded' ? 'guarded' : 'unavailable',
      recoveryRecordCount: Number.isSafeInteger(daemon.recoveryRecordCount) && daemon.recoveryRecordCount >= 0
        ? daemon.recoveryRecordCount : null } : { status: 'unavailable' },
    unit: Object.fromEntries(status.split('\n').filter((line) => /^(?:ActiveState|SubState|Result)=[a-z-]+$/.test(line))
      .map((line) => line.split('='))),
    logs: journal.split('\n').flatMap((line) => {
      try {
        const record = JSON.parse(line);
        if (record.MESSAGE) {
          try {
            const event = JSON.parse(record.MESSAGE);
            if (event.event === 'P9_DRAFT_RETAINED') return [{ event: 'P9_DRAFT_RETAINED' }];
            if (event.event === 'P9_REQUEST_FAILED' && ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'EIO', 'INTERNAL_FAILURE'].includes(event.code)) {
              return [{ event: event.event, code: event.code }];
            }
          } catch {}
        }
        return allowed.has(record.MESSAGE) ? [{ event: record.MESSAGE }] : [];
      } catch { return []; }
    }),
  };
}

function command(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    state: { type: 'string' }, bundle: { type: 'string' },
  } });
  if (positionals[0] === 'devices' && values.state) {
    // teh devices [approve|refuse <enrollment id> | lock|revoke <device id> | reset]: the desktop side of phone enrollment.
    const [, action, id] = positionals;
    const route = !action ? null : action === 'reset' ? '/devices/reset'
      : ['approve', 'refuse'].includes(action) && id ? `/devices/enrollments/${encodeURIComponent(id)}/${action}`
      : ['lock', 'revoke'].includes(action) && id ? `/devices/${encodeURIComponent(id)}/${action}` : undefined;
    if (route === undefined) throw new Error('use-devices-[approve|refuse|lock|revoke <id>|reset]');
    const result = route ? await daemonRequest(values.state, 'POST', route, {}) : await daemonRequest(values.state, 'GET', '/devices');
    process.stdout.write(JSON.stringify(result.body, null, 2) + '\n');
    if (result.status !== 200) process.exitCode = 1;
  } else {
  if (positionals.join(' ') !== 'doctor' || !values.state) throw new Error('use-doctor-or-devices-with-state');
  const daemon = await health(values.state).catch(() => ({ status: 'unavailable' }));
  const bundle = collectBundle({ daemon,
    status: command('systemctl', ['--user', 'show', 'p9-foundation.service', '--property=ActiveState,SubState,Result']),
    journal: command('journalctl', ['--user', '-u', 'p9-foundation.service', '-n', '100', '-o', 'json', '--no-pager']),
  });
  const text = JSON.stringify(bundle, null, 2) + '\n';
  if (values.bundle) await writeFile(values.bundle, text, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(text);
  if (daemon.status !== 'ok') process.exitCode = 1;
  }
}
