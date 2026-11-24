// O249: an agent's picture comes as its place (shot:<cursor/n>, chat.events with shots) and is fetched when it comes within a
// screen of its chat's scroller. The desktop loads this file with the first chat that has one (chat-view.mjs), so startup
// carries none of it; the phone uses the same store and watcher.
import { imgSrc } from './helpers.mjs';

// The pictures fetched, keyed by chat and place: '' while fetching or gone (404, or data that is not a picture). Oldest seen
// first out past max bytes of base64 (ponytail: one budget for all chats; a dropped one is fetched again when next seen).
export function shotStore(max = 64e6) {
  const m = new Map(); let bytes = 0;
  const drop = (k) => { bytes -= m.get(k)?.length ?? 0; m.delete(k); };
  return {
    has: (k) => m.has(k),
    get(k) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { drop(k); m.set(k, v); bytes += v.length; for (const old of m.keys()) { if (bytes <= max || old === k) break; drop(old); } },
    delete: drop,
  };
}

// One observer for one scroller (root). watch(id, list) watches list's placeholders for chat id, letting the last list's go.
// A placeholder stays watched until its picture lands, so a failed fetch tries again when it next scrolls into view. get(id,
// place) resolves the picture ({mimeType, data}), null when it is gone, or rejects to try again; landed(id) redraws.
export function shotWatcher(root, store, get, landed) {
  const chatOf = new WeakMap();
  const seen = new IntersectionObserver((hits) => hits.forEach(({ isIntersecting, target }) => {
    const id = chatOf.get(target), key = id + '/' + target.dataset.shot;
    if (!isIntersecting || !id || !target.isConnected || store.has(key)) return; // isConnected: an entry queued before a redraw
    store.set(key, '');
    get(id, target.dataset.shot).then((image) => {
      const src = image && imgSrc({ type: 'image', mimeType: image.mimeType, data: image.data });
      store.set(key, src || ''); if (src) landed(id);
    }, () => store.delete(key));
  }), { root, rootMargin: '100% 0px' });
  return (id, list) => { seen.disconnect(); list.querySelectorAll('img[data-shot]:not([src])').forEach((img) => { chatOf.set(img, id); seen.observe(img); }); };
}

// The desktop's: one watcher per chat's scroller (.hist), fetched over the bridge from whichever machine the window is on.
export function installShots(landed) {
  const store = shotStore(), watchers = new WeakMap();
  const get = (id, shot) => window.p9.chat('shot', { id, shot }).then((r) => (r.status === 200 ? r.body : r.status === 404 ? null : Promise.reject(r.status)));
  return {
    src: (id, src) => store.get(id + '/' + src.slice(5)),
    watch(id, h) { let w = watchers.get(h); if (!w) watchers.set(h, w = shotWatcher(h, store, get, landed)); w(id, h); },
  };
}
