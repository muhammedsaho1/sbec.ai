// SBEC AI service worker — makes the app installable, fast to open, and usable offline.
// SBEC Voice keeps its voice in Cache Storage ("sbec-voice"); its engine files are kept here ("sbec-voice-engine").
const CACHE = 'sbec-shell-v4';
const ENGINE = 'sbec-voice-engine';
const SHELL = ['/', '/index.html', '/sbec-voice.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/sbec-logo.webp'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((k) => (k.startsWith('sbec-shell-') && k !== CACHE) || k === 'transformers-cache' || k === 'kokoro-voices')
    .map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/voice/')) return;
  // Voice engine files: keep a copy the first time, so SBEC Voice works offline.
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.open(ENGINE).then((c) => c.match(url.pathname).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) c.put(url.pathname, r.clone());
      return r;
    }))));
    return;
  }
  if (e.request.mode === 'navigate') {
    // network first for the page, fall back to cache when offline
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put('/', c)); return r; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok && SHELL.includes(url.pathname)) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); }
    return r;
  })));
});
