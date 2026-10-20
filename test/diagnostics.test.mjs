import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { collectBundle } from '../scripts/teh.mjs';
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
