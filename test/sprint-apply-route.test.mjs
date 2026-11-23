// The desktop's folder-sprint routes (SECURITY.md "Applying to your folder is a yes"): the copy list, and the apply route
// refusing any request without the owner's yes before anything is written. Runs against the real daemon's desktop socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daemon, http, authenticated } from './helpers.mjs';

const ID = '0123abcd-0000-4000-8000-000000000006';
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));

test('Folder sprint routes: the copy list names the sprint, and an apply without the owner\'s yes is refused by the route before anything is written', { timeout: 120000 }, async (t) => {
  // --ownership: the sprints folder is <ownership>/sprints (chat.mjs); a throwaway one, removed after.
  const own = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p9-own-')));
  t.after(() => fs.rmSync(own, { recursive: true, force: true }));
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--ownership', own] }));
  const sprint = path.join(own, 'sprints', ID);
  fs.mkdirSync(sprint, { recursive: true });
  fs.writeFileSync(path.join(sprint, 'copy-record.json'), JSON.stringify({ source: 'x', baseline: { commit: 'x' } }));
  const list = await call(instance, '/sprints');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.copies, [{ id: ID, source: 'x', applied: false }], 'the copy is listed with its folder, not applied yet');
  for (const body of [{ shown: 'x' }, { yes: false, shown: 'x' }, { yes: true, shown: 'x', extra: 1 }]) {
    const r = await call(instance, `/sprints/${ID}/apply`, 'POST', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, 'request-refused', 'the route refuses it, not the apply: ' + JSON.stringify(body));
  }
  assert.equal(fs.existsSync(path.join(sprint, 'apply-result.json')), false, 'no apply was recorded');
  assert.equal((await call(instance, `/sprints/${ID}/close`)).status, 404, 'no close view before an apply');
});
