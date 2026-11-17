// window-4 (row 730, Tyler: "goes behind the chat box showing the title and clicking the title slides it up, click title
// again slides it down"): the open worker report drawn as a tab that floats on the chat just above the bottom. Only its title
// shows until it is clicked, so it never pushes the history up; its body stays in the page (inert, no height) while folded.
// Loaded by pinned.mjs only once a report is open, so the shell's startup JS stays inside its budget (shell-bundle.test.mjs).
import { esc } from './helpers.mjs';
import { reportKey, SHUT, TUCK } from './pinned.mjs';

// The reports unfolded in this window, by reportKey, so a new report arrives folded. ponytail: window memory only; a reload folds it again.
const OPENED = new Set(), say = on => on ? 'Slide the report down' : 'Slide the report up';
export const tab = (s, c, mdOf) => { const on = OPENED.has(reportKey(s, c));
  return `<div class="tuck" data-tuck-open="${on}"><div class="card-pin" data-card="${esc(c.id)}"><div class="tab"><button type="button" class="eyebrow" data-card-tab="${esc(c.id)}" aria-expanded="${on}" title="${say(on)}">Worker report</button><button type="button" class="card-close" data-card-close="${esc(c.id)}" title="Close this report: it stays in the chat, and the next one shows here" aria-label="Close the worker report">×</button></div><div class="tb"${on ? '' : ' inert'}><div class="msg agent">${mdOf(c)}</div></div></div></div>`; };

// FIX1 (Reviewer): the open body is capped by the room between the history's top and the bottom's top, not by 45vh alone, so
// with tall pins or a queue on a short window its title and close stay inside the pane. Both boxes are watched, so a window
// resize, a growing text box or a new pin refits it; a new .tuck is measured once when it is observed. The top-right cards stack
// (#cards, as placeSprints reads it) and the pane's sprint card float over the history, so the title row also stays below
// whichever of them it would run under (on a 560 px window the stack covered its x). ponytail: an opened sprint card that
// reaches the bottom leaves the report its title only.
const below = (o, r) => { const b = o?.getBoundingClientRect(); return b && b.height && getComputedStyle(o).visibility !== 'hidden' && b.left < r.right && b.right > r.left ? b.bottom + 4 : 0; };
const fit = new ResizeObserver(() => document.querySelectorAll('.pane').forEach(p => { const t = p.querySelector('.tuck'), h = p.querySelector('.hist'); if (!t || !h) return;
  const c = t.firstElementChild, r = c.getBoundingClientRect(), k = document.querySelector('#cards');
  const top = Math.max(h.getBoundingClientRect().top, below(k?.querySelector('.card') && k, r), below(p.querySelector(':scope > .sprint'), r));
  t.style.setProperty('--tuck-body', Math.max(0, Math.floor(t.parentElement.getBoundingClientRect().top - 6 - top - (c.offsetHeight - c.querySelector('.tb').offsetHeight))) + 'px'); }));

// The title slides the report up and down in place (no redraw, so the slide shows). The close shuts it as the strip's did (the
// desktop strip draws no report since window-4, so this is the desktop's only report close; the phone keeps its own).
export function wire(p, s, redraw) {
  [...p.querySelectorAll('.hist, .bottom > .col, .tuck, :scope > .sprint'), document.querySelector('#cards')].forEach(el => el && fit.observe(el));
  p.querySelectorAll('.tuck [data-card-close]').forEach(b => b.onclick = () => { const c = s.cards?.get(b.dataset.cardClose); if (c) SHUT.add(reportKey(s, c)); redraw(); });
  p.querySelectorAll('[data-card-tab]').forEach(b => b.onclick = () => { const c = s.cards?.get(b.dataset.cardTab), t = b.closest('.tuck'); if (!c || !t) return;
    const k = reportKey(s, c), on = !OPENED.has(k); on ? OPENED.add(k) : OPENED.delete(k);
    t.dataset.tuckOpen = on; b.setAttribute('aria-expanded', on); b.title = say(on); t.querySelector('.tb').inert = !on; });
}
// Loaded: pinned.mjs draws the tab from here on, and chat-view stops asking for this module (want).
Object.assign(TUCK, { tab, wire, want: 0 });
