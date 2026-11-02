// Offline-first: serve from cache, fall back to network and keep a copy.
const CACHE = 'sitetalk-v1';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/scoring.js', 'js/whisper.js', 'js/melfb.json', 'manifest.json',
  'data/lessons.json', 'data/audio_index.json', 'data/sounds.json', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
const FRESH = /\/(index\.html|data\/[^/]+\.json|js\/[^/]+\.js|css\/[^/]+\.css)$|\/$/;
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url); url.search = '';
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(url.href) || await c.match(req, { ignoreSearch: true });
    // App code and lesson data: try the network first (to get updates), cache as fallback.
    if (FRESH.test(url.pathname)) {
      try { const r = await fetch(req); if (r.ok) c.put(url.href, r.clone()); return r; } catch { if (hit) return hit; throw new Error('offline'); }
    }
    if (hit) return hit;
    const r = await fetch(req);
    if (r.ok && r.status === 200) c.put(url.href, r.clone());
    return r;
  })());
});
