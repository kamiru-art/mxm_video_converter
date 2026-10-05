// Reemplaza al service worker de la app en mxm.sebastianlopez.me. El
// navegador vuelve a pedir /sw.js en cada visita y, al ver uno distinto,
// instala este: borra las cachés de la app vieja y se da de baja, para que
// ese dominio deje de abrir una copia guardada de la app sin conexión.
// No tiene manejador de fetch: mientras siga activo, todo va a la red.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
    })(),
  );
});
