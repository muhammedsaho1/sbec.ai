// SBEC AI service worker — makes the app installable and fast to open.
// The offline voice is kept by the voice worker in Cache Storage ("transformers-cache", "kokoro-voices").
const CACHE = 'sbec-shell-v3';
const ENGINE = 'sbec-voice-engine';
const SHELL = ['/', '/index.html', '/tts-worker.js', '/vendor/kokoro.web.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/sbec-logo.webp'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('sbec-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // The voice engine's own files (from jsDelivr): keep a copy so the offline voice works without internet.
  if (url.origin === 'https://cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@huggingface/transformers@')) {
    e.respondWith(caches.open(ENGINE).then((c) => c.match(e.request.url).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok) c.put(e.request.url, r.clone());
      return r;
    }))));
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/voice/')) return;
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
