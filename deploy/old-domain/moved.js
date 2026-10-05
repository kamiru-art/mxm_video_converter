// mxm.sebastianlopez.me → mxmstudio.work, del lado que envía.
//
// localStorage es de cada origen: lo que el usuario guardó aquí (presets,
// perfiles de calibración, ajustes, la RAM de la fase ②) no se ve desde el
// dominio nuevo. Esta página lo lee y lo lleva en el fragmento de la URL,
// que no se manda a ningún servidor; web/src/migrate.ts lo recibe. Cada
// navegador lleva un id propio (ID_KEY), que allá se importa una sola vez.
//
// El service worker de la app vieja no se toca desde aquí: al entrar, el
// navegador revisa /sw.js, encuentra el de deploy/old-domain/sw.js y lo deja
// esperando; ese se activa cuando ya no queda ninguna pestaña de la app
// vieja abierta, y entonces borra las cachés y se da de baja. Borrarlas desde
// esta página rompería una de esas pestañas a mitad de un proyecto.
//
// Con ?export no redirige: ofrece el almacén como archivo, el mismo formato
// que "Export everything" en Calibration, para cargarlo a mano allá si la
// mudanza automática falló. Lo mismo si los datos no caben en una URL o si
// la navegación no ocurre.

const NEW_ORIGIN = 'https://mxmstudio.work';
const STORE_KEY = 'mxm-studio-v1';
const RAM_KEY = 'mxm_ram_gb';
const ID_KEY = 'mxm-migration-id';
/** Firefox no abre URLs de más de 1 MiB (Chrome, 2 MB): se deja margen. */
const MAX_URL = 900_000;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // almacenamiento bloqueado: no hay nada que llevar
  }
}

function browserId() {
  let id = read(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem(ID_KEY, id);
    } catch {
      /* sin guardar: el próximo enlace viejo traerá otro id y se importa otra vez, sumando */
    }
  }
  return id;
}

function base64url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function offerDownload(store, why) {
  document.getElementById('why').textContent = why;
  if (store === null) return;
  const a = document.getElementById('export');
  a.href = URL.createObjectURL(new Blob([store], { type: 'application/json' }));
  document.getElementById('manual').hidden = false;
}

/** Que el navegador traiga ya el /sw.js nuevo, antes de irse de la página. */
async function refreshServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const update = navigator.serviceWorker
    .getRegistration()
    .then((r) => r?.update())
    .catch(() => {});
  await Promise.race([update, new Promise((r) => setTimeout(r, 1500))]);
}

const store = read(STORE_KEY);
const ram = read(RAM_KEY);
const params = new URLSearchParams(location.search);
const exporting = params.has('export');
params.delete('export');
const query = params.toString();
const route = /^#[a-z]+$/.test(location.hash) ? location.hash : '';
const plain = `${NEW_ORIGIN}${location.pathname}${query ? `?${query}` : ''}`;
const target =
  store !== null || ram !== null
    ? `${plain}#mxm-migrate=${base64url(JSON.stringify({ v: 1, id: browserId(), route, store, ram }))}`
    : plain + route;
const go = document.getElementById('go');
go.href = target.length > MAX_URL ? plain + route : target;

if (exporting) {
  offerDownload(
    store,
    store !== null
      ? 'Here are the presets and profiles saved at this address.'
      : 'Nothing is saved at this address.',
  );
} else if (target.length > MAX_URL) {
  offerDownload(
    store,
    'Your saved presets and profiles are too large to carry over automatically.',
  );
} else {
  refreshServiceWorker().finally(() => {
    try {
      location.replace(target);
    } catch {
      /* el aviso de abajo */
    }
    // Si al rato seguimos aquí, la navegación no ocurrió: que no quede
    // esperando sin salida
    setTimeout(() => {
      go.href = plain + route;
      offerDownload(store, 'Could not take you there automatically.');
    }, 5000);
  });
}
