// The first-run setup wizard (threat model row 17): /setup re-reads the disk on every call, and "Create my starter
// files" is create-only, never follows a link out of the workspace, never touches an invalid settings file, and loads
// the new settings without a daemon restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { health } from '../scripts/teh.mjs';

const call = async (instance, route, method = 'GET', body, type = 'application/json') => {
  const result = await http({ socketPath: instance.credentials.socketPath, route, method,
    headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': type }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: result.status, body: JSON.parse(result.text) };
};
const settingsPath = (directory) => process.platform === 'win32' ? path.join(directory, 'roaming-app-data', 'P9', 'settings.json')
  : path.join(directory, '.config', 'p9', 'settings.json');
const fake = path.join(root, 'test/fake-acp-agent.mjs');
const until = async (check, what) => {
  for (let i = 0; i < 100; i++) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('timed out: ' + what);
};
const STARTER = { primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' };

test('Setup wizard: starter files are create-only and the settings load live (threat model row 17)', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ directory, workspace }) => {
    await writeFile(path.join(workspace, 'AGENTS.md'), 'mine'); // an existing file counts as done
    await mkdir(path.join(directory, '.claude'), { recursive: true });
    await writeFile(path.join(directory, '.claude', '.credentials.json'), '{"token":"p9-credential-marker"}');
    return {};
  });
  const file = settingsPath(instance.directory);
  let s = (await call(instance, '/setup')).body;
  // The credential file is stat'ed, never opened: only "present" reaches the page.
  assert.deepEqual([s.claude, s.codex, JSON.stringify(s).includes('p9-credential-marker')], [true, false, false]);
  assert.deepEqual([s.settings, s.settingsPresent, s.settingsInvalid, s.settingsError, s.writable, s.workspaceEmpty, s.agentsFile, s.registryFile],
    [false, false, false, null, true, false, true, false]);
  assert.equal(s.tmux === null, process.platform !== 'linux');
  // A folder with things in it: what is there is found, and the plan lists only what is missing (no _ideas/).
  assert.deepEqual([s.found, s.proposed, s.creates], [{ primary: 'AGENTS.md' }, STARTER, ['mission/registry.json', 'needs-you/AGENTS.md']]);
  assert.equal((await call(instance, '/mission')).body.error, 'settings-missing');

  // {} or the wizard's four keys as JSON, nothing else; paths are checked as settings.json's are.
  for (const [body, type] of [[{ x: 1 }], [[]], ['null'], ['{}', 'text/plain'], [{ ...STARTER, scripts_root: 'relative' }], [{ ...STARTER, waiting: '../out' }], [{ primary: 'A.md' }]])
    assert.equal((await call(instance, '/setup/starter', 'POST', body, type)).status, 400, JSON.stringify(body));
  // The fixed starter paths never land in a folder with things in it unshown: {} there needs the paths.
  assert.deepEqual(Object.values(await call(instance, '/setup/starter', 'POST', {})), [409, { error: 'paths-required' }]);
  await assert.rejects(stat(file));

  const made = await call(instance, '/setup/starter', 'POST', s.proposed);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.created, ['mission/registry.json', 'needs-you/AGENTS.md', file]);
  assert.equal(await readFile(path.join(instance.workspace, 'AGENTS.md'), 'utf8'), 'mine');
  assert.deepEqual(JSON.parse(await readFile(path.join(instance.workspace, 'mission/registry.json'), 'utf8')), { scripts: [], apps: [], pages: [] });
  assert.deepEqual((await readdir(instance.workspace)).sort(), ['AGENTS.md', 'mission', 'needs-you', 'note.txt']);
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
  // Paths while settings exist are refused: the settings file is never replaced from here.
  assert.deepEqual(Object.values(await call(instance, '/setup/starter', 'POST', { ...STARTER, registry: 'other.json' })), [409, { error: 'settings-exist' }]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), STARTER);
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
  assert.deepEqual([made.status, made.body.created], [201, ['docs/ME.md', 'r.json', 'inbox/AGENTS.md']]);
  assert.equal((await call(instance, '/mission')).status, 200);
  console.log('PASS starter: invalid settings refused with the parse error and left byte-identical; a fixed file loads live');
});

test('Setup wizard: an empty workspace gets the whole starter set, _ideas/ included', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => { await rm(path.join(workspace, 'note.txt')); return {}; });
  const s = (await call(instance, '/setup')).body;
  assert.deepEqual([s.workspaceEmpty, s.found, s.proposed, s.creates], [true, {}, STARTER, ['AGENTS.md', 'mission/registry.json', 'needs-you/AGENTS.md', '_ideas/']]);
  const made = await call(instance, '/setup/starter', 'POST', {});
  assert.deepEqual([made.status, made.body.created], [201, ['AGENTS.md', 'mission/registry.json', 'needs-you/AGENTS.md', '_ideas/', settingsPath(instance.directory)]]);
  assert.deepEqual((await readdir(instance.workspace)).sort(), ['AGENTS.md', '_ideas', 'mission', 'needs-you']);
  console.log('PASS starter: an empty folder gets AGENTS.md, the registry, needs-you/, _ideas/ and the settings file');
});
test('Setup wizard: a path naming a file where a folder goes is a 409 path-is-a-file, and nothing is made (BL1)', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t);
  const made = await call(instance, '/setup/starter', 'POST', { ...STARTER, waiting: 'note.txt' });
  assert.deepEqual([made.status, made.body], [409, { error: 'path-is-a-file', detail: 'note.txt' }]);
  assert.deepEqual(await readdir(instance.workspace), ['note.txt']);
  await assert.rejects(stat(settingsPath(instance.directory)));
  console.log('PASS starter: waiting naming a file is path-is-a-file before anything is made');
});
test('Setup settings (ST1): only settings.json keys, checked as the file is; the old file kept as .bak; Mission reads the change live', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t);
  const file = settingsPath(instance.directory);
  assert.deepEqual(Object.values(await call(instance, '/setup/settings')), [200, { settings: null, error: null }]);
  assert.deepEqual(Object.values(await call(instance, '/setup/settings', 'POST', { server_host: 'box' })), [409, { error: 'settings-missing' }]);
  assert.equal((await call(instance, '/setup/starter', 'POST', STARTER)).status, 201);
  const old = await readFile(file, 'utf8');
  assert.deepEqual((await call(instance, '/setup/settings')).body, { settings: STARTER, error: null });
  // Refused: no key, an unknown key, not an object, and anything parseSettings refuses (a required key removed too). The file stays.
  for (const [body, type] of [[{}], [{ x: 1 }], [[]], ['null'], [{ server_host: 'box' }, 'text/plain']])
    assert.deepEqual(Object.values(await call(instance, '/setup/settings', 'POST', body, type)), [400, { error: 'request-refused' }], JSON.stringify(body));
  for (const [body, word] of [[{ server_host: 'bad host!' }, 'server_host'], [{ waiting: '../out' }, 'waiting'], [{ primary: null }, 'primary is required'],
    [{ scripts_root: 'relative' }, 'scripts_root'], [{ page_schemes: ['javascript:'] }, 'page_schemes'], [{ notes_roots: { vault: 'rel' } }, 'notes_roots']]) {
    const r = await call(instance, '/setup/settings', 'POST', body);
    assert.deepEqual([r.status, r.body.error], [400, 'settings-refused'], JSON.stringify(body));
    assert.match(r.body.detail, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(await readFile(file, 'utf8'), old);
  await assert.rejects(stat(file + '.bak'));
  // Accepted: merged into the file, the old text kept as .bak, and Mission's waiting folder follows at once.
  await mkdir(path.join(instance.workspace, 'inbox'));
  const saved = await call(instance, '/setup/settings', 'POST', { server_host: 'box-1', page_schemes: ['obsidian'], waiting: 'inbox' });
  const want = { ...STARTER, waiting: 'inbox', server_host: 'box-1', page_schemes: ['obsidian'] };
  assert.deepEqual([saved.status, saved.body], [200, { settings: want }]);
  assert.deepEqual([JSON.parse(await readFile(file, 'utf8')), await readFile(file + '.bak', 'utf8')], [want, old]);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await call(instance, '/mission')).body.waiting, 'inbox');
  // null removes a key.
  assert.deepEqual((await call(instance, '/setup/settings', 'POST', { server_host: null })).body.settings, { ...STARTER, waiting: 'inbox', page_schemes: ['obsidian'] });
  // Three saves of different keys sent at once all land (each used to read the same old file, and the last write dropped the others).
  const together = await Promise.all([{ server_host: 'box-2' }, { page_schemes: ['obsidian', 'notion'] }, { waiting: 'needs-you' }].map((body) => call(instance, '/setup/settings', 'POST', body)));
  assert.deepEqual(together.map((r) => r.status), [200, 200, 200]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...STARTER, server_host: 'box-2', page_schemes: ['obsidian', 'notion'] });
  // A file made invalid by hand is shown, never overwritten from here.
  await writeFile(file, '{"primary": 1}');
  const bad = await call(instance, '/setup/settings', 'POST', { server_host: 'box' });
  assert.deepEqual([bad.status, bad.body.error], [409, 'settings-invalid']);
  assert.equal(await readFile(file, 'utf8'), '{"primary": 1}');
  assert.match((await call(instance, '/setup/settings')).body.error, /invalid-settings/);
  console.log('PASS setup settings: keys only, parseSettings rules, .bak kept, 0600, Mission live, null removes, an invalid file is left alone');
});

// c19: the wizard's folder scan does not look inside dependency or build output (packages/files HEAVY).
test('Setup wizard: a registry, AGENTS.md or waiting folder inside dist, build, venv or __pycache__ is not found', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    for (const dir of ['dist/workspace-hub', 'build/needs-you', 'venv/x', '__pycache__/x', 'node_modules/x']) await mkdir(path.join(workspace, dir), { recursive: true });
    await writeFile(path.join(workspace, 'dist/workspace-hub/registry.json'), '{}');
    for (const dir of ['build', 'venv/x', '__pycache__/x', 'node_modules/x']) await writeFile(path.join(workspace, dir, 'AGENTS.md'), 'not mine');
    await mkdir(path.join(workspace, 'notes'));
    return {};
  });
  assert.deepEqual((await call(instance, '/setup')).body.found, {});
});

test('Setup wizard: an existing workspace-hub is used as it is; only the settings file is written', { timeout: 60000 }, async (t) => {
  const hub = 'work/projects/workspace-hub';
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    await mkdir(path.join(workspace, hub), { recursive: true });
    await writeFile(path.join(workspace, hub, 'registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
    await writeFile(path.join(workspace, 'AGENTS.md'), 'mine');
    await mkdir(path.join(workspace, 'waiting'));
    // Not walked into: a dot folder, node_modules, and links.
    await mkdir(path.join(workspace, 'node_modules/workspace-hub'), { recursive: true });
    await writeFile(path.join(workspace, 'node_modules/workspace-hub/registry.json'), '{}');
    return {};
  });
  const before = (await readdir(instance.workspace)).sort();
  const s = (await call(instance, '/setup')).body;
  const found = { hub, registry: hub + '/registry.json', primary: 'AGENTS.md', waiting: 'waiting' };
  assert.deepEqual([s.found, s.proposed, s.creates], [found, found, []]);
  // Edited paths are planned again; a path settings.json would refuse is flagged, not planned.
  const edited = (await call(instance, '/setup?primary=docs/ME.md&registry=' + encodeURIComponent(hub + '/registry.json') + '&waiting=inbox')).body;
  assert.deepEqual([edited.proposed.primary, edited.creates, edited.pathsInvalid], ['docs/ME.md', ['docs/ME.md', 'inbox/AGENTS.md'], undefined]);
  assert.equal((await call(instance, '/setup?primary=../x.md&registry=r.json&waiting=w')).body.pathsInvalid, true);

  const made = await call(instance, '/setup/starter', 'POST', s.proposed);
  assert.deepEqual([made.status, made.body.created], [201, [settingsPath(instance.directory)]]);
  assert.deepEqual(JSON.parse(await readFile(settingsPath(instance.directory), 'utf8')), found);
  assert.deepEqual((await readdir(instance.workspace)).sort(), before, 'no new file or folder in the workspace');
  assert.equal((await call(instance, '/mission')).status, 200);
  // Valid settings: nothing more to make.
  assert.deepEqual((await call(instance, '/setup')).body.creates, []);
  assert.deepEqual((await call(instance, '/setup/starter', 'POST', {})).body.created, []);

  // A file the settings name goes missing: Mission names the setting and its path, nothing more.
  await writeFile(settingsPath(instance.directory), JSON.stringify({ ...found, registry: 'gone/registry.json' }));
  const missing = await call(instance, '/mission');
  assert.deepEqual([missing.status, missing.body], [404, { error: 'file-not-found', setting: 'registry', file: 'gone/registry.json' }]);
  console.log('PASS starter: a found workspace-hub, AGENTS.md and waiting/ are used; only settings.json is written; a missing file is named');
});

test('Setup wizard: an ICM-shaped workspace proposes its own primary AGENTS.md and its waiting-on folder; Create writes only the settings file', { timeout: 60000 }, async (t) => {
  const hub = 'work/workspace-hub';
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    await mkdir(path.join(workspace, hub), { recursive: true });
    await writeFile(path.join(workspace, hub, 'registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
    await mkdir(path.join(workspace, 'work/apps'), { recursive: true });
    await writeFile(path.join(workspace, 'work/AGENTS.md'), '# Work\n**Main project: Apps** (`apps/`)\n');
    await mkdir(path.join(workspace, 'work/_owner'));
    await writeFile(path.join(workspace, 'work/_owner/AGENTS.md'), '# Items Waiting On Me\n');
    return {};
  });
  const before = (await readdir(instance.workspace)).sort();
  const s = (await call(instance, '/setup')).body;
  const found = { hub, registry: hub + '/registry.json', primary: 'work/AGENTS.md', waiting: 'work/_owner' };
  assert.deepEqual([s.found, s.proposed, s.creates], [found, found, []]);
  const made = await call(instance, '/setup/starter', 'POST', s.proposed);
  assert.deepEqual([made.status, made.body.created], [201, [settingsPath(instance.directory)]]);
  assert.deepEqual((await readdir(instance.workspace)).sort(), before);
  assert.equal((await call(instance, '/mission')).status, 200);
  console.log('PASS starter: the Main project AGENTS.md and the waiting-on folder are proposed; only settings.json is written');
});

test('Setup wizard: starter settings left from another workspace never lay a starter beside this workspace\'s own layout', { timeout: 60000 }, async (t) => {
  const hub = 'work/workspace-hub';
  const instance = await daemon(t, undefined, false, async ({ directory, workspace }) => {
    await mkdir(path.dirname(settingsPath(directory)), { recursive: true });
    await writeFile(settingsPath(directory), JSON.stringify(STARTER));
    await mkdir(path.join(workspace, hub), { recursive: true });
    await writeFile(path.join(workspace, hub, 'registry.json'), '{"scripts":[],"apps":[],"pages":[]}');
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
    await mkdir(path.join(workspace, 'work/_owner'));
    await writeFile(path.join(workspace, 'work/_owner/AGENTS.md'), '# Waiting on me\n');
    return {};
  });
  const before = (await readdir(instance.workspace)).sort();
  const s = (await call(instance, '/setup')).body;
  assert.deepEqual([s.settings, s.conflict, s.creates, s.found], [true, true, [],
    { hub, registry: hub + '/registry.json', waiting: 'work/_owner' }]);
  assert.equal((await call(instance, '/setup/starter', 'POST', {})).status, 409);
  assert.deepEqual((await readdir(instance.workspace)).sort(), before, 'nothing created');
  console.log('PASS starter: loaded starter settings on a folder with its own layout create nothing');
});

test('Setup wizard: confirming the found paths repoints loaded settings; the old file is kept, other keys carry over, nothing else is made (threat model row 38)', { timeout: 60000 }, async (t) => {
  const hub = 'work/workspace-hub';
  const instance = await daemon(t, undefined, false, async ({ directory, workspace }) => {
    await mkdir(path.dirname(settingsPath(directory)), { recursive: true });
    await writeFile(settingsPath(directory), JSON.stringify({ ...STARTER, page_schemes: ['obsidian'] }));
    await writeFile(settingsPath(directory) + '.bak', 'older backup');
    await mkdir(path.join(workspace, hub), { recursive: true });
    await writeFile(path.join(workspace, hub, 'registry.json'),
      JSON.stringify({ scripts: [{ id: 'hubdoc', title: 'Hub doc', cmd: ['bash', path.basename(workspace) + '/doc.sh'] }], apps: [], pages: [] }));
    await writeFile(path.join(workspace, 'doc.sh'), 'echo'); // the command's path must exist above the workspace (S2)
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
    await mkdir(path.join(workspace, 'work/_owner'));
    await writeFile(path.join(workspace, 'work/_owner/AGENTS.md'), '# Waiting on me\n');
    return {};
  });
  const file = settingsPath(instance.directory), old = await readFile(file, 'utf8'), before = (await readdir(instance.workspace)).sort();
  const s = (await call(instance, '/setup')).body;
  // The workspace sits inside a bigger folder the registry's commands are written from: proposed, editable.
  const found = { hub, registry: hub + '/registry.json', waiting: 'work/_owner', scripts_root: path.dirname(instance.workspace) };
  assert.deepEqual([s.conflict, s.found, s.proposed, s.creates], [true, found, { ...STARTER, page_schemes: ['obsidian'], ...found }, []]);
  assert.equal((await call(instance, '/setup/starter', 'POST', {})).status, 409, 'no paths: still refused');
  assert.equal((await call(instance, '/setup/starter', 'POST', { ...STARTER, scripts_root: 'relative' })).status, 400, 'validated like first run');
  assert.equal(await readFile(file, 'utf8'), old);
  const chosen = { primary: 'AGENTS.md', registry: found.registry, waiting: found.waiting, hub, scripts_root: found.scripts_root };
  const made = await call(instance, '/setup/starter', 'POST', chosen);
  assert.deepEqual([made.status, made.body.created], [201, [file]]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...chosen, page_schemes: ['obsidian'] });
  assert.equal(await readFile(file + '.bak', 'utf8'), old);
  assert.deepEqual((await readdir(instance.workspace)).sort(), before, 'no mission/ or needs-you/');
  const mission = await call(instance, '/mission');
  assert.deepEqual([mission.status, mission.body.scripts.map((x) => x.id)], [200, ['hubdoc']]);
  assert.equal((await call(instance, '/setup/starter', 'POST', chosen)).status, 409, 'settings now fit: no second overwrite');
  console.log('PASS starter: confirmed paths replace the settings, keep a .bak and other keys, create nothing else, and Mission lists the hub');
});

test('Setup wizard: scripts_root is proposed only when a local hub registry command starts with the workspace folder name and that path exists above it (S2, threat model row 37)', { timeout: 60000 }, async (t) => {
  const hub = 'work/workspace-hub';
  // ssh: an ssh record's paths name the other machine. missing: the path is not there above the workspace.
  for (const [kind, expected] of [['local', true], ['elsewhere', false], ['ssh', false], ['missing', false]]) {
    const instance = await daemon(t, undefined, false, async ({ workspace }) => {
      await mkdir(path.join(workspace, hub), { recursive: true });
      const start = kind === 'elsewhere' ? 'elsewhere' : path.basename(workspace);
      const cmd = kind === 'ssh' ? ['ssh', 'box', 'bash', start + '/a.sh'] : ['bash', start + '/a.sh'];
      await writeFile(path.join(workspace, hub, 'registry.json'), JSON.stringify({ scripts: [{ id: 'a', title: 'A', cmd }], apps: [], pages: [] }));
      if (kind !== 'missing') await writeFile(path.join(workspace, 'a.sh'), 'echo');
      await writeFile(path.join(workspace, 'AGENTS.md'), 'mine');
      return {};
    });
    const s = (await call(instance, '/setup')).body;
    assert.equal(s.found.scripts_root, expected ? path.dirname(instance.workspace) : undefined, kind);
    assert.equal(s.proposed.scripts_root, expected ? path.dirname(instance.workspace) : undefined, kind);
    if (expected) {
      const made = await call(instance, '/setup/starter', 'POST', s.proposed);
      assert.equal(made.status, 201);
      assert.equal(JSON.parse(await readFile(settingsPath(instance.directory), 'utf8')).scripts_root, path.dirname(instance.workspace));
    }
  }
  console.log('PASS starter: scripts_root is proposed for a local registry written from the workspace parent, and not for ssh, missing or foreign paths');
});

test('Setup wizard: a workspace with nested AGENTS.md, a registry.json and a _waiting folder but no workspace-hub is found as it is (D6, threat model row 55)', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    await mkdir(path.join(workspace, 'Work/_waiting'), { recursive: true });
    await mkdir(path.join(workspace, 'Work/tools'), { recursive: true });
    await writeFile(path.join(workspace, 'Work/AGENTS.md'), '# Workspace\n');
    await writeFile(path.join(workspace, 'Work/tools/registry.json'), JSON.stringify({ scripts: [{ id: 'a', title: 'A', cmd: ['bash', 'a.sh'] }], apps: [], pages: [] }));
    await writeFile(path.join(workspace, 'Work/tools/other.json'), '{}');
    await mkdir(path.join(workspace, 'Work/deep/er/est/registry'), { recursive: true });
    await writeFile(path.join(workspace, 'notes.txt'), 'x');
    return {};
  });
  const s = (await call(instance, '/setup')).body;
  assert.deepEqual([s.found.primary, s.found.registry, s.found.waiting], ['Work/AGENTS.md', 'Work/tools/registry.json', 'Work/_waiting']);
  assert.deepEqual([s.proposed.primary, s.proposed.registry, s.proposed.waiting], ['Work/AGENTS.md', 'Work/tools/registry.json', 'Work/_waiting']);
  assert.deepEqual(s.creates, [], 'nothing to create: it uses what is there');
  // A registry.json that is not a registry (no scripts, apps or pages list) is not taken.
  const other = await daemon(t, undefined, false, async ({ workspace }) => {
    await mkdir(path.join(workspace, 'cfg'), { recursive: true });
    await writeFile(path.join(workspace, 'cfg/registry.json'), JSON.stringify({ name: 'npm', version: 1 }));
    return {};
  });
  assert.equal((await call(other, '/setup')).body.found.registry, undefined);
  console.log('PASS detect: nested AGENTS.md, a registry.json and a _waiting folder are found; a registry.json that is not one is ignored');
});

test('Setup wizard: a top-level waiting-on folder is found; with no Main project line the top AGENTS.md is primary', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async ({ workspace }) => {
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Top\n');
    await mkdir(path.join(workspace, 'sub'));
    await writeFile(path.join(workspace, 'sub/AGENTS.md'), '# Sub\n');
    await mkdir(path.join(workspace, '_owner'));
    await writeFile(path.join(workspace, '_owner/AGENTS.md'), '# What is waiting on the owner\n');
    return {};
  });
  const s = (await call(instance, '/setup')).body;
  assert.deepEqual([s.found.primary, s.found.waiting], ['AGENTS.md', '_owner']);
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

test('Setup wizard sign-in: the daemon runs only the fixed login of the bundled CLI; the code goes to its stdin only (threat model row 31)', { timeout: 60000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const at = (name) => path.join(instance.workspace, name);
  for (const body of [{ agent: 'x' }, { agent: 'claude', args: ['--evil'] }, { agent: ['claude'] }, {}]) assert.equal((await call(instance, '/setup/login', 'POST', body)).status, 400, JSON.stringify(body));
  assert.equal((await call(instance, '/setup/login', 'POST', { agent: 'claude' })).status, 202);
  assert.equal((await call(instance, '/setup/login', 'POST', { agent: 'claude' })).body.error, 'login-running', 'one login per agent');
  const state = await until(async () => { const s = (await call(instance, '/setup/login')).body; return s.claude.url && s; }, 'the CLI URL');
  assert.deepEqual(state, { claude: { running: true, url: 'https://claude.com/cai/oauth/authorize?fake=1', exit: null }, codex: { running: false, url: null, exit: null } });
  assert.deepEqual(JSON.parse(await readFile(at('fake-login-argv'), 'utf8')), ['claude', '--cli', 'auth', 'login', '--claudeai']);
  // At most 512 printable characters, one line: never a second line, a second command or an argument.
  for (const code of ['a\nwhoami', 'a\rb', 'x'.repeat(513), '', 7]) assert.equal((await call(instance, '/setup/login/code', 'POST', { agent: 'claude', code })).status, 400, JSON.stringify(code));
  assert.equal((await call(instance, '/setup/login/code', 'POST', { agent: 'claude', code: 'abc#123 $(id)' })).status, 202);
  assert.equal(await until(() => readFile(at('fake-login-code'), 'utf8').catch(() => ''), 'the code'), '"abc#123 $(id)"\n');
  assert.equal((await call(instance, '/setup/login/stop', 'POST', { agent: 'claude' })).status, 200);
  assert.equal((await call(instance, '/setup/login')).body.claude.running, false);
  assert.equal((await call(instance, '/setup/login/code', 'POST', { agent: 'claude', code: 'late' })).body.error, 'login-not-running');
  // A login that finishes on its own reports its exit code; a new one may start after.
  assert.equal((await call(instance, '/setup/login', 'POST', { agent: 'claude' })).status, 202);
  await until(async () => (await call(instance, '/setup/login')).body.claude.url, 'the second URL');
  await call(instance, '/setup/login/code', 'POST', { agent: 'claude', code: 'done' });
  assert.equal(await until(async () => { const s = (await call(instance, '/setup/login')).body.claude; return s.exit !== null && String(s.exit); }, 'the exit'), '0');
  assert.equal((await call(instance, '/setup/login', 'POST', { agent: 'codex' })).status, 202);
  await until(() => readFile(at('fake-login-argv'), 'utf8').then((text) => JSON.parse(text)[0] === 'codex').catch(() => false), 'the codex start'); // the fake's writeFileSync can be read mid-write
  assert.deepEqual(JSON.parse(await readFile(at('fake-login-argv'), 'utf8')), ['codex', 'cli', 'login']);
});

test('Setup wizard sign-in: main opens only the vendor sign-in page, by parsed origin, and the page never sees the URL (threat model row 31)', { skip: process.platform === 'win32', timeout: 120000 }, async (t) => {
  const instance = await daemon(t, undefined, false, async () => ({ args: ['--acp-override', fake] }));
  const home = await mkdtemp(path.join(os.tmpdir(), 'p9-login-')), opened = path.join(home, 'opened.txt'), browser = path.join(home, 'browser');
  await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + opened + '\n');
  await chmod(browser, 0o755);
  const env = { ...process.env, P9_OPEN_URL: browser }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  const login = (...args) => page.evaluate((a) => window.p9.agentLogin(...a).then((r) => r, (e) => ({ thrown: e.message })), args);
  for (const args of [['start', 'x'], ['start', 'claude', 'extra'], ['code', 'claude'], ['state', 'claude'], ['start', ['claude']], ['run', 'claude']]) assert.match((await login(...args)).thrown ?? '', /ipc-sender-refused/, JSON.stringify(args));
  const tryUrl = async (agent, url) => {
    await writeFile(path.join(instance.workspace, 'fake-login-url'), url);
    assert.equal((await login('start', agent)).status, 202);
    await until(async () => (await call(instance, '/setup/login')).body[agent].url === url, url);
    const state = await login('state');
    assert.ok(!JSON.stringify(state).includes('http'), 'the page never gets the URL');
    const result = await login('open', agent);
    await login('stop', agent);
    return [state.body[agent].url, result.status];
  };
  for (const url of ['https://claude.com.evil.example/', 'https://claude.com@evil.example/', 'https://evil.example/?https://claude.com', 'https://claude.ai:8443/']) assert.deepEqual(await tryUrl('claude', url), [false, 409], url);
  assert.deepEqual(await tryUrl('codex', 'https://claude.com/cai/oauth'), [false, 409], 'each agent opens only its own vendor');
  assert.equal(await readFile(opened, 'utf8').catch(() => ''), '', 'nothing opened');
  for (const url of ['https://claude.com/cai/oauth/authorize?a=1', 'https://console.anthropic.com/oauth', 'https://claude.ai/x']) assert.deepEqual(await tryUrl('claude', url), [true, 200], url);
  assert.deepEqual(await tryUrl('codex', 'https://auth.openai.com/oauth/authorize?b=2'), [true, 200]);
  await until(async () => (await readFile(opened, 'utf8').catch(() => '')).split('\n').length === 5, 'four opens');
  assert.deepEqual((await readFile(opened, 'utf8')).trim().split('\n'),
    ['https://claude.com/cai/oauth/authorize?a=1', 'https://console.anthropic.com/oauth', 'https://claude.ai/x', 'https://auth.openai.com/oauth/authorize?b=2']);
});

// A stand-in systemctl that runs the unit's ExecStart for real (so install-service.mjs's health wait and Stop All talk to a real
// daemon) and never touches the machine's own user units. A workspace named "refused" is a unit that does not start.
const SYSTEMCTL = String.raw`
import { readFileSync, writeFileSync, rmSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const [, , , command, ...rest] = process.argv, unit = rest.at(-1), pid = path.join(process.env.HOME, unit + '.pid');
if (command === 'enable') {
  const line = readFileSync(path.join(process.env.HOME, '.config/systemd/user', unit), 'utf8').match(/^ExecStart=(.*)$/m)[1];
  const argv = [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1').replaceAll('%%', '%')
    : m[2].replace('%t', process.env.XDG_RUNTIME_DIR));
  if (path.basename(argv[argv.indexOf('--workspace') + 1]) === 'refused') process.exit(1);
  const log = openSync(path.join(process.env.HOME, 'daemon.log'), 'a');
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', log, log] });
  writeFileSync(pid, String(child.pid)); child.unref();
} else if (command === 'disable') {
  try {
    const id = Number(readFileSync(pid, 'utf8')), end = Date.now() + 10000;
    process.kill(id);
    while (true) { try { process.kill(id, Date.now() > end ? 'SIGKILL' : 0); } catch { break; } }
  } catch {}
  // RuntimeDirectory=: systemd removes the daemon's state folder when the unit stops.
  rmSync(pid, { force: true }); rmSync(path.join(process.env.XDG_RUNTIME_DIR, 'p9-foundation'), { recursive: true, force: true });
}
`;

test('Setup wizard workspace change: only through the picker, never home or P9 state; the unit differs only in --workspace and a folder that does not start rolls back (threat model row 32)', { skip: process.platform !== 'linux', timeout: 180000 }, async (t) => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'p9-move-'))), bin = path.join(home, 'bin'), run = path.join(home, 'run');
  const [first, second, refused] = ['first', 'second', 'refused'].map((name) => path.join(home, name));
  for (const directory of [bin, first, second, refused]) await mkdir(directory);
  await mkdir(run, { mode: 0o700 });
  await writeFile(path.join(bin, 'systemctl'), '#!' + process.execPath + '\n' + SYSTEMCTL);
  await chmod(path.join(bin, 'systemctl'), 0o755);
  await writeFile(path.join(home, 'a-file'), '');
  const env = { ...process.env, HOME: home, XDG_RUNTIME_DIR: run, PATH: bin + ':' + process.env.PATH }; delete env.ELECTRON_RUN_AS_NODE;
  const installed = spawnSync(process.execPath, [path.join(root, 'scripts/install-service.mjs'), first], { env, encoding: 'utf8' });
  t.after(() => spawnSync(path.join(bin, 'systemctl'), ['--user', 'disable', '--now', 'p9-foundation.service'], { env }));
  assert.match(installed.stdout, /P9_SERVICE_INSTALLED/, installed.stderr);
  const state = path.join(run, 'p9-foundation'), unitFile = path.join(home, '.config/systemd/user/p9-foundation.service');
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', state, '--user-data-dir=' + path.join(home, 'profile')], env, chromiumSandbox: true, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  // The page passes nothing; main's own pickers answer here (the folder picked, then the confirm's button).
  const change = async (folder, button = 1) => {
    await app.evaluate(({ dialog }, [folder, button]) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = async () => ({ response: button });
    }, [folder, button]);
    return page.evaluate(() => window.p9.workspaceChange());
  };
  const before = await readFile(unitFile, 'utf8');
  for (const folder of [home, path.join(home, '.local'), path.join(home, '.local/state/p9-foundation'), path.join(home, '.local/state/p9-foundation/conflicts'),
    state, run, '/', path.join(home, 'a-file')]) assert.deepEqual(await change(folder), { error: 'workspace-refused', workspace: first }, folder);
  assert.deepEqual(await change(second, 0), { workspace: first }, 'Cancel in the confirm changes nothing');
  assert.equal(await readFile(unitFile, 'utf8'), before);
  assert.deepEqual(await change(second), { workspace: second });
  const moved = await readFile(unitFile, 'utf8');
  assert.equal(moved, before.replace('"' + first + '"', '"' + second + '"'), 'only --workspace changed');
  assert.equal((await health(state)).workspace, second);
  const back = await change(refused);
  assert.equal(back.error, 'workspace-not-started');
  assert.equal(back.workspace, second, 'rolled back to the folder it was on');
  assert.equal(await readFile(unitFile, 'utf8'), moved);
  assert.equal((await health(state)).workspace, second);
});
