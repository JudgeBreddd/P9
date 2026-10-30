// The phone's service worker (threat model row SW, c23): it keeps only the build's hashed files (/_astro/<name>, named by
// their content, so a name never changes what it holds) and serves them from its cache first, so a reopen does not
// download the app again when the browser has dropped its own cache. The page, sign-in, every API answer, images and
// anything with a query go to the network untouched; nothing signed-in is kept. The page registers /sw.js?v=<its own
// build file>, so a new build installs a new worker, whose activate deletes every older cache.
const CACHE = 'p9-phone-' + (new URL(location.href).searchParams.get('v') || '0');
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys()
  .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  .then(() => self.clients.claim())));
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
  }));
});
