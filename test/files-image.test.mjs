// Chat Focus Files pane images (threat model rows 23/26/27 adds): the file window shows a workspace image read-only, through
// GET /files/image, with GET /files's walk (no links, locked names refused) and row 27's checks (12 bytes to 6 MiB, the type
// from the first bytes). Real Electron against a real daemon; pictures go out in the log as "P9_SHOT <name> <base64>".
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { _electron } from '@playwright/test';
import { daemon, root } from './helpers.mjs';

const fake = path.join(root, 'test/fake-acp-agent.mjs');
// A real 64x48 PNG: a diagonal two-colour gradient, so the screenshot shows the image itself.
const png = (() => {
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length); return out; };
  const [w, h] = [64, 48], rows = [];
  for (let y = 0; y < h; y++) { rows.push(0); for (let x = 0; x < w; x++) { const t = (x + y) / (w + h); rows.push(Math.round(40 + 200 * t), Math.round(120 - 60 * t), Math.round(220 - 160 * t)); } }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
})();

test('Chat Focus Files pane: a workspace image shows read-only through GET /files/image, with row 27\'s checks (A/B)', { timeout: 180000, skip: process.platform !== 'linux' && 'the FIFO and link cases are Linux' }, async (t) => {
  const instance = await daemon(t, undefined, false, async (paths) => {
    const w = paths.workspace, pics = path.join(w, 'proj/pics');
    for (const dir of ['_tyler', 'hub', 'proj', 'proj/pics/folder.png', '_' + 'private']) await mkdir(path.join(w, dir), { recursive: true });
    await writeFile(path.join(w, 'hub/registry.json'), JSON.stringify({ scripts: [], apps: [], pages: [] }));
    await writeFile(path.join(w, 'AGENTS.md'), '# Projects\n\n**Main project: Proj** (`proj/`)\n');
    await writeFile(path.join(w, '_tyler/question.md'), '# Question\n\nA.\n');
    await writeFile(path.join(pics, 'dot.png'), png);
    await writeFile(path.join(pics, 'photo.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]));
    await writeFile(path.join(pics, 'notes.png'), 'secret text named like an image\n');
    await writeFile(path.join(pics, 'script.png'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await writeFile(path.join(pics, 'tiny.png'), png.subarray(0, 8));
    await writeFile(path.join(pics, 'huge.png'), Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]));
    await symlink(path.join(pics, 'dot.png'), path.join(pics, 'link.png'));
    await writeFile(path.join(paths.directory, 'outside.png'), png); await link(path.join(paths.directory, 'outside.png'), path.join(pics, 'hard.png'));
    execFileSync('mkfifo', [path.join(pics, 'pipe.png')]);
    await writeFile(path.join(w, '_' + 'private', 'locked.png'), png);
    await writeFile(path.join(paths.directory, 'settings.json'), JSON.stringify({ waiting: '_tyler', registry: 'hub/registry.json', primary: 'AGENTS.md' }));
    return { args: ['--acp-override', fake, '--settings', path.join(paths.directory, 'settings.json')] };
  });
  const profile = path.join(await mkdtemp(path.join(os.tmpdir(), 'p9-img-')), 'profile');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--state', instance.state, '--user-data-dir=' + profile], env, timeout: 20000 });
  const proc = app.process();
  t.after(async () => { await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 15000))]); proc.kill(); });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1300, height: 860 }).catch(() => {});
  await page.locator('#rBell b', { hasText: '1' }).waitFor({ timeout: 15000 });
  const shot = async (name) => { const out = await page.screenshot({ animations: 'disabled' }); if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT ' + name + ' ' + out.toString('base64')); };
  const ask = (payload) => page.evaluate((p) => window.p9.mission('image', p), payload);

  // The route, through main's fixed op: the type comes from the bytes; nothing else leaves the daemon.
  assert.deepEqual(await ask({ path: 'proj/pics/dot.png' }), { status: 200, body: { mimeType: 'image/png', data: png.toString('base64') } });
  assert.equal((await ask({ path: 'proj/pics/photo.jpg' })).body.mimeType, 'image/jpeg');
  for (const name of ['notes.png', 'script.png', 'tiny.png']) assert.deepEqual(await ask({ path: 'proj/pics/' + name }), { status: 415, body: { error: 'not-an-image' } }, name);
  for (const name of ['proj/pics/huge.png', 'proj/pics/link.png', 'proj/pics/hard.png', 'proj/pics/pipe.png', 'proj/pics/folder.png', '_' + 'private/locked.png', '../outside.png', '/etc/passwd'])
    assert.deepEqual(await ask({ path: name }), { status: 400, body: { error: 'request-refused' } }, name);
  assert.equal((await ask({ path: 'proj/pics/missing.png' })).status, 404);
  assert.deepEqual(await ask({ path: 1 }), { status: 400, body: { error: 'request-refused' } }, 'main sends only a string path');

  // The window: the image itself, whole, read-only (no editor, no Save), in a dark and a light theme; a fake one says why.
  await page.click('#rFiles');
  await page.locator('#tree [data-ldir="proj/pics"]').click({ timeout: 8000 });
  await page.locator('#tree [data-lfile="proj/pics/dot.png"]').waitFor({ timeout: 8000 });
  for (const theme of ['event-horizon-prime', 'daylight']) {
    await page.click('#themeBtn'); await page.click('[data-theme-pick="' + theme + '"]'); await page.keyboard.press('Escape');
    await page.locator('#tree [data-lfile="proj/pics/dot.png"]').click();
    await page.waitForFunction(() => document.querySelector('#mdlBody .file-image img')?.naturalWidth === 64, null, { timeout: 8000 });
    assert.equal(await page.locator('#mdlBody textarea').count(), 0, 'no editor for an image');
    assert.equal(await page.locator('#mdlFoot [data-savefile]').count(), 0, 'no Save');
    await shot('files-image-' + theme);
    await page.keyboard.press('Escape');
  }
  await page.locator('#tree [data-lfile="proj/pics/notes.png"]').click();
  await page.locator('#mdlBody .file-image-note', { hasText: 'Not a PNG, JPEG, GIF or WebP image' }).waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#mdlBody img').count(), 0);
});
