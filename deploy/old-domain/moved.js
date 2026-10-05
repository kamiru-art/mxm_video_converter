// mxm.sebastianlopez.me → mxmstudio.work, del lado que envía.
//
// localStorage es de cada origen: lo que el usuario guardó aquí (presets,
// perfiles de calibración, ajustes, la RAM de la fase ②) no se ve desde el
// dominio nuevo. Esta página lo lee y lo lleva en el fragmento de la URL,
// que nunca se manda a ningún servidor; web/src/migrate.ts lo recibe.
// Además da de baja el service worker viejo y vacía sus cachés, para que el
// navegador no siga sirviendo aquí una copia de la app sin conexión.
//
// Con ?export no redirige: ofrece el almacén como archivo, el mismo formato
// que "Export everything" en Calibration, para cargarlo a mano allá si la
// mudanza automática falló. Lo mismo si los datos no caben en una URL.

const NEW_ORIGIN = 'https://mxmstudio.work';
const STORE_KEY = 'mxm-studio-v1';
const RAM_KEY = 'mxm_ram_gb';
/** Chrome rechaza navegar a una URL de más de 2 MB; se deja margen. */
const MAX_URL = 1_500_000;

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // almacenamiento bloqueado: no hay nada que llevar
  }
}

function base64url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function forgetOldApp() {
  const work = [];
  if ('serviceWorker' in navigator) {
    work.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((rs) => Promise.all(rs.map((r) => r.unregister()))),
    );
  }
  if ('caches' in self) {
    work.push(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
  }
  // Un navegador que se cuelga aquí no puede dejar al usuario en esta página
  await Promise.race([Promise.allSettled(work), new Promise((r) => setTimeout(r, 1500))]);
}

function offerDownload(store, why) {
  document.getElementById('why').textContent = why;
  const a = document.getElementById('export');
  a.href = URL.createObjectURL(new Blob([store], { type: 'application/json' }));
  document.getElementById('manual').hidden = false;
}

const store = read(STORE_KEY);
const ram = read(RAM_KEY);
const params = new URLSearchParams(location.search);
const route = /^#[a-z]+$/.test(location.hash) ? location.hash : '';
params.delete('export');
const query = params.toString();
let target = `${NEW_ORIGIN}${location.pathname}${query ? `?${query}` : ''}`;
if (store !== null || ram !== null) {
  target += `#mxm-migrate=${base64url(JSON.stringify({ v: 1, route, store, ram }))}`;
} else {
  target += route;
}
document.getElementById('go').href = target;

if (new URLSearchParams(location.search).has('export')) {
  if (store !== null)
    offerDownload(store, 'Here are the presets and profiles saved at this address.');
  else document.getElementById('why').textContent = 'Nothing is saved at this address.';
} else if (target.length > MAX_URL && store !== null) {
  offerDownload(
    store,
    'Your saved presets and profiles are too large to carry over automatically.',
  );
} else {
  forgetOldApp().finally(() => location.replace(target));
}
