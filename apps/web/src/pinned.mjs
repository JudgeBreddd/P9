// What stays in view above a chat's composer (AR1, AR2): the agent's latest plan, then the cards it pinned with the P9
// MCP server's pin_card (threat model row 42, apps/server/artifacts.mjs). A card's text goes only through mdOf, which is
// md() (helpers.mjs): HTML shows as text, a link as its text, an image as its alt text.
import { esc } from './helpers.mjs';

const mark = st => st === 'completed' ? '✓' : st === 'in_progress' ? '▸' : '○';
export const isReport = id => /^ready-[0-9a-f-]{36}$/.test(id);
// O109: a worker report the user closed stays closed until it says something new (the same worker's next report, or another worker's).
export const reportKey = (s, c) => s.id + '|' + c.id + '|' + c.text.length + '|' + [...c.text].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) | 0, 0);
// The closed report keys, kept in this browser (desktop and phone each keep their own).
export const SHUT = { keys: null, get() { if (!this.keys) try { this.keys = new Set(JSON.parse(localStorage.getItem('p9-reports-closed') || '[]')); } catch { this.keys = new Set(); } return this.keys; },
  add(k) { this.get().add(k); try { localStorage.setItem('p9-reports-closed', JSON.stringify([...this.keys])); } catch {} } };
// shut: the closed report keys (SHUT.get()). Given, only the newest worker report not closed is pinned, with a close button; the
// others scroll with the chat (chat-view's 'report' events). Not given (phone), every card is pinned as before.
// The worker report pinned now: the newest one, unless it was closed or its worker was archived (gone(card id), window-3: archived
// is the daemon's word, so archive_chat, the sidebar or another window takes it down too; the phone does not pass it yet).
export function openReport(s, shut, gone) {
  const top = [...(s.cards?.values() ?? [])].filter(c => isReport(c.id)).sort((a, b) => s.cardAt.get(b.id) - s.cardAt.get(a.id))[0];
  return top && !shut.has(reportKey(s, top)) && !gone?.(top.id) ? top : null;
}
// window-4 (row 730): with tuck (the desktop), the open report is drawn apart from the strip, folded to its title above the
// bottom (tuck.mjs). T: tuck.mjs, a promise while it loads; the first open report loads it, then 'p9:tuck' redraws the chats.
let T;
export function pinned(s, mdOf, shut, gone, tuck) {
  const plan = s.events.find(e => e.t === 'plan'), all = [...(s.cards?.values() ?? [])];
  const open = shut && openReport(s, shut, gone);
  const cards = shut ? all.filter(c => !isReport(c.id) || (c === open && !tuck)) : all;
  const folded = !(tuck && open) ? '' : T?.tab ? T.tab(s, { id: open.id, html: mdOf(open), text: open.text })
    : (T ??= import('./tuck.mjs').then(m => { T = m; dispatchEvent(new Event('p9:tuck')); }), '');
  if (!plan?.entries.length && !cards.length) return folded;
  return folded + `<div class="pinned" aria-label="Pinned">${plan?.entries.length ? `<div class="plan fx-title fx-lift"><div class="eyebrow">Plan <button type="button" class="open-plan" data-open-plan="entries" title="Open the plan to comment on it">Open</button></div><ul style="margin:0;padding:0">${plan.entries.map(([st, t]) => `<li data-s="${esc(st)}"><span class="i">${mark(st)}</span><span>${esc(t)}</span></li>`).join('')}</ul></div>` : ''}`
    + cards.map(c => `<div class="card-pin" data-card="${esc(c.id)}">${shut && isReport(c.id) ? `<button type="button" class="card-close" data-card-close="${esc(c.id)}" title="Close this report: it stays in the chat, and the next one shows here" aria-label="Close the worker report">×</button>` : ''}<div class="eyebrow">${isReport(c.id) ? 'Worker report' : `${esc(c.id)} · ${esc(c.kind)}`}</div><div class="msg agent">${mdOf(c)}</div></div>`).join('') + '</div>';
}

// The ledger's card events, applied in order: the same ID replaces that card in place, unpin removes it.
export function applyCard(s, type, d) {
  s.cards ||= new Map();
  if (type === 'unpin') s.cards.delete(d.id);
  // The arrival order lives beside the cards, not in them: the phone compares its cards as they are (its closed chip), so a card object stays { id, kind, text }.
  else { s.cards.set(d.id, { id: String(d.id), kind: String(d.kind), text: String(d.text ?? '') }); (s.cardAt ||= new Map()).set(d.id, (s.cardSeq = (s.cardSeq ?? 0) + 1)); }
}
