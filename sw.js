/* Transport Roster — service worker.
   Strategy:
   • HTML/navigation → network-first (fresh copy on every online visit).
   • Other same-origin GETs → stale-while-revalidate.
   • Cross-origin → untouched.

   Update flow:
   • install → precache shell. Do NOT skipWaiting — the new SW sits in
     "waiting" state until the user explicitly taps Reload.
   • message SKIP_WAITING → activate immediately (triggered from index.html).
   • activate → drop old caches, clients.claim() so controllerchange fires.

   CACHE only needs bumping when SHELL contents change (assets added,
   removed, renamed). HTML/JS deploys propagate via network-first. */

const CACHE = 'transport-roster-v12';
const SHELL = ['./', './index.html', './manifest.webmanifest', './sync.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
    // No skipWaiting() — the new SW waits until the page sends SKIP_WAITING.
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  const isHTML =
    e.request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('/');
  if (isHTML) {
    e.respondWith(networkFirst(e.request, './index.html'));
    return;
  }
  e.respondWith(staleWhileRevalidate(e.request));
});

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
      status: 503, statusText: 'Offline',
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

  if (cached) { networkPromise.catch(() => {}); return cached; }

  const fresh = await networkPromise;
  if (fresh) return fresh;

  if (request.destination === 'script') {
    return new Response('console.warn("sync.js unavailable offline");', {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  return new Response('', { status: 504, statusText: 'Offline' });
}
