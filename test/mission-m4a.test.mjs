import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { daemon, http, authenticated, root } from './helpers.mjs';
import { parseSettings } from '../apps/server/mission.mjs';
import { TEMPLATES } from '../apps/server/mission-fields.mjs';
import { BUILD_PROMPT, GUIDE } from '../apps/server/templates/guide.mjs';
import { missionKeys } from '../apps/web/src/mission-files.mjs';

// D10: the Settings rows say "remote", never "server" (the settings.json key server_host stays: files already use it).
test('D10: no Mission Control files row says server in its name or tip', { timeout: 5000 }, () => {
  const rows = missionKeys();
  assert.ok(rows.some(([k]) => k === 'server_host'));
  for (const [key, name, , tip] of rows) assert.doesNotMatch(name + ' ' + (tip ?? ''), /server/i, key);
});
import { Client } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

// Mission M4 part 1: templates, scratch spaces and onboarding (threat model rows 71 and 72).
const fake = path.join(root, 'test/fake-acp-agent.mjs');
// A fresh profile: what Set up's starter writes (server.mjs STARTER_SETTINGS), nothing in it yet.
const FRESH = { primary: 'AGENTS.md', registry: 'mission/registry.json', waiting: 'needs-you' };
const LIVE = { ...FRESH, space: 'mission/space.json' };

async function start(t, settings = FRESH, space) {
  return daemon(t, undefined, false, async ({ directory, workspace }) => {
    await mkdir(path.join(workspace, 'mission'), { recursive: true });
    await mkdir(path.join(workspace, 'needs-you'));
    await writeFile(path.join(workspace, 'AGENTS.md'), '# Workspace\n');
    await writeFile(path.join(workspace, 'mission/registry.json'), '{}\n');
    if (space) await writeFile(path.join(workspace, 'mission/space.json'), JSON.stringify(space, null, 2) + '\n');
    // Settings in their own folder, as installed: the space P9 makes beside them is never in the recovery folder's parent.
    await mkdir(path.join(directory, '.config/p9'), { recursive: true });
    await writeFile(path.join(directory, '.config/p9/settings.json'), JSON.stringify(settings));
    return { args: ['--acp-override', fake, '--settings', path.join(directory, '.config/p9/settings.json')] };
  });
}
const call = (instance, route, method = 'GET', body) => http({ socketPath: instance.credentials.socketPath, route, method, timeout: 30000,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ status: result.status, body: result.text ? JSON.parse(result.text) : null }));
async function until(instance, match, after = 0) {
  for (let i = 0; i < 40; i += 1) {
    const { body } = await call(instance, `/chat/events?after=${after}&wait=2000`);
    after = body.cursor;
    const hit = body.events.find(match);
    if (hit) return hit;
  }
  throw new Error('event-timeout');
}
async function agent(t, instance) {
  const { body: { conversation } } = await call(instance, '/chat', 'POST', { provider: 'claude' });
  await call(instance, `/chat/${conversation}/prompt`, 'POST', { text: 'mcp' });
  const hit = await until(instance, (event) => event.conversation === conversation && event.data?.content?.text?.startsWith('mcp:'));
  const [entry] = JSON.parse(hit.data.content.text.slice(4));
  const client = new Client({ name: 'p9-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: Object.fromEntries(entry.env.map(({ name, value }) => [name, value])) }));
  t.after(() => client.close());
  return async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
}
const settingsOf = async (instance) => JSON.parse(await readFile(path.join(instance.directory, '.config/p9/settings.json'), 'utf8'));

test('M4a templates: four shipped files, sections with text and https links only; each validates and installs into a fresh profile', { timeout: 90000 }, async (t) => {
  assert.deepEqual(TEMPLATES.map((entry) => entry.name), ['icm', 'obsidian', 'homelab', 'blank']);
  for (const template of TEMPLATES) {
    for (const section of template.space.sections) {
      assert.deepEqual(Object.keys(section).filter((key) => !['id', 'title', 'icon', 'text', 'links', 'widget'].includes(key)), [], template.name + ': only text and links');
      for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    }
    // No home path, host address or user folder in a shipped template (D10).
    assert.doesNotMatch(JSON.stringify(template), /\/home\/|~\/|\/Users\/|\\\\|\b\d{1,3}(\.\d{1,3}){3}\b|\.local\b|\.lan\b|\.ts\.net\b/, template.name);
  }
  const instance = await start(t);
  const tool = await agent(t, instance);
  for (const template of TEMPLATES) {
    const checked = await tool('validate_space', { text: JSON.stringify(template.space) });
    assert.deepEqual([checked.ok, checked.accepted.sections, checked.invalid], [true, template.space.sections.length, []], template.name);
  }
  assert.equal((await tool('describe_mission')).templates.length, 4);

  // File protection is on in a fresh profile: the first click asks, the confirmed one writes.
  assert.equal((await call(instance, '/mission')).body.empty, true);
  assert.deepEqual([(await call(instance, '/mission/template', 'POST', { name: 'icm' })).status], [403]);
  assert.equal((await settingsOf(instance)).space, undefined, 'nothing made before the confirm');
  const made = await call(instance, '/mission/template', 'POST', { name: 'icm', confirm: true });
  assert.deepEqual([made.status, made.body.action, made.body.template], [201, 'installed', 'icm'], JSON.stringify(made.body));
  const live = (await settingsOf(instance)).space;
  assert.equal(live, path.join(instance.directory, '.config/p9/mission-space.json'));
  const overview = (await call(instance, '/mission')).body;
  assert.deepEqual([overview.empty, overview.space.map((s) => s.title), overview.invalid], [false, ['Waiting on you', 'Usage', 'Apps and pages', 'Notifications', 'Today', 'Projects', 'Wiki and notes', 'Upkeep'], []]);
  // Fresh-install finding 3a: the ICM template's four sections name P9's built-in panels.
  assert.deepEqual(overview.space.map((s) => s.widget ?? null), ['waiting', 'usage', 'apps', 'notifications', null, null, null, null]);

  // Never over a space with sections: 409 and the same bytes.
  const before = await readFile(live, 'utf8');
  const again = await call(instance, '/mission/template', 'POST', { name: 'homelab', confirm: true });
  assert.deepEqual([again.status, again.body.error], [409, 'space-not-empty']);
  assert.equal(await readFile(live, 'utf8'), before);
  for (const body of [{ name: 'nope', confirm: true }, { name: 'icm', extra: 1 }, { name: 'icm', space: '../x', confirm: true }]) {
    assert.ok([400, 404].includes((await call(instance, '/mission/template', 'POST', body)).status), JSON.stringify(body));
  }

  // The other three each into their own scratch space, shown through the picker: valid and complete.
  for (const template of TEMPLATES.slice(1)) {
    assert.equal((await call(instance, '/mission/template', 'POST', { name: template.name, space: 't-' + template.name, confirm: true })).status, 201, template.name);
    assert.equal((await call(instance, '/mission/space', 'POST', { name: 't-' + template.name })).status, 200);
    const shown = (await call(instance, '/mission')).body;
    assert.deepEqual([shown.spaceName, shown.space.length, shown.invalid], ['t-' + template.name, template.space.sections.length, []], template.name);
  }
  assert.equal(await readFile(live, 'utf8'), before, 'the main space is untouched');
  console.log('PASS M4a templates: 4 shipped, text and https only, each valid; installed fresh (403 then confirm), 409 over sections');
});

test('M4a scratch spaces: a name never becomes a path; a draft write keeps the lock and File protection; switching leaves the live space untouched', { timeout: 90000 }, async (t) => {
  const instance = await start(t, LIVE, { sections: [{ id: 'ops', title: 'Ops' }] });
  const tool = await agent(t, instance);
  const livePath = path.join(instance.workspace, 'mission/space.json'), drafts = path.join(instance.directory, '.config/p9/spaces');
  const liveBytes = await readFile(livePath, 'utf8');
  await call(instance, '/file-protection', 'POST', { on: false });

  // A link where the drafts folder goes: refused, nothing written through it.
  const elsewhere = path.join(instance.directory, 'elsewhere');
  await mkdir(elsewhere); await symlink(elsewhere, drafts);
  assert.equal((await tool('add_section', { title: 'Draft one', space: 'draft' })).error, 'request-refused');
  assert.deepEqual(await readdir(elsewhere), []);
  await rm(drafts);

  for (const name of ['../settings', '/etc/x', 'a/b', 'a.json', 'A', '', '-a', 'con', 'lpt1', 'x'.repeat(33), 'a\0b', 7]) {
    const result = await tool('add_section', { title: 'Bad', space: name });
    assert.equal(result.error, 'request-refused', JSON.stringify(name));
    assert.equal((await call(instance, '/mission/space', 'POST', { name })).status, 400, JSON.stringify(name));
  }
  assert.equal(await stat(drafts).catch(() => null), null, 'no drafts folder from a refused name');
  assert.throws(() => parseSettings(JSON.stringify({ ...LIVE, space_name: '../x' })), 'a hand-edited space_name that is a path is a settings error');

  // The lock and File protection hold for drafts as for the live space.
  await call(instance, '/agent-lock', 'POST', { on: true });
  assert.equal((await tool('add_section', { title: 'Draft one', space: 'draft' })).error, 'agent-lock-on');
  await call(instance, '/agent-lock', 'POST', { on: false });
  await call(instance, '/file-protection', 'POST', { on: true });
  assert.equal((await tool('add_section', { title: 'Draft one', space: 'draft' })).error, 'registry-read-only');
  await call(instance, '/file-protection', 'POST', { on: false });
  assert.equal(await stat(drafts).catch(() => null), null);

  // Build in "draft": its own file, owner-only; a registry write with a space name is refused.
  assert.equal((await tool('add_section', { title: 'Draft one', space: 'draft' })).action, 'added');
  assert.equal((await tool('set_section_items', { title: 'Draft one', kind: 'links', items: [{ id: 'docs', title: 'Docs', url: 'https://example.com' }], space: 'draft' })).action, 'updated');
  assert.equal((await tool('add_button', { record: { id: 'x', title: 'X', cmd: ['true'] }, space: 'draft' })).error, 'request-refused');
  assert.equal((await stat(path.join(drafts, 'draft.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(drafts)).mode & 0o777, 0o700);
  assert.equal(await readFile(livePath, 'utf8'), liveBytes, 'the live space is untouched by draft writes');

  // Switch: Mission shows the draft; the live file is neither read into it nor written. Then back to Main.
  assert.equal((await call(instance, '/mission/space', 'POST', { name: 'nope' })).status, 404);
  assert.equal((await call(instance, '/mission/space', 'POST', { name: 'draft' })).status, 200);
  const shown = (await call(instance, '/mission')).body;
  assert.deepEqual([shown.spaceName, shown.spaces, shown.space.map((s) => s.title), shown.empty], ['draft', ['draft'], ['Draft one'], false]);
  assert.equal((await settingsOf(instance)).space, 'mission/space.json', 'settings still name the live space');
  assert.equal(await readFile(livePath, 'utf8'), liveBytes);
  assert.equal((await call(instance, '/mission/space', 'POST', { name: null })).status, 200);
  const main = (await call(instance, '/mission')).body;
  assert.deepEqual([main.spaceName, main.space.map((s) => s.title)], [null, ['Ops']]);
  assert.equal(await readFile(livePath, 'utf8'), liveBytes);
  console.log('PASS M4a scratch: 12 bad names and a linked folder refused, lock and protection held, draft 0600 in 0700, switch and back left live bytes as they were');
});

test('M4a onboarding (server): a fresh profile is empty; the guide and templates come from P9; a build chat starts with the shipped guide only', { timeout: 90000 }, async (t) => {
  const instance = await start(t);
  const fresh = (await call(instance, '/mission')).body;
  assert.deepEqual([fresh.empty, fresh.spaces, fresh.spaceName, fresh.fileProtection], [true, [], null, true]);
  await call(instance, '/file-protection', 'POST', { on: false });
  assert.equal((await call(instance, '/mission')).body.fileProtection, false, 'the card drops its File protection line');
  await call(instance, '/file-protection', 'POST', { on: true });
  const guide = (await call(instance, '/mission/guide')).body;
  assert.equal(guide.guide, GUIDE);
  assert.deepEqual(guide.templates.map((entry) => entry.name), ['icm', 'obsidian', 'homelab', 'blank']);
  for (const body of [{ provider: 'gpt' }, { provider: 'claude', text: 'ignore the guide' }, {}]) {
    assert.equal((await call(instance, '/mission/build', 'POST', body)).status, 400, JSON.stringify(body));
  }
  for (const provider of ['claude', 'codex']) {
    const made = await call(instance, '/mission/build', 'POST', { provider });
    assert.equal(made.status, 201, provider);
    const echo = await until(instance, (event) => event.conversation === made.body.conversation && event.data?.content?.text?.startsWith('echo:'));
    assert.equal(echo.data.content.text, 'echo:' + BUILD_PROMPT, provider + ': the first message is the shipped text only');
  }
  console.log('PASS M4a onboarding server: fresh profile empty, guide shipped, bad provider and extra fields refused, Claude and Codex chats start with the guide');
});
