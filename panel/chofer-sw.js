// App del chofer: guarda la pantalla para abrirla rápido; los datos siempre se piden en vivo al servidor.
const CACHE = 'chofer-v1';
const BASICO = ['/chofer', '/iconos-op.js', '/chofer.webmanifest', '/chofer-icono.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASICO)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (!BASICO.includes(u.pathname)) return;
  // Red primero (para recibir cambios); si no hay señal, lo guardado.
  e.respondWith(fetch(e.request).then(r => { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); return r; }).catch(() => caches.match(e.request)));
});
