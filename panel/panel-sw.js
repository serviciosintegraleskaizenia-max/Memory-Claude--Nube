// Service worker del panel: muestra los avisos (reservas, cambios, mensajes del chat) aunque el panel esté cerrado.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let datos = { titulo: 'Zentralia', cuerpo: '', url: '/' };
  try { datos = Object.assign(datos, e.data ? e.data.json() : {}); } catch (err) { /* aviso sin formato: se muestra igual */ }
  e.waitUntil(self.registration.showNotification(datos.titulo, {
    body: datos.cuerpo,
    tag: 'zentralia-' + Date.now(),
    data: { url: datos.url || '/' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abiertas) { if ('focus' in c) { await c.focus(); return; } }
    await self.clients.openWindow(url);
  })());
});
