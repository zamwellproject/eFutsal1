const CACHE_NAME = 'efutsal-arena-v3';
const CORE_ASSETS = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './js/utils.js', './js/data.js', './js/input.js', './js/physics.js',
  './js/ai.js', './js/renderer.js', './js/network.js', './js/engine.js', './js/main.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then((cache) => cache.addAll(CORE_ASSETS))
    .catch((error) => console.warn('Precache incomplete:', error)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('efutsal-arena-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isNavigation = event.request.mode === 'navigate';
  const isAppCode = /\.(?:html|js|css|json|webmanifest)$/.test(url.pathname);

  // Network-first for app code prevents stale JavaScript after GitHub Pages uploads.
  if (isNavigation || isAppCode) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(event.request, { cache: 'no-store' });
        if (fresh && fresh.ok) await cache.put(event.request, fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        if (isNavigation) {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response('Aset aplikasi tidak tersedia saat offline.', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // Cache-first for non-code assets such as icons.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const fresh = await fetch(event.request);
      if (fresh && fresh.ok) await cache.put(event.request, fresh.clone());
      return fresh;
    } catch {
      return new Response('Aset offline tidak tersedia.', { status: 503 });
    }
  })());
});
