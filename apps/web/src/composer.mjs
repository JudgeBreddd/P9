// Sending while a turn runs (CP1; the 2026-10-24 decision: a chip with Steer / Queue / Cancel, as in the agents' own
// terminals; O-702: desktop and phone show the same three, Steer / Queue / Interrupt, with the same
// titles as the phone's card, phone.astro #midTurn). Steer (Enter) goes into the turn when its current tool call ends;
// Queue (Tab) goes after the turn; Interrupt (Ctrl Enter) stops the turn and sends now; Cancel (Esc) ends the turn and the
// text stays in the box. The daemon holds Steer and Queue (chat.mjs hold), so they survive a window restart; the window
// lists what it holds, each with an x that takes it back into the box.
import { esc, svg } from './helpers.mjs';

const button = (attr, label, key, title) => `<button data-slot="button" data-variant="ghost" data-size="sm" ${attr} title="${title}">${label} <kbd>${key}</kbd></button>`;
export const chip = () => `<span class="hint" role="group" aria-label="Send while the agent works">`
  + button('data-when="steer"', 'Steer', 'Enter', 'Send into this turn when its current step ends')
  + button('data-when="queue"', 'Queue', 'Tab', 'Send when this turn ends')
  + button('data-when="now"', 'Interrupt', 'Ctrl Enter', 'Stop this turn and send this now')
  + button('data-cancel', 'Cancel', 'Esc', 'Stop this turn; your text stays in the box') + '</span>';

// The messages the daemon holds for this turn, above the local queue (which is only for an agent without steering).
export const waiting = s => (s.held || []).map(h => `<div class="q" data-held="${esc(h.id)}"><span>${h.when === 'queue' ? 'Queued' : 'After this step'}: ${esc(h.text)}</span><button title="Send this now (stops this turn)" data-unhold="${esc(h.id)}" data-now>${svg.bolt}</button><button title="Take it back into the box" data-unhold="${esc(h.id)}">${svg.x}</button></div>`).join('');

// O109: everything waiting (held, then the local queue) is one strip, "N queued", so 30 waiting messages cannot push the box
// off the screen. Open while it is short (up to 3), shut past that; the user's own open or shut (s.queueOpen) wins.
// ponytail: an open strip's list scrolls inside 30vh (shell.css).
// O125 (4): with how long the oldest one has waited (since: chat-view's ticking age), so a stuck queue shows: held ones and
// the local queue (an agent without steering, { t, at }) alike. One kept by an older build has no time and adds to the count only.
export const strip = (s, since, local) => { const n = (s.held?.length ?? 0) + s.queue.length, at = Math.min(...[...(s.held ?? []), ...s.queue].map(h => h.at || Infinity));
  return `<details class="queue" data-queue${s.queueOpen ?? n <= 3 ? ' open' : ''}><summary>${n} queued${at < Infinity ? ', oldest waiting ' + since(at) : ''}</summary><div class="qs">${waiting(s)}${local}</div></details>`; };

// What a key in the box does while a turn runs: 'steer', 'queue', 'cancel', or null (the box keeps the key).
export const turnKey = e => e.shiftKey || e.altKey || e.ctrlKey || e.metaKey ? null : { Enter: 'steer', Tab: 'queue', Escape: 'cancel' }[e.key] ?? null;

// CP4: a tool's edit as a line diff (longest common subsequence): unchanged lines show 3 either side of a change, and a
// run of them cut out shows as one "⋯" line. ponytail: an n*m table, so an edit past 1M line pairs shows as all removed
// then all added; Myers' diff if those come up.
export const lineDiff = (a, b) => {
  const n = a.length, m = b.length, out = [];
  if (n * m > 1e6) return [...a.map(l => ['del', l]), ...b.map(l => ['add', l])];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && a[i] === b[j]) { out.push(['ctx', a[i++]]); j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) out.push(['del', a[i++]]);
    else out.push(['add', b[j++]]);
  }
  const near = k => out.slice(Math.max(0, k - 3), k + 4).some(r => r[0] !== 'ctx');
  return out.flatMap((r, k) => r[0] !== 'ctx' || near(k) ? [r] : k > 0 && near(k - 1) ? [['ctx', '⋯']] : []);
};
export const textLines = t => typeof t === 'string' && t ? t.replace(/\n$/, '').split('\n') : [];
// O121 part 2: an edit's diff rows, up to max. A diff with _meta.hunks (a Codex git patch, acp-v2.mjs diffs) shows each hunk under
// an "@@ -old +new @@" line, and each file under its path when the edit wrote more than one; a v1 diff (no hunks) is the
// line diff of its old and new text, as before.
// _meta is open to any agent's extensions: only ['ctx'|'add'|'del', text] rows reach the renderer, any other entry is dropped.
// A hunk's start line is a whole number from 0 up, else 0; never coerced (an object whose toString is null throws).
const line = v => (Number.isInteger(v) && v >= 0 ? v : 0);
const okRow = r => Array.isArray(r) && (r[0] === 'ctx' || r[0] === 'add' || r[0] === 'del') && typeof r[1] === 'string';
// O222: whether a diff made its file. A v2 diff (hunks, no oldText: acp-v2.mjs diffs) says so in _meta.added; a v1 diff,
// or a v2 one stored before O222 (it still has oldText), is a created file when it has no old text.
const v2 = c => Array.isArray(c?._meta?.hunks) && c.oldText === undefined;
export const diffCreated = c => (v2(c) ? c._meta.added === true : c?.oldText == null || c.oldText === '');
// O121 part 4b: a v2 diff's marks (acp-v2.mjs diffs), each a header line before its hunks; one P9 did not write is not drawn.
export const diffDeleted = c => v2(c) && c._meta.deleted === true;
const str = v => typeof v === 'string' && v;
const marks = c => (v2(c) ? [diffDeleted(c) && 'Deleted', str(c._meta.from) && 'Renamed from ' + c._meta.from, c._meta.binary === true && 'Binary file: the change is not shown', str(c._meta.mode) && 'Mode ' + c._meta.mode].filter(Boolean).map(t => ['hunk', t]) : []);
export const diffRows = (content, max) => {
  const list = (content || []).filter(c => c?.type === 'diff'), many = list.some(c => c._meta?.hunks) && new Set(list.map(c => c.path)).size > 1;
  return list.flatMap(c => [...(many ? [['file', typeof c.path === 'string' ? c.path : '']] : []), ...marks(c), ...(Array.isArray(c._meta?.hunks)
    ? c._meta.hunks.filter(h => Array.isArray(h?.rows)).flatMap(h => [['hunk', `@@ -${line(h.old)} +${line(h.new)} @@`], ...h.rows.filter(okRow)]) : lineDiff(textLines(c.oldText), textLines(c.newText)))]).slice(0, max);
};
