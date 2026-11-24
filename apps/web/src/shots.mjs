// O249: an agent's picture comes as its place (shot:<cursor/n>, chat.events with shots) and is fetched when it comes near the
// view in its chat's scroller. The desktop loads this file with the first chat that has one (chat-view.mjs), so startup
// carries none of it; the phone uses the same watcher.
import { imgSrc } from './helpers.mjs';

// One observer for one scroller (root). watch(id, got, list) watches list's placeholders of chat id, letting the last list's
// go. got belongs to the chat (the desktop's session, the phone's open chat), keyed by the picture's src (shot:<place>, a
// ledger cursor, so one picture across chats): undefined while its fetch is out, so a second one for it cannot start, from
// any scroller showing that chat; then a data: address, or '' when gone (404, or data that is not a picture). A failed
// fetch, or a reply with no data (a body cut off), clears its key, so it tries again when it next comes into view or the
// chat redraws. get(id, place) resolves {mimeType, data}, null when gone, or rejects, and ends on its own
// (the desktop's socket timeout, the phone's 120 s abort); landed(id) redraws. The margin is fixed pixels, about a screen
// and a half, not a percentage.
export function shotWatcher(root, get, landed) {
  const of = new WeakMap();
  const seen = new IntersectionObserver((hits) => hits.forEach(({ isIntersecting, target }) => {
    const [id, got] = of.get(target) ?? [], place = target.dataset.shot, key = 'shot:' + place;
    if (!isIntersecting || !got || !target.isConnected || got.has(key)) return; // isConnected: queued before a redraw
    got.set(key, undefined);
    Promise.resolve().then(() => get(id, place)).then((image) => { // a throw before get's promise clears the mark too
      if (image && typeof image.data != 'string') throw 0;
      const src = image && imgSrc({ type: 'image', mimeType: image.mimeType, data: image.data });
      if (got.has(key)) { got.set(key, src || ''); if (src) landed(id); }
    }).catch(() => { if (got.get(key) === undefined) got.delete(key); });
  }), { root, rootMargin: '1000px 0px' });
  return (id, got, list) => {
    seen.disconnect(); list.querySelectorAll('img[data-shot]:not([src])').forEach((img) => { of.set(img, [id, got]); seen.observe(img); });
  };
}

// The desktop's: one watcher per chat's scroller (.hist), fetched over the bridge from whichever machine the window is on,
// into the chat's own s.shots; render(Set of chat ids) redraws those chats. Each paint of a chat holding pictures drops the
// ones its events no longer name (a tool's replaced picture), so a chat holds at most its events' pictures; a chat holding
// none (text only) is not scanned. ponytail: the scan is the chat's loaded events per paint; exact tracking would sit in
// chat-view's tool update, which is startup code at its byte budget.
export function installShots(render) {
  const watchers = new WeakMap();
  const get = (id, shot) => window.p9.chat('shot', { id, shot }).then((r) => (r.status === 200 ? r.body : r.status === 404 ? null : Promise.reject(r.status)));
  return { watch: (s, h) => {
    let w = watchers.get(h); if (!w) watchers.set(h, w = shotWatcher(h, get, (id) => render(new Set([id]))));
    const got = s.shots ||= new Map();
    if (got.size) { const named = new Set(s.events.flatMap((e) => e.images || [])); for (const key of got.keys()) if (!named.has(key)) got.delete(key); }
    w(s.id, got, h);
  } };
}
