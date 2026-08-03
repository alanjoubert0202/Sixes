/* eslint-disable no-undef */
/**
 * Sixes service worker.
 *
 * Generated at build time by scripts/gen-sw.mjs, which substitutes the two
 * placeholders below with the real hashed asset list and a content-derived
 * version, so a new build busts the cache automatically. The whole app shell is
 * precached, which is what makes the game playable with no network at all.
 */
const VERSION = '__VERSION__';
const CACHE = `sixes-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll is all-or-nothing; adding one at a time means a single 404 does
      // not leave the app with no offline copy at all.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            /* keep going — the runtime cache will pick it up later */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so a deploy is picked up promptly, but fall
  // back to the cached shell the moment the network is unavailable or slow.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put('/index.html', fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  // Everything else is a hashed build asset or an icon: cache first.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const fresh = await fetch(request);
        if (fresh.ok && fresh.type === 'basic') cache.put(request, fresh.clone());
        return fresh;
      } catch {
        return hit || Response.error();
      }
    })(),
  );
});
