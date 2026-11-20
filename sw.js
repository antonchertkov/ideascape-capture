importScripts('core.js');

const CACHE = 'capture-v1';
const SHELL = ['./', 'index.html', 'core.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // Android "Share → Capture": stash what was shared, then open the capture screen.
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const fd = await req.formData();
      await sharedPut({
        title: fd.get('title') || '',
        text: fd.get('text') || '',
        url: fd.get('url') || '',
        files: fd.getAll('media').filter(f => f instanceof File),
      });
      return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
    return hit || (await fresh) || Response.error();
  })());
});

self.addEventListener('sync', e => {
  if (e.tag === 'flush') {
    e.waitUntil(flushOutbox().then(r => { if (r.left) throw new Error('retry'); }));
  }
});
