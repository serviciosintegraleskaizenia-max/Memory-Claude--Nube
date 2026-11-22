// Service worker del panel: muestra los avisos (reservas, cambios, mensajes del chat) aunque el panel esté cerrado.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Cada aviso: se muestra como notificación de Windows y queda en la campanita del panel.
// Si el panel está abierto, se le manda el aviso; si no, se guarda para cuando vuelva a abrirse.
self.addEventListener('push', e => {
  let datos = { titulo: 'Zentralia', cuerpo: '', url: '/' };
  try { datos = Object.assign(datos, e.data ? e.data.json() : {}); } catch (err) { /* aviso sin formato: se muestra igual */ }
  e.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (ventanas.length) {
      ventanas.forEach(w => w.postMessage({ tipo: 'aviso-push', datos }));
    } else {
      const c = await caches.open('avisos-pendientes');
      const previa = await c.match('lista');
      const lista = previa ? await previa.json() : [];
      lista.unshift(datos);
      await c.put('lista', new Response(JSON.stringify(lista.slice(0, 50)), { headers: { 'Content-Type': 'application/json' } }));
    }
    await self.registration.showNotification(datos.titulo, {
      body: datos.cuerpo,
      tag: 'zentralia-' + Date.now(),
      data: { url: datos.url || '/' }
    });
  })());
});

// El panel pide los avisos guardados cuando se abre.
self.addEventListener('message', e => {
  if (!e.data || e.data.tipo !== 'pedir-pendientes') return;
  e.waitUntil((async () => {
    const c = await caches.open('avisos-pendientes');
    const previa = await c.match('lista');
    const lista = previa ? await previa.json() : [];
    await c.delete('lista');
    if (e.ports && e.ports[0]) e.ports[0].postMessage(lista);
  })());
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
