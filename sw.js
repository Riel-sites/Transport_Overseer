/* Transport Roster — service worker.
   Strategy:
   • HTML/navigation → network-first (fresh copy on every online visit).
     Falls back to cache when offline.
   • Other same-origin GETs → stale-while-revalidate (fast + auto-refreshed).
   • Cross-origin requests → passed through untouched (Supabase CDN, etc.).

   CACHE only needs bumping for breaking format changes (e.g. renaming a
   precached asset). Shipping a new index.html or sync.js requires no bump —
   network-first picks up the new version on the next online load. */

const CACHE = 'transport-roster-v12';
const SHELL = ['./', './index.html', './manifest.webmanifest', './sync.js'];

/* ---- install: precache shell, activate immediately ---- */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ---- activate: drop old caches, take control ---- */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---- page-controlled activation (used by the "Reload" toast) ---- */
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ---- fetch routing ---- */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Cross-origin: let the browser handle it (Supabase CDN, etc.)
  if (url.origin !== location.origin) return;

  // HTML & navigations → network-first
  const isHTML =
    e.request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('/');
  if (isHTML) {
    e.respondWith(networkFirst(e.request, './index.html'));
    return;
  }

  // Everything else same-origin → stale-while-revalidate
  e.respondWith(staleWhileRevalidate(e.request));
});

/* ---- strategies ---- */
async function networkFirst(request, fallbackUrl){
  try {
    const fresh = await fetch(request, { cache: 'no-cache' });
    if (fresh.ok) {
      const copy = fresh.clone();
      caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
    }
    return fresh;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response('Offline — this page has not been cached yet.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function staleWhileRevalidate(request){
  const cached = await caches.match(request);
  const networkPromise = fetch(request)
    .then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (cached) {
    networkPromise.catch(() => {});   // background refresh, ignore errors
    return cached;
  }

  const fresh = await networkPromise;
  if (fresh) return fresh;

  // Last-ditch fallbacks for missing offline assets
  if (request.destination === 'script') {
    return new Response('console.warn("sync.js unavailable offline");', {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  return new Response('', { status: 504, statusText: 'Offline' });
}
