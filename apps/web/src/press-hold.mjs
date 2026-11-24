// O247: a list redrawn while a mouse button or finger is down on it loses the click. The row pressed is replaced or moved,
// or another row slides under the pointer, and the release lands somewhere else. held() asks to skip a redraw while a press
// is down; the list redraws once the press ends, after its click has run. The desktop's left panel and the phone's chat list.
// ponytail: a press held over 2 s (a long press, or a release the window never saw) lets redraws through again.
export function pressHold(el, redraw, signal) {
  let down = 0, owed = false;
  const up = () => { clearTimeout(down); if (!down) return; down = 0; if (owed) { owed = false; setTimeout(redraw); } };
  el.addEventListener('pointerdown', () => { clearTimeout(down); down = setTimeout(up, 2000); }, { signal });
  for (const t of ['pointerup', 'pointercancel', 'blur']) addEventListener(t, up, { signal });
  return () => !!down && (owed = true);
}
