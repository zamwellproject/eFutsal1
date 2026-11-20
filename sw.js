const CACHE_NAME = 'efutsal-arena-v2';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './js/utils.js',
  './js/data.js',
  './js/input.js',
  './js/physics.js',
  './js/ai.js',
  './js/renderer.js',
  './js/network.js',
  './js/engine.js',
  './js/main.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});


self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('efutsal-arena-') && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});


self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    // Cache the pinned PeerJS script after a successful fetch. Offline cache is
    // used only as a fallback; external connectivity is still needed online.
    if (url.hostname === 'unpkg.com' && url.pathname.includes('/peerjs@1.5.4/')) {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const fresh = await fetch(event.request);
          if (fresh && (fresh.ok || fresh.type === 'opaque')) await cache.put(event.request, fresh.clone());
          return fresh;
        } catch {
          const cached = await cache.match(event.request);
          if (cached) return cached;
          return new Response('PeerJS offline and not cached.', { status: 503, statusText: 'Offline' });
        }
      })());
    }
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const fresh = await fetch(event.request);
      if (fresh && fresh.ok) cache.put(event.request, fresh.clone());
      return fresh;
    } catch {
      if (event.request.mode === 'navigate') return cache.match('./index.html');
      return new Response('Offline asset unavailable.', { status: 503, statusText: 'Offline' });
    }
  })());
});
