// O249: an agent's picture comes as its place (shot:<cursor/n>, chat.events with shots) and is fetched when it comes within a
// screen of its chat's scroller. The desktop loads this file with the first chat that has one (chat-view.mjs), so startup
// carries none of it; the phone uses the same store and watcher.
import { imgSrc } from './helpers.mjs';

// The pictures fetched, keyed by chat and place ('' when gone: 404, or data that is not a picture); busy holds the ones being
// fetched. Past max bytes of base64 the oldest seen go first, but never a chat on screen (live: each scroller's chat), so
// pictures in view can't push each other out and refetch in a loop (ponytail: one view's pictures may pass max; a dropped
// one is fetched again when next seen).
export function shotStore(max = 64e6) {
  const m = new Map(), busy = new Set(), live = new Map(); let bytes = 0;
  const drop = (k) => { bytes -= m.get(k).length; m.delete(k); };
  return {
    busy, live,
    has: (k) => m.has(k) || busy.has(k),
    get(k) { const v = m.get(k); if (v) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) {
      if (m.has(k)) drop(k);
      m.set(k, v); bytes += v.length; if (bytes <= max) return;
      const shown = new Set(); for (const [root, id] of live) if (root.isConnected) shown.add(id); else live.delete(root);
      for (const old of m.keys()) { if (bytes <= max) break; if (!shown.has(old.slice(0, old.indexOf('/')))) drop(old); }
    },
  };
}

// One observer for one scroller (root). watch(id, list) watches list's placeholders for chat id, letting the last list's go.
// A placeholder stays watched until its picture lands, so a failed fetch, or one with no answer in 30 s, tries again when it
// next comes into view or the chat redraws. get(id, place) resolves the picture ({mimeType, data}), null when it is gone, or
// rejects to try again; landed(id) redraws. The margin is fixed pixels (about a screen and a half), not a percentage.
export function shotWatcher(root, store, get, landed) {
  const chatOf = new WeakMap();
  const seen = new IntersectionObserver((hits) => hits.forEach(({ isIntersecting, target }) => {
    const id = chatOf.get(target), key = id + '/' + target.dataset.shot;
    if (!isIntersecting || !id || !target.isConnected || store.has(key)) return; // isConnected: an entry queued before a redraw
    store.busy.add(key);
    Promise.race([get(id, target.dataset.shot), new Promise((ok, no) => setTimeout(no, 30000))]).then((image) => {
      const src = image && imgSrc({ type: 'image', mimeType: image.mimeType, data: image.data });
      store.set(key, src || ''); if (src) landed(id);
    }).catch(() => {}).finally(() => store.busy.delete(key));
  }), { root, rootMargin: '1000px 0px' });
  return (id, list) => { store.live.set(root, id); seen.disconnect(); list.querySelectorAll('img[data-shot]:not([src])').forEach((img) => { chatOf.set(img, id); seen.observe(img); }); };
}

// The desktop's: one watcher per chat's scroller (.hist), fetched over the bridge from whichever machine the window is on;
// render(Set of chat ids) redraws those chats.
export function installShots(render) {
  const landed = (id) => render(new Set([id]));
  const store = shotStore(), watchers = new WeakMap();
  const get = (id, shot) => window.p9.chat('shot', { id, shot }).then((r) => (r.status === 200 ? r.body : r.status === 404 ? null : Promise.reject(r.status)));
  return {
    src: (id, src) => store.get(id + '/' + src.slice(5)),
    watch(id, h) { let w = watchers.get(h); if (!w) watchers.set(h, w = shotWatcher(h, store, get, landed)); w(id, h); },
  };
}
