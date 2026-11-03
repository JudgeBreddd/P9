import { dragBar } from './helpers.mjs';
// The side panel (specs/side-panel.md): one resizable column beside the focus panes, one slot showing at a time.
//   side.open(slot, { title, render(bodyEl), onClose(reason), mode, focuses, defaultWidth(stageWidth) })
//   side.close(slot) · side.toggle(slot, opts?) · side.current() · side.onResize(fn) · side.focus(name) · side.swap()
// Width is one number per focus in localStorage['eh-side:<focus>']; min 280; the pane beside it keeps 480 (Builder, 2026-10-27).
// The panel sits on the right or the left (the Dev Focus swap), kept in localStorage['eh-side-edge:<focus>'].
// A slot that lists focuses shows only in them: leaving one hides it without onClose, coming back shows it again.
// mode: 'panel' | 'pinned' | 'full'. In a window under 720 px panel and pinned behave as full.
export const SIDE_MIN = 280, SIDE_KEEP = 480;
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
export function createSide({ el, stage, focus, signal, narrow = '(max-width: 719px)' }) {
  const bar = el.querySelector('.handle-v'), head = el.querySelector('.shead'), title = el.querySelector('.stitle'), body = el.querySelector('.sbody');
  const listeners = new Set(), last = {}, mq = matchMedia(narrow);
  let cur = null; // { slot, opts, mode, prev }
  const key = () => 'eh-side:' + focus(), edgeKey = () => 'eh-side-edge:' + focus();
  const shown = () => !!cur && (!cur.opts.focuses || cur.opts.focuses.includes(focus()));
  const edge = () => store.get(edgeKey()) === 'left' ? 'left' : 'right';
  const mode = () => !cur ? null : mq.matches && cur.mode !== 'full' ? 'full' : cur.mode;
  const space = () => stage.clientWidth;
  const max = () => Math.max(SIDE_MIN, Math.min(space() * .7, space() - SIDE_KEEP));
  const clamp = px => Math.round(Math.max(SIDE_MIN, Math.min(max(), px)));
  const stored = () => { const v = store.get(key()); return v === null ? NaN : Number(v); };
  let live = null; // the width while dragging or after a key step, before the next focus change
  const width = () => clamp(live ?? (Number.isFinite(stored()) ? stored() : cur?.opts.defaultWidth?.(space()) ?? 420));
  const apply = () => {
    const on = shown();
    el.hidden = !on;
    stage.dataset.side = on ? edge() : '';
    stage.dataset.sideMode = on ? mode() : '';
    if (on) stage.style.setProperty('--side-w', width() + 'px'); else stage.style.removeProperty('--side-w');
    if (on) { title.textContent = cur.opts.title ?? ''; el.dataset.slot = cur.slot; }
    const w = on && mode() !== 'full' ? width() : 0;
    listeners.forEach(fn => fn(w));
  };
  dragBar(bar, { axis: 'x', dir: () => edge() === 'right' ? -1 : 1, get: width, set: px => { live = clamp(px); apply(); },
    min: SIDE_MIN, max, done: px => { store.set(key(), String(clamp(px))); }, signal });
  const full = () => !!cur && mode() === 'full';
  const api = {
    open(slot, opts) {
      const prior = cur;
      cur = { slot, opts, mode: opts.mode ?? 'panel', prev: null }; last[slot] = opts;
      live = null;
      body.replaceChildren(); opts.render(body);
      if (prior && prior.slot !== slot) prior.opts.onClose?.('replaced');
      apply();
    },
    close(slot, reason = 'close') { // only the owner's slot
      if (!cur || cur.slot !== slot) return;
      const gone = cur; cur = null; body.replaceChildren(); apply(); gone.opts.onClose?.(reason);
    },
    toggle(slot, opts) { if (cur?.slot === slot) api.close(slot); else api.open(slot, opts ?? last[slot]); },
    current: () => cur && shown() ? { slot: cur.slot, mode: mode() } : null,
    onResize(fn) { listeners.add(fn); signal?.addEventListener('abort', () => listeners.delete(fn)); },
    // Dev Focus: the focus changed; width and edge are per focus.
    focus() { live = null; apply(); },
    mode(next) { if (!cur) return; cur.prev = cur.mode; cur.mode = next; apply(); },
    back() { if (!cur) return; if (cur.mode === 'full' && cur.prev && cur.prev !== 'full') api.mode(cur.prev); else api.close(cur.slot); },
    edge, width: () => (shown() ? width() : 0), body,
    swap() { store.set(edgeKey(), edge() === 'right' ? 'left' : 'right'); apply(); },
    // A draggable tab: released across the divider, the two panes change sides. which: 'side' | 'main'.
    tab(tab, which) {
      let from = null;
      // Heard on the window, like dragBar: pointer capture was lost mid-drag in Electron while the editor view moved beside the bar.
      const stop = () => { from = null; stage.classList.remove('tabdrag'); removeEventListener('pointerup', end); removeEventListener('pointercancel', stop); };
      const end = e => {
        if (from === null) return; const moved = Math.abs(e.clientX - from) > 12; stop();
        const x = bar.getBoundingClientRect().left + bar.getBoundingClientRect().width / 2, left = (which === 'main') === (edge() === 'right');
        if (moved && shown() && (left ? e.clientX > x : e.clientX < x)) api.swap();
      };
      tab.addEventListener('pointerdown', e => { if (e.button || e.target.closest('button')) return; from = e.clientX; stage.classList.add('tabdrag'); addEventListener('pointerup', end); addEventListener('pointercancel', stop); }, { signal });
    },
  };
  head.querySelector('[data-side-swap]')?.addEventListener('click', api.swap, { signal });
  head.querySelector('[data-side-close]')?.addEventListener('click', () => cur && api.close(cur.slot), { signal });
  el.addEventListener('keydown', e => { if (e.key === 'Escape' && full()) { e.stopPropagation(); api.back(); } }, { signal });
  api.tab(head.querySelector('.stab'), 'side');
  mq.addEventListener('change', apply, { signal });
  const watch = new ResizeObserver(() => { if (shown()) apply(); }); watch.observe(stage); // the window changed: the clamp is read again, never saved
  signal?.addEventListener('abort', () => watch.disconnect());
  return api;
}
