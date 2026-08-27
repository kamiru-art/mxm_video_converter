// MXM Studio — bootstrap and phase navigation.

import './style.css';
import { mountPhase1 } from './phase1.js';
import { mountPhase2 } from './phase2.js';
import { mountPhase3 } from './phase3.js';
import { mountPhase4 } from './phase4.js';
import { mountHelp } from './help.js';
import { run } from './pool.js';
import { toast } from './ui.js';

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
