// O247: a list redrawn while a mouse button or finger is down on it loses the click. The row pressed is replaced or moved,
// or another row slides under the pointer, and the release lands somewhere else. held() asks to skip a redraw while a press
// on a button or row is down; the list redraws once, after the press's click has run. Only the press's own pointer ends it:
// its release and then a click (a key's click while it is down does not), its cancel (the browser took the touch for a
// scroll), or the window losing focus. A second finger or mouse neither takes over nor ends it. A release with no click
// after it (a drag, a slide off the row) ends it 500 ms later; a click that waits on double-tap zoom comes sooner than that.
// The desktop's left panel and the phone's chat list.
// ponytail: a press held over 10 s (a release the window never saw) lets redraws through again.
export function pressHold(el, redraw, signal) {
  let id = null, up = false, owed = false, t = 0;
  const end = () => { clearTimeout(t); if (id === null) return; id = null; if (owed) { owed = false; setTimeout(redraw); } };
  const on = (type, f, at = window) => at.addEventListener(type, f, { signal });
  on('pointerdown', e => { if ((id === null || up) && e.isPrimary && !e.button && e.target.closest('button, [data-chat]')) { clearTimeout(t); id = e.pointerId; up = false; t = setTimeout(end, 1e4); } }, el);
  on('pointerup', e => { if (e.pointerId === id) { up = true; clearTimeout(t); t = setTimeout(end, 500); } });
  on('pointercancel', e => e.pointerId === id && end());
  on('click', e => up && e.pointerId === id && end()); // its own click, after the list's handler; any other waits on the fallback
  on('blur', end);
  return () => id !== null && (owed = true);
}
// The same end for one press already down (e: its pointerdown), for something that must wait until that press's click has
// run: done runs once, after it. The quote box keeps a typed comment as a chip only then (adding it on the press redrew
// the button pressed, so Stop became Steer, or a chip's pencil or ✕ did nothing).
export function afterPress(e, done) {
  const ac = new AbortController(), signal = ac.signal;
  let up = false, t = setTimeout(end, 1e4);
  function end() { if (signal.aborted) return; ac.abort(); clearTimeout(t); setTimeout(done); }
  const on = (type, f) => window.addEventListener(type, f, { signal });
  on('pointerup', u => { if (u.pointerId === e.pointerId) { up = true; clearTimeout(t); t = setTimeout(end, 500); } });
  on('pointercancel', c => c.pointerId === e.pointerId && end());
  on('click', c => up && c.pointerId === e.pointerId && end());
  on('blur', end);
}
