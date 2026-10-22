import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { collectBundle, windowsSources } from '../scripts/teh.mjs';
import { daemon, root } from './helpers.mjs';

test('doctor allowlists output and real CLI bundle excludes credentials and sentinels', async (t) => {
  const secret = 'SENTINEL_NOT_FOR_BUNDLE_2391';
  const bundle = collectBundle({ daemon: { status: 'ok', secret },
    status: `ActiveState=active\nSubState=running\nResult=success\nEnvironment=${secret}\n`,
    journal: [JSON.stringify({ MESSAGE: secret }), JSON.stringify({ MESSAGE: 'P9_READY', other: secret }),
      JSON.stringify({ MESSAGE: 'P9_READY ' + secret }),
      JSON.stringify({ MESSAGE: JSON.stringify({ event: 'P9_DRAFT_RETAINED', content: secret, path: secret }) }),
      JSON.stringify({ MESSAGE: JSON.stringify({ event: 'P9_REQUEST_FAILED', code: 'ENOSPC', secret }) }),
      JSON.stringify({ MESSAGE: JSON.stringify({ event: 'P9_REQUEST_FAILED', code: secret }) }), secret].join('\n') });
  assert.equal(bundle.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'one version (release r2 R2-9)');
  assert.deepEqual(bundle.logs, [{ event: 'P9_READY' }, { event: 'P9_DRAFT_RETAINED' }, { event: 'P9_REQUEST_FAILED', code: 'ENOSPC' }]);
  assert.deepEqual(bundle.unit, { ActiveState: 'active', SubState: 'running', Result: 'success' });
  assert.equal(JSON.stringify(bundle).includes(secret), false);
  const instance = await daemon(t);
  await writeFile(path.join(instance.recovery, '.p9-conflict-fixture'), JSON.stringify({ content: secret }), { mode: 0o600 });
  await writeFile(path.join(instance.recovery, '.p9-record-incomplete'), secret);
  const target = path.join(instance.directory, 'bundle.json');
  execFileSync(process.execPath, ['scripts/teh.mjs', 'doctor', '--state', instance.state, '--bundle', target], { cwd: root,
    env: { PATH: process.env.PATH, P9_SENTINEL: secret } });
  const actual = await readFile(target, 'utf8');
  const parsed = JSON.parse(actual);
  assert.equal(parsed.daemon.status, 'ok');
  assert.equal(parsed.daemon.recoveryRecordCount, 1);
  assert.equal(parsed.node, '26.10.0');
  assert.equal(actual.includes(secret), false);
  assert.equal(actual.includes(instance.credentials.cookie), false);
  assert.equal(actual.includes(instance.credentials.csrf), false);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  console.log('PASS teh doctor --bundle: real daemon, JSON file inspected, credential/environment/journal sentinels absent');
});

// GitHub issue #6 B4: Windows has no systemd; the task and daemon.log feed the same allowlist.
test('doctor on Windows: the task stands in for the unit and daemon.log for the journal', () => {
  const secret = 'SENTINEL_NOT_FOR_BUNDLE_2391';
  const log = ['2026-10-22T10:00:00 host started', secret, 'P9_READY', JSON.stringify({ event: 'P9_REQUEST_FAILED', code: 'EPERM', path: secret })].join('\r\n') + '\r\n';
  const current = collectBundle({ daemon: { status: 'unavailable' }, ...windowsSources({ state: 'Running', execute: 'conhost.exe', arguments: secret }, log) });
  assert.deepEqual(current.unit, { ActiveState: 'running', SubState: 'conhost' });
  assert.deepEqual(current.logs, [{ event: 'P9_READY' }, { event: 'P9_REQUEST_FAILED', code: 'EPERM' }]);
  assert.equal(JSON.stringify(current).includes(secret), false);
  assert.deepEqual(collectBundle({ ...windowsSources({ state: 'Ready', execute: 'powershell.exe' }, ''), journal: '' }).unit, { ActiveState: 'ready', SubState: 'powershell' }, 'v0.1.1\'s task');
  assert.deepEqual(collectBundle(windowsSources(null, Array(150).fill('P9_READY').join('\n'))).unit, { ActiveState: 'missing', SubState: 'missing' });
  assert.equal(collectBundle(windowsSources(null, Array(150).fill('P9_READY').join('\n'))).logs.length, 100, 'last 100 lines');
  console.log('PASS doctor Windows sources: task state and action in unit, daemon.log through the allowlist, sentinel absent');
});
