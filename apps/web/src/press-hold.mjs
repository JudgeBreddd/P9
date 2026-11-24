// O247: a list redrawn while a mouse button or finger is down on it loses the click. The row pressed is replaced or moved,
// or another row slides under the pointer, and the release lands somewhere else. held() asks to skip a redraw while a press
// on a button or row is down; the list redraws once, after the press's click has run. Only the press's own pointer ends it
// (a second finger does not), or a cancel (the browser took the touch for a scroll), or the window losing focus. A release
// with no click after it (a drag, a slide off the row) ends it 500 ms later; a click that waits on double-tap zoom comes
// sooner than that. The desktop's left panel and the phone's chat list.
// ponytail: a press held over 10 s (a release the window never saw) lets redraws through again.
export function pressHold(el, redraw, signal) {
  let id = null, owed = false, t = 0;
  const end = () => { clearTimeout(t); if (id === null) return; id = null; if (owed) { owed = false; setTimeout(redraw); } };
  const on = (type, f, at = window) => at.addEventListener(type, f, { signal });
  on('pointerdown', e => { if (e.isPrimary && !e.button && e.target.closest('button, [data-chat]')) { clearTimeout(t); id = e.pointerId; t = setTimeout(end, 1e4); } }, el);
  on('pointerup', e => { if (e.pointerId === id) { clearTimeout(t); t = setTimeout(end, 500); } });
  on('pointercancel', e => e.pointerId === id && end());
  on('click', end); // bubbles here after the list's own click handler
  on('blur', end);
  return () => id !== null && (owed = true);
}
