// Real icons on Mission tiles: a link's own site icon (ME5), a program's icon (ME7) and the user's picture (ME6).
// The daemon does all of it; the renderer never loads a remote image, it gets data: URIs shown only through <img>
// (script in an SVG does not run there). Site icons are fetched from the site itself, never through a favicon service.
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { PICTURE } from './mission-fields.mjs';

export const SITE_MAX = 200_000;
export const PICTURE_MAX = 256_000;
const WEEK = 7 * 24 * 3600_000, DAY = 24 * 3600_000;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };

// What the bytes are, by their first bytes, never by a name or a Content-Type: png jpg webp ico svg, or undefined.
export function sniff(bytes) {
  const b = bytes;
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b[4] > 0) return 'ico';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(b.toString('utf8', 0, 2048).replace(/^﻿/, ''))) return 'svg';
}
const uri = (ext, bytes) => `data:${MIME[ext]};base64,${bytes.toString('base64')}`;

// Loopback, link-local, private, carrier-grade and multicast addresses: a site (not the user) must not aim the daemon at these.
export function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = address.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]);
  return v === '::' || v === '::1' || v.startsWith('::ffff:') || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

// One GET, no cookies or credentials, identity encoding, a short timeout, the body cut at limit (big says it was). publicOnly:
// the name must resolve to a public address, checked when the socket connects, so a name that changes its answer is caught too.
export function get(url, { publicOnly = false, limit, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) return reject(new Error('scheme'));
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (publicOnly && net.isIP(host) && privateAddress(host)) return reject(new Error('private-address'));
    const lookup = (name, options, done) => dns.lookup(name, options, (error, found, family) => {
      const addresses = Array.isArray(found) ? found.map((entry) => entry.address) : [found];
      if (!error && publicOnly && addresses.some(privateAddress)) return done(Object.assign(new Error('private-address'), { code: 'EPRIVATE' }));
      done(error, found, family);
    });
    const request = (target.protocol === 'https:' ? https : http).request(target, { method: 'GET', agent: false, lookup, timeout,
      headers: { 'user-agent': 'P9-icon', accept: 'text/html,image/*;q=0.8', 'accept-encoding': 'identity' } }, (response) => {
      const chunks = [];
      let size = 0, big = false;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= limit) chunks.push(chunk);
        else if (!big) { big = true; response.destroy(); }
      });
      const finish = () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), big });
      response.on('end', finish);
      response.on('close', finish);
      response.on('error', () => {});
    });
    const stop = setTimeout(() => request.destroy(new Error('timeout')), timeout * 2);
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => { clearTimeout(stop); reject(error); });
    request.on('close', () => clearTimeout(stop));
    request.end();
  });
}

// Follow up to 4 redirects, each only to http(s). A hop to another origin than the user's saved link is public-only.
async function follow(url, origin, limit) {
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await get(url, { publicOnly: new URL(url).origin !== origin, limit });
    const where = response.headers.location;
    if (response.status >= 300 && response.status < 400 && where) { url = new URL(where, url).href; continue; }
    return { ...response, url };
  }
  throw new Error('redirects');
}

const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));
// The icon links in a page head, the largest first: an apple-touch-icon, then the biggest declared size. SVG is skipped.
export function iconLinks(html, base) {
  const found = [];
  for (const [tag] of html.slice(0, html.search(/<\/head>/i) < 0 ? undefined : html.search(/<\/head>/i)).matchAll(/<link\b[^>]*>/gi)) {
    const attr = attributes(tag), rel = (attr.rel ?? '').toLowerCase().split(/\s+/);
    if (!attr.href || !(rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed'))) continue;
    if (/svg/i.test(attr.type ?? '') || /\.svg(\?|#|$)/i.test(attr.href)) continue;
    let href;
    try { href = new URL(attr.href, base); } catch { continue; }
    if (!/^https?:$/.test(href.protocol)) continue;
    const size = Math.max(0, ...(attr.sizes ?? '').split(/\s+/).map((part) => Number.parseInt(part, 10) || 0)) || (rel.some((r) => r.startsWith('apple')) ? 180 : 0);
    found.push({ href: href.href, size });
  }
  return found.sort((a, b) => b.size - a.size);
}

// The icon for a saved http(s) link: from the page's own icon links, else /favicon.ico, from the site itself. null when there is none.
export async function discover(link) {
  const origin = new URL(link).origin;
  const page = await follow(link, origin, 131_072).catch(() => null);
  const html = page && page.status === 200 && /html/i.test(page.headers['content-type'] ?? '') ? page.body.toString('utf8') : '';
  const urls = [...iconLinks(html, page?.url ?? link).map((entry) => entry.href), origin + '/favicon.ico'].filter((url, i, all) => all.indexOf(url) === i).slice(0, 4);
  for (const url of urls) {
    const response = await follow(url, origin, SITE_MAX).catch(() => null);
    if (!response || response.status !== 200 || response.big) continue;
    const ext = sniff(response.body);
    if (ext && ext !== 'svg') return { ext, bytes: response.body };
  }
  return null;
}

// A program's own icon on Linux, the way a launcher finds it: the .desktop file whose Exec runs it, its Icon, in the icon folders.
export async function programIcon(program, env = process.env) {
  const name = path.basename(program);
  const data = [env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')].filter(Boolean);
  const load = async (file) => {
    try {
      if ((await lstat(file)).size > SITE_MAX) return null;
      const bytes = await readFile(file), ext = sniff(bytes);
      return ext === 'png' || ext === 'svg' ? { ext, bytes } : null;
    } catch { return null; }
  };
  for (const base of data) {
    let files;
    try { files = (await readdir(path.join(base, 'applications'))).filter((file) => file.endsWith('.desktop')); } catch { continue; }
    for (const file of files) {
      let text;
      try { text = (await readFile(path.join(base, 'applications', file), 'utf8')).slice(0, 65_536); } catch { continue; }
      const exec = text.match(/^Exec=(.*)$/m)?.[1]?.trim().match(/^"([^"]+)"|^(\S+)/), icon = text.match(/^Icon=(.*)$/m)?.[1]?.trim();
      if (!exec || !icon || path.basename(exec[1] ?? exec[2]) !== name) continue;
      if (path.isAbsolute(icon)) { const found = await load(icon); if (found) return found; continue; }
      if (!/^[\w.+-]+$/.test(icon)) continue;
      for (const root of data) {
        for (const size of ['256x256', '128x128', '96x96', '64x64', '48x48']) { const found = await load(path.join(root, 'icons/hicolor', size, 'apps', icon + '.png')); if (found) return found; }
        for (const file2 of [`icons/hicolor/scalable/apps/${icon}.svg`, `pixmaps/${icon}.png`, `pixmaps/${icon}.svg`]) { const found = await load(path.join(root, file2)); if (found) return found; }
      }
    }
  }
  return null;
}

// dir: the state folder's icons cache. registry(): the registry's path under the workspace; pictures live in icons/ beside it.
export function createIcons({ dir, workspace, registry, discoverIcon = discover, now = Date.now }) {
  const cache = path.join(dir, 'icons');
  const pending = new Map();
  const site = async (link) => {
    let origin;
    try { const url = new URL(link); if (!/^https?:$/.test(url.protocol)) return null; origin = url.origin; } catch { return null; }
    const file = path.join(cache, createHash('sha256').update(origin).digest('hex').slice(0, 32) + '.json');
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); } catch {}
    // A hit is kept a week; a miss a day, so a site with no icon is not asked again at every refresh.
    if (saved && now() - saved.at < (saved.ext ? WEEK : DAY)) return saved.ext ? uri(saved.ext, Buffer.from(saved.data, 'base64')) : null;
    if (!pending.has(origin)) {
      pending.set(origin, (async () => {
        const found = await discoverIcon(link).catch(() => null);
        if (!found && saved?.ext) return saved;
        const next = found ? { at: now(), ext: found.ext, data: found.bytes.toString('base64') } : { at: now(), ext: null };
        await mkdir(cache, { recursive: true });
        await writeFile(file + '.tmp', JSON.stringify(next)); await rename(file + '.tmp', file);
        return next;
      })().finally(() => pending.delete(origin)));
    }
    const result = await pending.get(origin).catch(() => null);
    return result?.ext ? uri(result.ext, Buffer.from(result.data, 'base64')) : null;
  };

  // The icons folder under the workspace; null when the registry's folder is not really inside the workspace.
  const folder = async (make) => {
    const root = await realpath(workspace), beside = path.join(root, path.dirname(registry()));
    const real = await realpath(beside).catch(() => null);
    if (!real || (real !== root && !real.startsWith(root + path.sep))) return null;
    const icons = path.join(real, 'icons');
    if (make) await mkdir(icons, { recursive: true });
    const info = await lstat(icons).catch(() => null);
    return info?.isDirectory() ? icons : null;
  };
  // Keep the bytes as a file named for them (a hash and the extension sniffed from them). Content-addressed, so saving the
  // same picture twice is the same file. ponytail: not guardedSave (that is text only); a replaced file is never different content.
  async function savePicture(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > PICTURE_MAX) return { error: 'picture-too-big' };
    const ext = sniff(bytes);
    if (!ext) return { error: 'picture-type' };
    const icons = await folder(true);
    if (!icons) return { error: 'icons-folder-refused' };
    const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '.' + ext;
    const target = path.join(icons, name), temporary = target + '.tmp-' + process.pid;
    await writeFile(temporary, bytes, { flag: 'w' });
    await rename(temporary, target);
    return { name };
  }
  async function picture(name) {
    if (typeof name !== 'string' || !PICTURE.test(name)) return null;
    try {
      const icons = await folder(false);
      if (!icons) return null;
      const file = path.join(icons, name), info = await lstat(file);
      if (!info.isFile() || info.size > PICTURE_MAX) return null;
      const bytes = await readFile(file), ext = sniff(bytes);
      return ext === name.split('.')[1] ? uri(ext, bytes) : null;
    } catch { return null; }
  }

  // The art for the tiles now: {pages, apps, sections} each {key: {picture?, auto?}}, key = id (section: title). A tile with a
  // picture or a text icon is not fetched for. programs (not Linux): apps left for the desktop to ask the OS about.
  async function collect({ pages, apps, sections }, { platform = process.platform, env = process.env } = {}) {
    const art = { pages: {}, apps: {}, sections: {} }, programs = [];
    const put = (kind, key, field, value) => { if (value) (art[kind][key] ??= {})[field] = value; };
    await Promise.all([
      ...sections.map(async (item) => put('sections', item.title, 'picture', item.picture && await picture(item.picture))),
      ...pages.map(async (item) => {
        put('pages', item.id, 'picture', item.picture && await picture(item.picture));
        if (!item.picture && !item.icon) put('pages', item.id, 'auto', await site(item.url));
      }),
      ...apps.map(async (item) => {
        put('apps', item.id, 'picture', item.picture && await picture(item.picture));
        if (item.picture || item.icon) return;
        if (platform !== 'linux') { programs.push({ id: item.id, program: item.cmd[0] }); return; }
        const found = await programIcon(item.cmd[0], env);
        if (found) put('apps', item.id, 'auto', uri(found.ext, found.bytes));
      }),
    ]);
    return { ...art, ...(programs.length ? { programs } : {}) };
  }
  return { collect, savePicture, picture, site };
}
