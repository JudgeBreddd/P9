import { Marked } from 'marked';
import { artifactInfo, artifactChip } from './artifact.mjs';
/* Popover helper: toggles [hidden] on a panel anchored under a button; closes on outside click / Esc. */
export const popover = (btn, panel, onOpen, signal) => {
  const open = () => { document.querySelectorAll('.pop').forEach(p => { if (p !== panel) p.hidden = true; }); panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); onOpen && onOpen(); };
  const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => { e.stopPropagation(); panel.hidden ? open() : close(); });
  panel.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', close, { signal });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); }, { signal });
  return { open, close };
};
// Drag and arrow-key resizing for a separator (the terminal grip, the Chat Focus split bar, the side panel's bar).
// el: the separator. axis: 'x' | 'y'. get(): the size now in px; set(px): apply it. min, max: px or a function of px, the clamp.
// dir (a number or a function of none): 1 when moving right/down grows the thing (a left pane), -1 when it shrinks it (a right panel, a bottom dock).
// Keys: the arrow that grows it adds 24 px, the other takes 24 px, Home = min, End = max. done(px) runs once at pointerup
// or keyup: the place to persist. signal ends the listeners with the page.
export function dragBar(el, { axis = 'x', dir = 1, get, set, min = 0, max = Infinity, done = () => {}, signal }) {
  const val = v => typeof v === 'function' ? v() : v, clamp = px => Math.max(val(min), Math.min(val(max), px)), at = e => axis === 'x' ? e.clientX : e.clientY;
  const d = () => val(dir), grow = () => ({ x: d() > 0 ? 'ArrowRight' : 'ArrowLeft', y: d() > 0 ? 'ArrowDown' : 'ArrowUp' })[axis], shrink = () => ({ x: d() > 0 ? 'ArrowLeft' : 'ArrowRight', y: d() > 0 ? 'ArrowUp' : 'ArrowDown' })[axis];
  let from = null, size = 0, stepped = false;
  el.style.touchAction = 'none';
  // The move and the release are heard on the window, not the bar: the bar's own pointer capture was lost mid-drag in Electron
  // (the editor view beside it moves with the bar), and the old terminal grip listened on the window too.
  const move = e => { if (from !== null) set(clamp(size + d() * (at(e) - from))); };
  const end = () => { if (from === null) return; from = null; removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); done(get()); };
  el.addEventListener('pointerdown', e => { if (e.button) return; from = at(e); size = get(); e.preventDefault(); addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end); }, { signal });
  signal?.addEventListener('abort', end);
  el.addEventListener('keydown', e => {
    const to = e.key === grow() ? get() + 24 : e.key === shrink() ? get() - 24 : e.key === 'Home' ? val(min) : e.key === 'End' ? val(max) : null;
    if (to === null) return;
    e.preventDefault(); set(clamp(to)); stepped = true;
  }, { signal });
  el.addEventListener('keyup', () => { if (stepped) { stepped = false; done(get()); } }, { signal });
}
export const svg = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  files: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 4 4-4 4"/><path d="M12 16h7"/><rect x="2" y="3" width="20" height="18" rx="2"/></svg>',
  cmd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.6-10-8.6Z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l11-7z"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
  float: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  rows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
};
export const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The Sprint tracker's times, readable: an ISO time is the device's local time without seconds ("6:53 PM"), with
// "tomorrow" / "yesterday" or a short date when the day is not today; anything else (the Builder's "07:00") is shown as written.
const ISO = /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/;
export function sprintTime(value, now = new Date()) {
  const raw = String(value ?? '').trim(), at = new Date(raw);
  if (!ISO.test(raw) || Number.isNaN(at.getTime())) return raw;
  const day = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const apart = Math.round((day(at) - day(now)) / 86400000);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (apart === 0) return time;
  return time + ' ' + (apart === 1 ? 'tomorrow' : apart === -1 ? 'yesterday' : at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
}
export const sprintTimes = (d, now) => `Updated ${sprintTime(d.updatedAt, now) || 'unknown'}${d.cutoff ? ' · cutoff ' + sprintTime(d.cutoff, now) : ''}`;
// HI1: the hover "i" beside a Settings row (T-tracer's .info). Its tip says what the row does; a click opens that guide section.
export const info = (tip, section) => `<button class="info" type="button" data-docs="${esc(section)}" aria-label="${esc(tip)}" title="${esc(tip)}">i</button>`;

// One line per provider for the plan limits from /usage (apps/server/limits.mjs). A window whose reset time has passed
// shows "new window": the old figure expired and the new one is not known until the tool records it again.
// Markdown (threat model row 18): marked escapes text and code; raw HTML shows as text, an image as its alt text. md
// (notes, pinned cards, file previews): a link is its text with the address in a tooltip (nothing to click). mdReply
// (agent replies, P9): a link opens outside P9 only when it is one plain http(s) address (webLink); then the host shows
// after text that is not the address, so a reply cannot dress one site as another; anything else stays as in md.
// Desktop and phone both use them; the desktop's click goes to main (p9:open-link), which checks the URL again.
export const webLink = href => {
  if (typeof href !== 'string' || href.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(href)) return null;
  try { const u = new URL(href); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u : null; } catch { return null; }
};
const textLink = function (t) { return `<span class="link" title="${esc(t.href)}">${this.parser.parseInline(t.tokens)}</span>`; };
const mdText = { html: t => esc(t.text), image: t => esc(t.text) };
export const md = new Marked({ gfm: true, breaks: true, async: false, renderer: { ...mdText, link: textLink } });
// Item 19: a fenced block marked as an artifact (artifact.mjs) is a chip that opens it, never the code in place.
export const mdReply = new Marked({ gfm: true, breaks: true, async: false, renderer: { ...mdText,
  code(t) { const a = artifactInfo(t.lang); return a ? artifactChip(a, t.text) : false; },
  link(t) {
    const u = webLink(t.href); if (!u) return textLink.call(this, t);
    const same = [t.href, u.href, u.host, u.href.replace(/^https?:\/\//, '')].includes(t.text.trim());
    return `<a class="link" href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">${this.parser.parseInline(t.tokens)}</a>` + (same ? '' : ` <span class="link-host">(${esc(u.host)})</span>`);
  },
} });
// P19: a reply's code blocks get a Copy button (desktop and phone); copy() says Copied or why not on the button.
export const copyCode = html => html.replaceAll('<pre><code', '<pre><button data-slot="button" data-variant="ghost" data-size="sm" data-copycode>Copy</button><code');
export const copy = (text, btn) => navigator.clipboard.writeText(text).then(() => 'Copied', e => { btn.title = String(e?.message || e); return 'Copy failed'; }).then(said => { const was = btn.textContent; btn.textContent = said; btn.dataset.said = said; setTimeout(() => { btn.textContent = was; delete btn.dataset.said; }, 2000); });
// Each agent's own mode names (the daemon's allowlist, chat.mjs MODES) and the two loosened ones, which ask first in red
// (threat model row 25). Desktop and phone (P6).
export const modes = { claude: ['Auto', 'Manual', 'Plan', 'Accept edits', 'Bypass permissions'], codex: ['Read-only', 'Workspace access', 'Auto review', 'Full access'] };
export const LOOSE = { 'Bypass permissions': 'Claude runs every command and edits any file it can reach, without asking first.',
  'Full access': 'Codex runs without a sandbox: it can read and change any file on this computer and use the network, without asking first.' };
// Images an agent sent with their own data (threat model row 26): the type and alphabet checked again, the data: address
// built here; a block's uri is never used. Desktop and phone (P9). ponytail: data: strings are re-diffed each render;
// blob: needs a CSP change.
export const IMG_OK = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const imgSrc = b => b?.type === 'image' && IMG_OK.includes(b.mimeType) && typeof b.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(b.data) ? `data:${b.mimeType};base64,${b.data}` : null;
export const toolImages = content => (content || []).map(c => imgSrc(c?.type === 'content' ? c.content : c)).filter(Boolean).slice(0, 4);
export const agentImgs = (list, who) => list?.length ? `<div class="agent-imgs">${list.map(src => `<img src="${src}" alt="Image from ${esc(who)}">`).join('')}</div>` : '';
// An image a person attaches (threat model row 20; the daemon checks the same limits): desktop paperclip, paste and drop,
// and the phone's + (P8). Over 1568 px or near 2 MB it is scaled to a JPEG; still over 2 MB, refused with the reason.
export const MAX_IMAGES = 4, MAX_IMAGE = 2 * 1024 * 1024;
const base64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
export async function readImage(file) {
  if (!IMG_OK.includes(file.type)) throw new Error('PNG, JPEG, GIF or WebP only');
  let blob = file, mimeType = file.type;
  const bmp = await createImageBitmap(file), k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  if (k < 1 || file.size > MAX_IMAGE * 3 / 4) {
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }); mimeType = 'image/jpeg';
  }
  const data = await base64(blob);
  if (data.length > MAX_IMAGE) throw new Error('still over 2 MB after scaling');
  return { mimeType, data, name: file.name };
}
export const limitLine = (name, limits, now = Date.now(), signedOut = false) => {
  if (signedOut) return { name, text: name + ' not logged in', stale: true };
  if (!limits) return { name, text: 'no plan limits recorded yet', stale: true };
  const when = at => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const part = (label, w) => !w ? label + ' n/a' : w.resetsAt && w.resetsAt < now ? label + ' new window' : `${label} ${Math.round(w.usedPercent)}%` + (w.resetsAt ? ` (resets ${when(w.resetsAt)})` : '');
  const age = now - limits.asOf, hours = age / 3600000;
  const old = age < 15 * 60000 ? 'just now' : hours < 1 ? Math.round(age / 60000) + ' min old' : hours < 48 ? Math.round(hours) + ' h old' : Math.round(hours / 24) + ' d old';
  return { name, text: part('5 h', limits.fiveHour) + ' · ' + part('week', limits.sevenDay) + ' · ' + old, stale: hours >= 1 };
};
