// The first-run setup wizard (threat model row 17): /setup re-reads the disk on every call, and "Create my starter
// files" is create-only, never follows a link out of the workspace, never touches an invalid settings file, and loads
// the new settings without a daemon restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { daemon, http, authenticated } from './helpers.mjs';

const call = async (instance, route, method = 'GET', body, type = 'application/json') => {
  const result = await http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': type }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: result.status, body: JSON.parse(result.text) };
};
const settingsPath = (directory) => process.platform === 'win32' ? path.join(directory, 'roaming-app-data', 'P9', 'settings.json')
  : path.join(directory, '.config', 'p9', 'settings.json');
const STARTER = { primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' };

test('Setup wizard: starter files are create-only and the settings load live (threat model row 17)', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    await writeFile(path.join(workspace, 'AGENTS.md'), 'mine'); // an existing file counts as done
    return {};
  });
  const file = settingsPath(instance.directory);
  let s = (await call(instance, '/setup')).body;
  assert.deepEqual([s.settings, s.settingsPresent, s.settingsInvalid, s.settingsError, s.writable, s.workspaceEmpty, s.agentsFile, s.registryFile],
    [false, false, false, null, true, false, true, false]);
  assert.equal(s.tmux === null, process.platform !== 'linux');
  assert.equal((await call(instance, '/mission')).body.error, 'settings-missing');

  // Exactly {} as JSON, nothing else.
  for (const [body, type] of [[{ x: 1 }], [[]], ['null'], ['{}', 'text/plain']]) assert.equal((await call(instance, '/setup/starter', 'POST', body, type)).status, 400, JSON.stringify(body));
  await assert.rejects(stat(file));

  const made = await call(instance, '/setup/starter', 'POST', {});
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.created, ['mission/registry.json', 'needs-you/AGENTS.md', '_ideas/', file]);
  assert.equal(await readFile(path.join(instance.workspace, 'AGENTS.md'), 'utf8'), 'mine');
  assert.deepEqual(JSON.parse(await readFile(path.join(instance.workspace, 'mission/registry.json'), 'utf8')), { scripts: [], apps: [], pages: [] });
  assert.deepEqual(await readdir(path.join(instance.workspace, '_ideas')), []);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), STARTER);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);

  // Live: Mission answers now, nothing in needs-you/ counts as waiting, and the new registry is read-only to P9.
  const mission = await call(instance, '/mission');
  assert.equal(mission.status, 200, JSON.stringify(mission.body));
  assert.deepEqual([mission.body.queue, mission.body.primary, mission.body.waiting], [[], null, 'needs-you']);
  assert.equal((await call(instance, '/files', 'PUT', { path: 'mission/registry.json', hash: '0'.repeat(64), content: '{}' })).status, 403);
  s = (await call(instance, '/setup')).body;
  assert.deepEqual([s.settings, s.settingsPresent, s.agentsFile, s.registryFile], [true, true, true, true]);

  // Again: nothing to make, nothing replaced.
  await writeFile(path.join(instance.workspace, 'needs-you/AGENTS.md'), 'edited');
  const again = await call(instance, '/setup/starter', 'POST', {});
  assert.deepEqual([again.status, again.body.created], [201, []]);
  assert.equal(await readFile(path.join(instance.workspace, 'needs-you/AGENTS.md'), 'utf8'), 'edited');
  console.log('PASS starter: create-only, settings 0600, Mission live without a restart, registry read-only, second run makes nothing');
});

test('Setup wizard: an invalid settings file is shown, never overwritten; a valid one on disk loads live (threat model row 17)', { timeout: 60000 }, async (t) => {
  let file;
  const instance = await daemon(t, undefined, false, async ({ directory }) => {
    file = settingsPath(directory);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"primary": "AGENTS.md",');
    return {};
  });
  const s = (await call(instance, '/setup')).body;
  assert.deepEqual([s.settings, s.settingsPresent, s.settingsInvalid], [false, true, true]);
  assert.match(s.settingsError, /JSON/);
  const refused = await call(instance, '/setup/starter', 'POST', {});
  assert.deepEqual([refused.status, refused.body.error], [409, 'settings-invalid']);
  assert.match(refused.body.detail, /JSON/);
  assert.equal(await readFile(file, 'utf8'), '{"primary": "AGENTS.md",');
  assert.deepEqual((await readdir(instance.workspace)).sort(), ['note.txt'], 'nothing made while the settings are invalid');

  // Fixed by hand (or by an agent): the starter follows its paths and loads it, no restart.
  await writeFile(file, JSON.stringify({ primary: 'docs/ME.md', registry: 'r.json', waiting: 'inbox' }));
  const made = await call(instance, '/setup/starter', 'POST', {});
  assert.deepEqual([made.status, made.body.created], [201, ['docs/ME.md', 'r.json', 'inbox/AGENTS.md', '_ideas/']]);
  assert.equal((await call(instance, '/mission')).status, 200);
  console.log('PASS starter: invalid settings refused with the parse error and left byte-identical; a fixed file loads live');
});

test('Setup wizard: the starter never follows a link out of the workspace (threat model row 17)', { skip: process.platform === 'win32' && 'Linux links; files-windows.test.mjs covers reparse points', timeout: 60000 }, async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'p9-outside-'));
  // The settings (loaded at start) put the waiting folder under a link: making it walks through link/ with no-follow, so nothing lands outside.
  const instance = await daemon(t, undefined, false, async ({ directory, workspace }) => {
    await symlink(outside, path.join(workspace, 'link'));
    await mkdir(path.dirname(settingsPath(directory)), { recursive: true });
    await writeFile(settingsPath(directory), JSON.stringify({ ...STARTER, waiting: 'link/inbox' }));
    return {};
  });
  const refused = await call(instance, '/setup/starter', 'POST', {});
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.deepEqual(await readdir(outside), [], 'nothing made through the link');
  console.log('PASS starter: a waiting folder under a link to outside is refused and nothing lands outside');
});
