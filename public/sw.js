// Сервис-воркер «Дороги»: сначала сеть (всегда свежая версия), при отсутствии сети — кеш.
const CACHE = 'doroga-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('/api/records')) return;
  const network = fetch(req);
  e.waitUntil(network.then((res) => {
    if (!res.ok) return;
    const copy = res.clone();
    return caches.open(CACHE).then((cache) => cache.put(req, copy));
  }).catch(() => undefined));
  e.respondWith(network.catch(async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') return await caches.match('./') || Response.error();
    return Response.error();
  }));
});
