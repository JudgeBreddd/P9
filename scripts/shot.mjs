// O146: a read-only screenshot of a running P9 page, for troubleshooting.
//   node scripts/shot.mjs <page path> [desktop|phone]   prints the PNG's path
//   node scripts/shot.mjs --list <shots.json>           shots.json: [{ "row": "O12", "claim": "...", "path": "/phone/", "size": "phone" }];
//                                                       takes every shot and prints the path of one page that shows them all, each with its claim
// Environment: P9_SHOT_BASE the P9 origin (required); P9_SHOT_TOKEN the session cookie's value (optional; read here only, never
// printed or written); P9_SHOT_CHROMIUM a browser binary (Playwright's own when unset); P9_SHOT_OUT the folder that gets one
// dated folder per day (default <tmp>/p9-shots); P9_SHOT_WAIT ms to let the page settle (default 2000).
// It only looks. Nothing is clicked or typed. Every request that is not GET or HEAD is stopped in the browser before it leaves,
// WebSockets connect, so the page shows live data, but every frame the page sends is dropped before it leaves (frames from the
// server still reach the page). Service workers are blocked (a request through one would skip that check). The browser
// runs with its own throwaway profile, which Playwright deletes on close; the cookie lives only in that profile's memory.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SIZES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const fail = (message) => { console.error('shot: ' + message); process.exit(2); };
const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const env = process.env, args = process.argv.slice(2);
if (!env.P9_SHOT_BASE) fail('set P9_SHOT_BASE to the P9 origin, for example http://127.0.0.1:<port>');
const base = new URL(env.P9_SHOT_BASE), wait = Number(env.P9_SHOT_WAIT ?? 2000);
let shots;
if (args[0] === '--list') {
  if (!args[1]) fail('--list needs a JSON file');
  shots = JSON.parse(await readFile(args[1], 'utf8'));
  if (!Array.isArray(shots)) fail('the list must be a JSON array');
} else if (args[0]) shots = [{ path: args[0], size: args[1] ?? 'desktop' }];
else fail('usage: shot.mjs <page path> [desktop|phone] | shot.mjs --list <shots.json>');
for (const shot of shots) {
  if (!SIZES[shot.size ?? 'desktop']) fail('size must be desktop or phone, not ' + shot.size);
  if (typeof shot.path !== 'string' || !shot.path.startsWith('/')) fail('a page path starts with /');
}

const now = new Date(), stamp = now.toISOString().replace(/[-:]/g, '').slice(9, 15);
const folder = path.join(env.P9_SHOT_OUT || path.join(os.tmpdir(), 'p9-shots'), now.toISOString().slice(0, 10));
await mkdir(folder, { recursive: true });
const blocked = [];
let dropped = 0;
const browser = await chromium.launch({ executablePath: env.P9_SHOT_CHROMIUM || undefined });
const made = [];
try {
  for (const [n, shot] of shots.entries()) {
    const size = shot.size ?? 'desktop';
    const context = await browser.newContext({ ...SIZES[size], serviceWorkers: 'block' });
    try {
      if (env.P9_SHOT_TOKEN) {
        const secure = base.protocol === 'https:' || base.hostname === 'localhost' || base.hostname.endsWith('.localhost') || base.hostname === '127.0.0.1';
        await context.addCookies([{ name: 'p9s', value: env.P9_SHOT_TOKEN, url: base.origin, httpOnly: true, secure, sameSite: 'Strict' }]);
      }
      await context.route('**/*', (route) => {
        const request = route.request();
        if (request.method() === 'GET' || request.method() === 'HEAD') return route.continue();
        blocked.push(request.method() + ' ' + new URL(request.url()).pathname);
        return route.abort('blockedbyclient');
      });
      // A terminal socket stays closed: connecting one attaches a terminal client on the server. Every other socket connects;
      // setting onMessage on the page side stops Playwright forwarding the page's frames; the server's are forwarded as they come.
      await context.routeWebSocket(/.*/, (socket) => {
        const where = new URL(socket.url()).pathname;
        if (where.startsWith('/terminals/')) { blocked.push('WebSocket ' + where); return socket.close(); }
        socket.connectToServer(); socket.onMessage(() => { dropped += 1; });
      });
      const page = await context.newPage();
      await page.goto(new URL(shot.path, base).href, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(wait);
      const slug = shot.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'root';
      const file = path.join(folder, `${stamp}-${String(n + 1).padStart(2, '0')}-${size}-${slug}.png`);
      await page.screenshot({ path: file });
      made.push({ ...shot, size, file });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }

if (dropped) console.error(`shot: dropped ${dropped} WebSocket frame(s) the page tried to send`);
if (blocked.length) console.error(`shot: stopped ${blocked.length} request(s) that would have changed something: ${[...new Set(blocked)].join(', ')}`);
if (args[0] !== '--list') console.log(made[0].file);
else {
  const page = path.join(folder, `${stamp}-shots.html`);
  await writeFile(page, `<!doctype html><meta charset="utf-8"><title>P9 shots ${escape(now.toISOString().slice(0, 16))}</title>
<style>body{font:15px system-ui;margin:24px;background:#111;color:#eee}figure{margin:0 0 32px}img{max-width:100%;max-height:80vh;border:1px solid #444}figcaption{margin:6px 0 10px}b{color:#fff}</style>
${made.map((shot) => `<figure><figcaption><b>${escape(shot.row ?? '')}</b> ${escape(shot.claim ?? '')} <small>(${escape(shot.path)}, ${shot.size})</small></figcaption><img src="${escape(path.basename(shot.file))}"></figure>`).join('\n')}
`);
  console.log(page);
}
