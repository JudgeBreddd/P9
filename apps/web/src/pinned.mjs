// What stays in view above a chat's composer (AR1, AR2): the agent's latest plan, then the cards it pinned with the P9
// MCP server's pin_card (threat model row 42, apps/server/artifacts.mjs). A card's text goes only through mdOf, which is
// md() (helpers.mjs): HTML shows as text, a link as its text, an image as its alt text.
import { esc } from './helpers.mjs';

const mark = st => st === 'completed' ? '✓' : st === 'in_progress' ? '▸' : '○';
export function pinned(s, mdOf) {
  const plan = s.events.find(e => e.t === 'plan'), cards = [...(s.cards?.values() ?? [])];
  if (!plan?.entries.length && !cards.length) return '';
  return `<div class="pinned" aria-label="Pinned">${plan?.entries.length ? `<div class="plan fx-title fx-lift"><div class="eyebrow">Plan <button type="button" class="open-plan" data-open-plan="entries" title="Open the plan to comment on it">Open</button></div><ul style="margin:0;padding:0">${plan.entries.map(([st, t]) => `<li data-s="${esc(st)}"><span class="i">${mark(st)}</span><span>${esc(t)}</span></li>`).join('')}</ul></div>` : ''}`
    + cards.map(c => `<div class="card-pin" data-card="${esc(c.id)}"><div class="eyebrow">${esc(c.id)} · ${esc(c.kind)}</div><div class="msg agent">${mdOf(c)}</div></div>`).join('') + '</div>';
}

// The ledger's card events, applied in order: the same ID replaces that card in place, unpin removes it.
export function applyCard(s, type, d) {
  s.cards ||= new Map();
  if (type === 'unpin') s.cards.delete(d.id);
  else s.cards.set(d.id, { id: String(d.id), kind: String(d.kind), text: String(d.text ?? '') });
}
