// Service worker de MXM Studio: la app se instala como programa de escritorio
// y sigue funcionando sin conexión.
//
// No hay lista de precarga con los nombres de los archivos compilados: Vite
// les pone un hash en cada build y mantenerla a mano se desincroniza sola.
// En su lugar se cachea lo que el navegador realmente pide (el núcleo WASM,
// los workers, los trozos de ffmpeg, las tipografías) y a partir de la
// segunda visita todo eso ya está guardado. El HTML va por red primero, así
// una versión nueva se recoge en cuanto hay conexión.
//
// Este archivo es una entrada propia de Vite (ver vite.config.ts) y sale
// como /sw.js, sin hash: main.ts lo registra por ese nombre fijo.

const sw = self as unknown as ServiceWorkerGlobalScope;

const VERSION = 'mxm-v1';
const SHELL = `${VERSION}-shell`; // documento de entrada
const ASSETS = `${VERSION}-assets`; // JS, CSS, WASM, imágenes propias
const FONTS = `${VERSION}-fonts`; // Google Fonts (respuestas opacas)

const FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

sw.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add('/'))
      .catch(() => {}),
  );
  // sin skipWaiting: una versión nueva toma el relevo en la siguiente
  // visita, no a mitad de un proyecto abierto (los módulos ya cargados
  // seguirían pidiendo los archivos de la versión anterior)
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keep = new Set([SHELL, ASSETS, FONTS]);
      for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
      await sw.clients.claim();
    })(),
  );
});

/** Guarda una copia de la respuesta si sirve para volver a servirla.
 *  `copy` tiene que venir clonada por quien llama, ANTES de devolver la
 *  original: para cuando esta función llega a usarla, el navegador ya puede
 *  estar leyendo el cuerpo y clonar entonces lanzaría. */
async function put(
  cacheName: string,
  request: RequestInfo,
  copy: Response | null,
  usable: boolean,
): Promise<void> {
  if (!copy || !usable) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, copy);
  } catch {
    /* sin cuota, modo incógnito o petición no cacheable: la app sigue igual */
  }
}

function isUsable(cacheName: string, response: Response | null | undefined): boolean {
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

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === sw.location.origin;
  const isFont = FONT_HOSTS.includes(url.origin);
  if (!sameOrigin && !isFont) return; // nada más se intercepta

  // Documentos: red primero (para recoger versiones nuevas), caché si no hay.
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          const ok = isUsable(SHELL, net);
          void put(SHELL, '/', ok ? net.clone() : null, ok);
          return net;
        } catch {
          return (await caches.match('/')) ?? (await caches.match(req)) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Todo lo demás: caché primero, y red solo si hace falta.
  e.respondWith(
    (async () => {
      const cacheName = isFont ? FONTS : ASSETS;
      const hit = await caches.match(req);
      // Lo que vive en /assets/ lleva hash en el nombre: esa URL no va a
      // cambiar nunca, así que un acierto en caché es la respuesta y no hay
      // nada que refrescar. Refrescar "por si acaso" costaba una petición al
      // origen por cada worker que el pool creaba. El resto (manifest, iconos,
      // trozos de ffmpeg, tipografías) no lleva hash y sí se refresca en
      // segundo plano.
      const hashed = sameOrigin && url.pathname.startsWith('/assets/');
      if (hit && hashed) return hit;
      const network = fetch(req)
        .then((res) => {
          const ok = isUsable(cacheName, res);
          void put(cacheName, req, ok ? res.clone() : null, ok);
          // Un asset con hash que llega como HTML es el index.html que el
          // sitio devuelve en lugar de un 404: el archivo es de una versión
          // anterior y ya no existe. Se contesta 404, que es la verdad, en
          // vez de entregar HTML a un `new Worker()` o a un import.
          if (hashed && !ok && res.ok)
            return new Response(null, { status: 404, statusText: 'Not Found' });
          return res;
        })
        .catch(() => null);
      if (hit) return hit;
      const net = await network;
      return net ?? Response.error();
    })(),
  );
});
