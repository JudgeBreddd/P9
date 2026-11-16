// The phone's service worker (threat model row SW, c23): it keeps only the build's hashed files (/_astro/<name>, named by
// their content, so a name never changes what it holds) and serves them from its cache first, so a reopen does not
// download the app again when the browser has dropped its own cache. The page, sign-in, every API answer, images and
// anything with a query go to the network untouched; nothing signed-in is kept. The page registers /sw.js?v=<its own
// build file>, so a new build installs a new worker, whose activate deletes every older cache.
// O128 (threat model row O128): this worker's own failures go to the open phone pages, which send them to the journal.
// A failed network fetch while offline is expected, so only failures while online are told. The open page keeps only
// the error's type name and this origin's stack frames (the message is posted so the page can cut it off the stack).
const tell = (error) => { if (!navigator.onLine) return; self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((pages) => {
  for (const page of pages) page.postMessage({ p9SwError: error && typeof error === 'object'
    ? { name: String(error.name ?? ''), message: String(error.message ?? ''), stack: String(error.stack ?? '') } : { name: typeof error } });
}); };
self.addEventListener('error', (event) => tell(event.error ?? event.message));
self.addEventListener('unhandledrejection', (event) => tell(event.reason));
const CACHE = 'p9-phone-' + (new URL(location.href).searchParams.get('v') || '0');
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  .then(() => self.clients.claim()).catch((error) => { tell(error); throw error; })));
// The page asks for this when it is not controlled (it opened while this worker activated, or a hard reload). Taking
// over a page changes only where its /_astro/ files come from.
self.addEventListener('message', (event) => { if (event.data === 'claim') event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.search || !/^\/_astro\/[A-Za-z0-9_.-]+$/.test(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const response = await fetch(event.request);
    // Only a whole same-origin answer is kept: never an error, a redirect or an opaque response.
    if (response.status === 200 && response.type === 'basic' && !response.redirected) await cache.put(event.request, response.clone());
    return response;
  }).catch((error) => { tell(error); throw error; }));
});
