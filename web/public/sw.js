// Service worker de MXM Studio: la app se instala como programa de escritorio
// y sigue funcionando sin conexión.
//
// No hay lista de precarga con los nombres de los archivos compilados: Vite
// les pone un hash en cada build y mantenerla a mano se desincroniza sola.
// En su lugar se cachea lo que el navegador realmente pide (el núcleo WASM,
// los workers, los trozos de ffmpeg, las tipografías) y a partir de la
// segunda visita todo eso ya está guardado. El HTML va por red primero, así
// una versión nueva se recoge en cuanto hay conexión.

const VERSION = 'mxm-v1';
const SHELL = `${VERSION}-shell`;   // documento de entrada
const ASSETS = `${VERSION}-assets`; // JS, CSS, WASM, imágenes propias
const FONTS = `${VERSION}-fonts`;   // Google Fonts (respuestas opacas)

const FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add('/')).catch(() => {}));
  // sin skipWaiting: una versión nueva toma el relevo en la siguiente
  // visita, no a mitad de un proyecto abierto (los módulos ya cargados
  // seguirían pidiendo los archivos de la versión anterior)
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, ASSETS, FONTS]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

/** Guarda una copia de la respuesta si sirve para volver a servirla.
 *  `copy` tiene que venir clonada por quien llama, ANTES de devolver la
 *  original: para cuando esta función llega a usarla, el navegador ya puede
 *  estar leyendo el cuerpo y clonar entonces lanzaría. */
async function put(cacheName, request, copy, usable) {
  if (!copy || !usable) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, copy);
  } catch {
    /* sin cuota, modo incógnito o petición no cacheable: la app sigue igual */
  }
}

function isUsable(cacheName, response) {
  if (!response) return false;
  if (cacheName === FONTS) return response.ok || response.type === 'opaque';
  if (!response.ok) return false;
  // El sitio se sirve con not_found_handling=single-page-application: un
  // archivo que falte devuelve el index.html con estado 200. Guardar ESO bajo
  // la URL de un script o del .wasm dejaría la caché envenenada, así que un
  // asset que llega como HTML no se guarda.
  if (cacheName === ASSETS && /^text\/html/i.test(response.headers.get('content-type') ?? '')) {
    return false;
  }
  return true;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = FONT_HOSTS.includes(url.origin);
  if (!sameOrigin && !isFont) return; // nada más se intercepta

  // Documentos: red primero (para recoger versiones nuevas), caché si no hay.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const ok = isUsable(SHELL, net);
        put(SHELL, '/', ok ? net.clone() : null, ok);
        return net;
      } catch {
        return (await caches.match('/')) ?? (await caches.match(req)) ?? Response.error();
      }
    })());
    return;
  }

  // Todo lo demás: caché primero (los assets llevan hash en el nombre), y se
  // refresca en segundo plano por si el servidor cambió algo sin hash.
  e.respondWith((async () => {
    const cacheName = isFont ? FONTS : ASSETS;
    const hit = await caches.match(req);
    const network = fetch(req)
      .then((res) => {
        const ok = isUsable(cacheName, res);
        put(cacheName, req, ok ? res.clone() : null, ok);
        return res;
      })
      .catch(() => null);
    if (hit) return hit;
    const net = await network;
    return net ?? Response.error();
  })());
});
