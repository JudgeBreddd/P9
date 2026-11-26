// A2 step 7: the saved drafts menu, opened by Drafts beside the paperclip or by Ctrl+S in an empty box. Loads on first use
// (chat-view.mjs drafts). A draft clicked leaves the list and goes back in the box; its x deletes it; Esc or a click outside
// closes the menu. The list is chat-view's DRAFTS key: newest first, text, quotes and when it was saved.
import { ageOf } from './helpers.mjs';
let shut = null;
// Quotes a draft carries (step 6 follow-up): text and comment, anything else dropped.
const okQuotes = q => Array.isArray(q) ? q.filter(x => typeof x?.text === 'string' && x.text).map(x => ({ text: x.text, comment: typeof x.comment === 'string' ? x.comment : '' })) : undefined;
export const readDrafts = key => { try { const d = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(d) ? d.filter(x => typeof x?.text === 'string' && (x.text || okQuotes(x.quotes)?.length)).map(x => ({ ...x, quotes: okQuotes(x.quotes) })) : []; } catch { return []; } };
export function draftsMenu({ rect, key, take, remove, alive, back, host = document.body }) {
  shut?.();
  const box = Object.assign(document.createElement('div'), { className: 'drafts-menu', role: 'dialog' }), ac = new AbortController();
  box.setAttribute('aria-label', 'Saved drafts');
  const close = shut = (refocus) => { ac.abort(); box.remove(); if (shut === close) shut = null; if (refocus) back?.(); };
  // A draft is its id (review: two quote-only drafts saved in the same millisecond were one); one saved before ids, its time
  // and text. Every action reads the list as it is now, so a row
  // another window took is redrawn away instead of brought back. ponytail: no lock across windows; one person acts in one
  // window at a time, and each read-and-write is one synchronous step.
  const same = x => y => x.id ? y.id === x.id : !y.id && y.at === x.at && y.text === x.text;
  const act = (x, fn) => { if (!alive()) return close(); const d = readDrafts(key); if (!d.some(same(x))) return draw(); fn(d.filter(y => !same(x)(y))); };
  const draw = () => {
    const had = box.contains(document.activeElement), d = readDrafts(key);
    if (!d.length) return close(true);
    box.replaceChildren(...d.map(x => {
      const row = Object.assign(document.createElement('div'), { className: 'draft' });
      const q = x.quotes?.length ? `${x.quotes.length} quote${x.quotes.length > 1 ? 's' : ''}` : '', first = x.quotes?.[0], words = (x.text || (first ? first.comment || `“${first.text}”` : '')).replace(/\s+/g, ' ').trim(); // quote-only: its first comment or words
      const use = Object.assign(document.createElement('button'), { className: 'draft-take', title: [x.text, ...(x.quotes || []).map(y => '> ' + y.text + (y.comment ? '\n' + y.comment : ''))].filter(Boolean).join('\n\n') });
      use.append(Object.assign(document.createElement('span'), { className: 'truncate', textContent: (q && words ? q + ' · ' : q) + words.slice(0, 200) }),
        Object.assign(document.createElement('span'), { className: 'draft-age', textContent: x.at ? ageOf(x.at) : '' }));
      use.onclick = () => act(x, rest => { if (take(x, rest)) close(); });
      const del = Object.assign(document.createElement('button'), { className: 'draft-del', textContent: '×', title: 'Delete this draft' });
      del.setAttribute('aria-label', 'Delete this draft');
      del.onclick = () => act(x, rest => { if (remove(rest)) draw(); });
      row.append(use, del); return row;
    }));
    if (had && !box.contains(document.activeElement)) box.querySelector('.draft-take')?.focus();
  };
  draw();
  if (!box.childElementCount) return;
  host.append(box);
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(rect.right - w, innerWidth - w - 8)) + 'px';
  box.style.top = Math.max(8, rect.top - 4 - h) + 'px';
  box.onkeydown = e => {
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { // between the drafts, the x buttons skipped
      e.preventDefault(); const all = [...box.querySelectorAll('.draft-take')], i = all.indexOf(document.activeElement.closest('.draft')?.querySelector('.draft-take'));
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
    }
  };
  box.addEventListener('focusout', e => { if (e.relatedTarget && !box.contains(e.relatedTarget)) close(); }, { signal: ac.signal });
  addEventListener('storage', e => { if (e.key === key) draw(); }, { signal: ac.signal }); // another window changed the list
  document.addEventListener('pointerdown', e => { if (!box.contains(e.target)) close(); }, { capture: true, signal: ac.signal });
  box.querySelector('.draft-take').focus();
}
