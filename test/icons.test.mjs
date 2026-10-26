// Real icons on Mission tiles: a link's own site icon, a program's icon, the user's picture. Local servers stand in for the sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, readdir, symlink, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { daemon, http as request, authenticated, root } from './helpers.mjs';
import { createIcons, programIcon, sniff, privateAddress, SITE_MAX } from '../apps/server/icons.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
const SETTINGS = { primary: 'projects/AGENTS.md', registry: 'hub/registry.json', waiting: '_waiting', space: 'hub/space.json' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const png = (tag) => Buffer.concat([PNG, Buffer.from(tag)]); // a different valid-looking image per tag
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
const uri = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;

// A "site": routes is {path: [status, headers, body]}; log collects every request it got.
async function site(t, routes, log = []) {
  const server = http.createServer((req, res) => {
    log.push({ port: server.address().port, url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    const [status, headers, body] = routes[req.url.split('?')[0]] ?? [404, {}, 'no'];
    res.writeHead(status, headers); res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const html = (links) => [200, { 'content-type': 'text/html' }, `<!doctype html><html><head><title>x</title>${links}</head><body></body></html>`];

async function start(t, pages) {
  return daemon(t, undefined, false, async ({ directory, workspace }) => {
    for (const folder of ['projects', 'hub', '_waiting']) await mkdir(path.join(workspace, folder));
    await writeFile(path.join(workspace, 'projects/AGENTS.md'), '# Projects\n');
    await writeFile(path.join(workspace, SETTINGS.registry), JSON.stringify({ scripts: [], apps: [{ id: 'editor', title: 'Editor', cmd: ['true'] }], pages }, null, 2) + '\n');
    await writeFile(path.join(workspace, SETTINGS.space), JSON.stringify({ sections: [{ title: 'Ops', buttons: [] }] }, null, 2) + '\n');
    await writeFile(path.join(directory, 'settings.json'), JSON.stringify(SETTINGS));
    return { args: ['--acp-override', fake, '--settings', path.join(directory, 'settings.json')] };
  });
}
const call = (instance, route, method = 'GET', body) => request({ socketPath: instance.credentials.socketPath, route, method,
  headers: { ...authenticated(instance.credentials), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then((result) => ({ ...result, body: result.text ? JSON.parse(result.text) : null }));
const hash = (text) => createHash('sha256').update(text).digest('hex');

test('A link tile gets the site\'s own icon: the largest <link rel="icon">, else /favicon.ico; nothing else is asked', async (t) => {
  const log = [];
  const other = await site(t, { '/stolen.png': [200, { 'content-type': 'image/png' }, png('other')] }, log); // a different origin
  const small = png('small'), large = png('large');
  const a = await site(t, {
    '/': html(`<link rel="shortcut icon" href="/s.png" sizes="16x16"><link rel="icon" href="/l.png" sizes="64x64"><link rel="icon" href="${other}/stolen.png" sizes="512x512">`),
    '/s.png': [200, { 'content-type': 'image/png' }, small], '/l.png': [200, { 'content-type': 'image/png' }, large],
  }, log);
  const b = await site(t, { '/': html(''), '/favicon.ico': [200, { 'content-type': 'image/x-icon' }, ICO] }, log);
  const big = await site(t, { '/': html('<link rel="icon" href="/big.png">'), '/big.png': [200, {}, Buffer.concat([PNG, Buffer.alloc(SITE_MAX + 10)])] }, log);
  const hop = await site(t, { '/': html('<link rel="icon" href="/go.png">'), '/go.png': [302, { location: `${other}/stolen.png` }, ''], '/favicon.ico': [302, { location: 'file:///etc/passwd' }, ''] }, log);
  const svg = await site(t, { '/': html('<link rel="icon" type="image/svg+xml" href="/i.svg">'), '/i.svg': [200, { 'content-type': 'image/svg+xml' }, '<svg xmlns="http://www.w3.org/2000/svg"/>'] }, log);
  const instance = await start(t, [
    { id: 'a', title: 'A', url: a + '/' }, { id: 'b', title: 'B', url: b + '/' }, { id: 'big', title: 'Big', url: big + '/' },
    { id: 'hop', title: 'Hop', url: hop + '/' }, { id: 'svg', title: 'Svg', url: svg + '/' }, { id: 'texty', title: 'T', icon: 'T', url: a + '/' }]);
  const art = (await call(instance, '/mission/icons')).body;
  assert.equal(art.pages.a.auto, uri('image/png', large), 'the largest same-site icon link wins');
  assert.equal(art.pages.b.auto, uri('image/x-icon', ICO), '/favicon.ico when the page names no icon');
  for (const id of ['big', 'hop', 'svg']) assert.equal(art.pages[id]?.auto, undefined, id + ' is refused');
  assert.equal(art.pages.texty, undefined, 'a tile with a text icon is not fetched for');
  assert.ok(!log.some((entry) => entry.port === Number(new URL(other).port)), 'a cross-origin icon href or redirect (here a private address) is never requested');
  assert.ok(log.every((entry) => entry.cookie === undefined && entry.authorization === undefined), 'no cookies or credentials');
  assert.ok(!log.some((entry) => entry.url === '/etc/passwd'), 'a redirect to file: is not followed');
  const before = log.length;
  assert.deepEqual((await call(instance, '/mission/icons')).body.pages.a, art.pages.a);
  assert.equal(log.length, before, 'the second look is served from the cache on disk');
  console.log('PASS site icons: link rel (largest), /favicon.ico, oversized, redirect, svg and cross-origin refused, cached, no credentials');
});

test('Only http(s) links the user saved are fetched', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'icons-'));
  const asked = [];
  const icons = createIcons({ dir, workspace: dir, registry: () => 'hub/registry.json', discoverIcon: async (link) => { asked.push(link); return null; } });
  for (const link of ['file:///etc/passwd', 'ftp://x.example/', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'mailto:a@b.c', 'not a link'])
    assert.equal(await icons.site(link), null, link);
  assert.deepEqual(asked, [], 'nothing was fetched for a link that is not http(s)');
  assert.equal(privateAddress('10.1.2.3') && privateAddress('169.254.169.254') && privateAddress('::1') && privateAddress('fd00::1') && privateAddress('::ffff:127.0.0.1'), true);
  assert.equal(privateAddress('93.184.216.34'), false);
  console.log('PASS non-http links refused; private addresses recognized');
});

test('A picture saves through the guarded route, survives a reload, and Remove goes back to automatic', async (t) => {
  const instance = await start(t, [{ id: 'p', title: 'P', url: 'http://127.0.0.1:9/' }]);
  const state = (await call(instance, '/mission/edit')).body;
  const send = (picture, extra = {}) => call(instance, '/mission/edit', 'POST', { kind: 'pages', key: 'p', picture, hash: state.registry, ...extra });
  const icons = path.join(instance.workspace, 'hub/icons');
  const stored = async () => readdir(icons).catch(() => []);
  const data = png('mine').toString('base64');
  const asked = await send({ data });
  assert.deepEqual([asked.status, asked.body.error], [403, 'registry-read-only']);
  assert.deepEqual(await stored(), [], 'File protection asked first: nothing was written');
  const stale = await send({ data }, { confirm: true, hash: hash('stale') });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stored(), [], 'a stale hash writes no picture');
  for (const bad of [{ data: Buffer.from('plain text').toString('base64') }, { data: Buffer.concat([PNG, Buffer.alloc(256_000)]).toString('base64') }, { data: '!!!' }, { data, path: '/etc/passwd' }, 'http://x.example/i.png'])
    assert.equal((await send(bad, { confirm: true })).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.deepEqual(await stored(), [], 'a refused picture leaves no file');
  const saved = await send({ data }, { confirm: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const name = `${createHash('sha256').update(png('mine')).digest('hex').slice(0, 16)}.png`;
  assert.deepEqual(await stored(), [name]);
  assert.equal(JSON.parse(await readFile(path.join(instance.workspace, SETTINGS.registry), 'utf8')).pages[0].picture, name);
  assert.equal((await call(instance, '/mission')).body.pages[0].picture, name);
  assert.equal((await call(instance, '/mission/icons')).body.pages.p.picture, uri('image/png', png('mine')), 'the picture comes back after a reload');
  // The picture file replaced by a symlink to a file elsewhere is not served.
  const secret = path.join(instance.workspace, 'secret.png');
  await writeFile(secret, png('secret'));
  await unlink(path.join(icons, name)); await symlink(secret, path.join(icons, name));
  assert.equal((await call(instance, '/mission/icons')).body.pages.p?.picture, undefined, 'a symlinked picture is not read');
  await unlink(path.join(icons, name)); await writeFile(path.join(icons, name), png('mine'));
  const removed = await call(instance, '/mission/edit', 'POST', { kind: 'pages', key: 'p', picture: '', confirm: true, hash: saved.body.hash });
  assert.equal(removed.status, 200);
  assert.equal('picture' in JSON.parse(await readFile(path.join(instance.workspace, SETTINGS.registry), 'utf8')).pages[0], false);
  assert.equal((await call(instance, '/mission/icons')).body.pages.p?.picture, undefined);
  console.log('PASS picture: protection asked first, stale/bad/oversized refused with nothing stored, saved, reloaded, removed');
});

test('A picture is only ever a file P9 stored: a path or a link in the field is refused', async (t) => {
  const instance = await start(t, [{ id: 'p', title: 'P', url: 'http://127.0.0.1:9/' }]);
  await call(instance, '/file-protection', 'POST', { on: false });
  const current = (await call(instance, '/mission/edit')).body.registry;
  for (const picture of ['../../etc/passwd', '/etc/passwd', 'abc.png', 'http://x.example/a.png']) {
    const r = await call(instance, '/mission/edit', 'POST', { kind: 'pages', key: 'p', picture, hash: current, confirm: true });
    assert.equal(r.status, 400, picture);
  }
  assert.equal('picture' in JSON.parse(await readFile(path.join(instance.workspace, SETTINGS.registry), 'utf8')).pages[0], false);
  console.log('PASS picture names that are paths or links are refused');
});

test('A program\'s icon on Linux comes from its .desktop file, in the icon folders', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'xdg-'));
  await mkdir(path.join(data, 'applications'), { recursive: true });
  await mkdir(path.join(data, 'icons/hicolor/48x48/apps'), { recursive: true });
  await mkdir(path.join(data, 'icons/hicolor/256x256/apps'), { recursive: true });
  await writeFile(path.join(data, 'applications/code.desktop'), '[Desktop Entry]\nName=Code\nExec=/usr/share/code/code --unity-launch %F\nIcon=vscode\n');
  await writeFile(path.join(data, 'applications/evil.desktop'), '[Desktop Entry]\nName=Evil\nExec=evil\nIcon=../../../etc/passwd\n');
  await writeFile(path.join(data, 'icons/hicolor/48x48/apps/vscode.png'), png('48'));
  await writeFile(path.join(data, 'icons/hicolor/256x256/apps/vscode.png'), png('256'));
  const env = { XDG_DATA_HOME: data, XDG_DATA_DIRS: data };
  const found = await programIcon('/usr/bin/code', env);
  assert.deepEqual([found.ext, found.bytes.equals(png('256'))], ['png', true], 'the largest size');
  assert.equal(await programIcon('evil', env), null, 'an Icon that climbs out of the icon folders is not read');
  assert.equal(await programIcon('nothing', env), null);
  assert.equal(sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="x"/>')), 'svg');
  assert.equal(sniff(Buffer.from('<html><svg/></html>')), undefined);
  console.log('PASS program icon: .desktop Exec match, largest PNG, traversal and unknown programs give none');
});

test('A browser --app tile or an interpreter tile takes the site\'s icon or its letter, never the program\'s', async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'xdg-'));
  await mkdir(path.join(data, 'applications'), { recursive: true });
  await mkdir(path.join(data, 'icons/hicolor/48x48/apps'), { recursive: true });
  for (const [name, exec] of [['chrome', '/usr/bin/google-chrome-stable %U'], ['bash', 'bash'], ['python', 'python3.12']]) {
    await writeFile(path.join(data, `applications/${name}.desktop`), `[Desktop Entry]\nName=${name}\nExec=${exec}\nIcon=${name}\n`);
    await writeFile(path.join(data, `icons/hicolor/48x48/apps/${name}.png`), png(name));
  }
  const asked = [];
  const icons = createIcons({ dir: data, workspace: data, registry: () => 'hub/registry.json',
    discoverIcon: async (link) => { asked.push(link); return { ext: 'png', bytes: png(new URL(link).host) }; } });
  const apps = [
    { id: 'chat', cmd: ['google-chrome-stable', '--app=https://chat.example/'] },
    { id: 'calc', cmd: ['google-chrome-stable', '--app=file:///opt/calc/calc.html'] },
    { id: 'wave', cmd: ['bash', 'hub.sh', 'wave'] },
    { id: 'front', cmd: ['env', 'BROWSER=true', 'bash', 'run.sh'], url: 'http://front.example/' },
    { id: 'script', cmd: ['/usr/bin/python3.12', 'status.py'] },
    { id: 'chrome', cmd: ['google-chrome-stable'] },
  ];
  const art = await icons.collect({ pages: [], apps, sections: [] }, { platform: 'linux', env: { XDG_DATA_HOME: data, XDG_DATA_DIRS: data } });
  assert.deepEqual(Object.fromEntries(Object.entries(art.apps).map(([id, entry]) => [id, entry.auto])), {
    chat: uri('image/png', png('chat.example')), front: uri('image/png', png('front.example')), chrome: uri('image/png', png('chrome')) });
  assert.deepEqual(asked.sort(), ['http://front.example/', 'https://chat.example/']);
  const win = await icons.collect({ pages: [], apps, sections: [] }, { platform: 'win32' });
  assert.deepEqual(win.programs, [{ id: 'chrome', program: 'google-chrome-stable' }], 'Windows asks the OS only about real programs');
  console.log('PASS tile icons: --app=https uses the site icon, --app=file and bash/env/python give the letter tile or the named link, Chrome alone keeps its icon');
});
