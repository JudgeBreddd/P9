// A2 step 7: the saved drafts menu, opened by Drafts beside the paperclip or by Ctrl+S in an empty box. Loads on first use
// (chat-view.mjs drafts). A draft clicked leaves the list and goes back in the box; its x deletes it; Esc or a click outside
// closes the menu. The list is chat-view's DRAFTS key: newest first, text and when it was saved.
import { ageOf } from './helpers.mjs';
let shut = null;
export const readDrafts = key => { try { const d = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(d) ? d.filter(x => typeof x?.text === 'string' && x.text) : []; } catch { return []; } };
export function draftsMenu({ rect, key, take, changed, back, host = document.body }) {
  shut?.();
  const box = Object.assign(document.createElement('div'), { className: 'drafts-menu', role: 'dialog' }), ac = new AbortController();
  box.setAttribute('aria-label', 'Saved drafts');
  const close = shut = (refocus) => { ac.abort(); box.remove(); if (shut === close) shut = null; if (refocus) back?.(); };
  const without = x => readDrafts(key).filter(y => !(y.at === x.at && y.text === x.text));
  const write = d => { try { localStorage.setItem(key, JSON.stringify(d)); } catch {} };
  const draw = () => {
    const d = readDrafts(key);
    if (!d.length) return close(true);
    box.replaceChildren(...d.map(x => {
      const row = Object.assign(document.createElement('div'), { className: 'draft' });
      const use = Object.assign(document.createElement('button'), { className: 'draft-take', title: x.text });
      use.append(Object.assign(document.createElement('span'), { className: 'truncate', textContent: x.text.replace(/\s+/g, ' ').slice(0, 200) }),
        Object.assign(document.createElement('span'), { className: 'draft-age', textContent: x.at ? ageOf(x.at) : '' }));
      use.onclick = () => { write(without(x)); close(); take(x.text); };
      const del = Object.assign(document.createElement('button'), { className: 'draft-del', textContent: '×', title: 'Delete this draft' });
      del.setAttribute('aria-label', 'Delete this draft');
      del.onclick = () => { write(without(x)); changed(); draw(); box.querySelector('.draft-take')?.focus(); };
      row.append(use, del); return row;
    }));
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
  document.addEventListener('pointerdown', e => { if (!box.contains(e.target)) close(); }, { capture: true, signal: ac.signal });
  box.querySelector('.draft-take').focus();
}
