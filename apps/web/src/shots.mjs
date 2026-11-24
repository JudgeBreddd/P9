// O249: an agent's picture comes as its place (shot:<cursor/n>, chat.events with shots) and is fetched when it comes near the
// view in its chat's scroller. The desktop loads this file with the first chat that has one (chat-view.mjs), so startup
// carries none of it; the phone uses the same watcher.
import { imgSrc } from './helpers.mjs';

// One observer for one scroller (root). watch(id, got, list) watches list's placeholders of chat id, letting the last list's
// go; a picture lands in got (a Map, its src shot:<place> -> data: address, '' when gone: 404, or data that is not a picture). A place is a
// ledger cursor, so it names one picture across chats. got belongs to the chat (the desktop's session, the phone's open
// chat), so pictures go with their chat: no cap, at most what the chat's events held inline before O249.
// A placeholder stays watched until its picture lands, so a failed fetch tries again when it next comes into view or the
// chat redraws. One with no answer in 120 s lets a new try start, but still lands if its answer comes (a slow link is not
// thrown away). get(id, place) resolves {mimeType, data}, null when gone, or rejects; landed(id) redraws.
// The margin is fixed pixels (about a screen and a half), not a percentage.
export function shotWatcher(root, get, landed) {
  const busy = new Set(), of = new WeakMap();
  const seen = new IntersectionObserver((hits) => hits.forEach(({ isIntersecting, target }) => {
    const [id, got] = of.get(target) ?? [], place = target.dataset.shot, key = 'shot:' + place;
    if (!isIntersecting || !got || !target.isConnected || got.has(key) || busy.has(place)) return; // isConnected: queued before a redraw
    busy.add(place);
    const done = get(id, place).then((image) => {
      const src = image && imgSrc({ type: 'image', mimeType: image.mimeType, data: image.data });
      got.set(key, src || ''); if (src) landed(id);
    });
    Promise.race([done, new Promise((ok) => setTimeout(ok, 120000))]).catch(() => {}).finally(() => busy.delete(place));
  }), { root, rootMargin: '1000px 0px' });
  return (id, got, list) => { seen.disconnect(); list.querySelectorAll('img[data-shot]:not([src])').forEach((img) => { of.set(img, [id, got]); seen.observe(img); }); };
}

// The desktop's: one watcher per chat's scroller (.hist), fetched over the bridge from whichever machine the window is on,
// into the chat's own s.shots; render(Set of chat ids) redraws those chats.
export function installShots(render) {
  const watchers = new WeakMap();
  const get = (id, shot) => window.p9.chat('shot', { id, shot }).then((r) => (r.status === 200 ? r.body : r.status === 404 ? null : Promise.reject(r.status)));
  return { watch: (s, h) => { let w = watchers.get(h); if (!w) watchers.set(h, w = shotWatcher(h, get, (id) => render(new Set([id])))); w(s.id, s.shots ||= new Map(), h); } };
}
