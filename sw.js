// Service worker: la app abre sin internet. Primero red (con límite de 3 s), si no, copia guardada.
// La API nunca pasa por la caché.
const CACHE = 'acta-v5';
const SHELL = ['./', './index.html', './core.js?v=5', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(req), timeout(5000)]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      // Coincidencia exacta (core.js?v=N va siempre con su index.html): nunca se mezclan versiones.
      const hit = req.mode === 'navigate'
        ? (await cache.match(req, { ignoreSearch: true }) || await cache.match('./index.html'))
        : await cache.match(req);
      return hit || new Response('Sin conexión', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});
