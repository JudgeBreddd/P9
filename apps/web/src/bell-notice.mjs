// 733 (Tyler, 2026-11-14: "show up as a normal notification and go to the bell like all the other notifications"): an agent
// asking, an item waiting on you and a finished agent are bell rows (controller.mjs cardList marks them quiet). Each one new
// since the chats loaded shows once as a notice at the bottom right; a click opens it as its card did. The ones there when
// the window opened go to the bell with no notice. Loaded by renderCards (cards-modal.mjs) with the first such item, so the
// shell does not carry it at startup.
let seen;
// ponytail: the three bell kinds are the only cards whose key has a ':' ('asks:<chat+ask>,…', 'reviews:<file>,…', 'done:<chat>');
// a waiting file whose name has a ',' counts as two items, which only means its notice still shows once.
const items = c => { const [kind, rest] = c.key.split(/:(.*)/s); return rest.split(',').map(i => kind + ':' + i); };
// began: false on the first draw after the chats loaded, so what is there then is old.
export function notice(cards, began, toast, open) {
  const bell = cards.filter(c => c.key.includes(':')), old = seen ?? (began ? new Set() : null);
  seen = new Set(bell.flatMap(items)); // before the toast: toast redraws the cards, which calls this again
  if (old) for (const c of bell) if (items(c).some(i => !old.has(i))) {
    toast({ kind: c.sub, txt: c.title, level: 'ok' }, true); // done: the bell row is the kept copy, not an alert
    document.getElementById('toasts').lastElementChild.onclick = () => open(c, 'open');
  }
}
