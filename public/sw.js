const CACHE = 'blockhead-v8';

// Only these are cached aggressively: they're large and they don't change
// between releases. Everything else goes to the network first.
const IMMUTABLE = [
  'words.txt', 'starters5.txt', 'starters3.txt',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, not addAll(): addAll is all-or-nothing, so a single 404
    // would fail the install and leave the PREVIOUS worker serving stale files
    // indefinitely.
    await Promise.all(IMMUTABLE.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch anything off this origin. Firestore polling runs through here,
  // and serving a cached reply to a poll means the opponent's move is never
  // seen — the game waits forever on a turn that already happened.
  if (url.origin !== self.location.origin) return;

  const path = url.pathname.replace(/^\/+/, '');
  if (IMMUTABLE.some((name) => path.endsWith(name))) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // App shell: network first, so a deploy is visible on the next load. The
  // cache is only a fallback for being offline.
  e.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(CACHE);
    cache.put(req, res.clone()).catch(() => {});
  }
  return res;
}

async function networkFirst(req) {
  try {
    const res = await withTimeout(fetch(req), 5000);
    if (res && res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw new Error(`offline and nothing cached for ${req.url}`);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}
