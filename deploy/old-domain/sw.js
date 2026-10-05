// Reemplaza al service worker de la app en mxm.sebastianlopez.me. El
// navegador vuelve a pedir /sw.js en cada visita y, al ver uno distinto,
// instala este. Sin skipWaiting, igual que la app (src/sw.ts): espera a que
// se cierre la última pestaña de la app vieja, que puede estar a mitad de un
// proyecto y sacar de la caché sus scripts y trozos de ffmpeg. Al activarse
// borra esas cachés y se da de baja: ese dominio deja de abrir una copia
// guardada de la app sin conexión. No tiene manejador de fetch.

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
    })(),
  );
});
