// MXM Studio — bootstrap and phase navigation.

import './style.css';
import { mountPhase1 } from './phase1.js';
import { mountPhase2 } from './phase2.js';
import { mountPhase3 } from './phase3.js';
import { mountPhase4 } from './phase4.js';
import { mountHelp } from './help.js';
import { run } from './pool.js';
import { toast } from './ui.js';
import { getGpuDevice } from './webgpu.js';

const mounted = new Set();
const mounters = {
  sheets: mountPhase1,
  scans: mountPhase2,
  calibration: mountPhase3,
  video: mountPhase4,
  help: mountHelp,
};
// rutas antiguas en español: los enlaces guardados siguen funcionando
const LEGACY_ROUTES = { hojas: 'sheets', escaneos: 'scans', calibracion: 'calibration', ayuda: 'help' };
const resolveRoute = (v) => LEGACY_ROUTES[v] ?? v;

function show(view) {
  for (const b of document.querySelectorAll('#phase-nav .frame')) {
    b.classList.toggle('active', b.dataset.view === view);
  }
  for (const v of document.querySelectorAll('.view')) {
    v.classList.toggle('active', v.id === `view-${view}`);
  }
  const rootEl = document.getElementById(`view-${view}`);
  if (!mounted.has(view)) {
    mounted.add(view);
    mounters[view]?.(rootEl);
  }
  rootEl.dispatchEvent(new Event('mxm:activated'));
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
}

document.getElementById('phase-nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.frame');
  if (btn) show(btn.dataset.view);
});

window.addEventListener('hashchange', () => {
  const v = resolveRoute(location.hash.replace('#', ''));
  if (mounters[v]) show(v);
});

const initial = resolveRoute(location.hash.replace('#', ''));
show(mounters[initial] ? initial : 'sheets');

// warm up the WASM core
run('version', {}).then(
  (v) => console.log(`mxm-core ${v} ready`),
  (e) => toast(`Could not load the WebAssembly core: ${e.message}`, 'err'),
);

// Indicador de capacidades: el mismo proyecto tarda muy distinto según el
// navegador enderece los escaneos en la GPU o en WebAssembly, y eso no se ve
// por ningún lado. Aquí se dice, sin tener que abrir la fase ②.
(async () => {
  const badge = document.getElementById('capbadge');
  const text = document.getElementById('capbadge-text');
  if (!badge) return;
  const cores = navigator.hardwareConcurrency;
  const coresTxt = cores ? ` · ${cores} cores` : '';
  let gpu = null;
  try { gpu = await getGpuDevice(); } catch { gpu = null; }
  badge.classList.add(gpu ? 'gpu' : 'cpu');
  text.textContent = `${gpu ? 'WebGPU' : 'CPU (WebAssembly)'}${coresTxt}`;
  badge.title = gpu
    ? 'This browser can straighten scans on the graphics card: the heavy step of phase ② runs several times faster and uses half the memory. TIFF and 16-bit PNG scans still go through WebAssembly, so their bit depth survives untouched.'
    : 'No WebGPU here, so scans are straightened in WebAssembly on the processor. Everything works; heavy scans just take longer. Chrome or Edge on a recent machine enables the GPU path.';
  badge.hidden = false;
})();

// Instalable como aplicación y utilizable sin conexión. Solo en producción:
// en desarrollo un service worker sirve archivos viejos y confunde.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('[sw] could not register:', e);
    });
  });
}
