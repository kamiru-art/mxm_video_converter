// MXM Studio — arranque y navegación entre fases.

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
  hojas: mountPhase1,
  escaneos: mountPhase2,
  calibracion: mountPhase3,
  video: mountPhase4,
  ayuda: mountHelp,
};

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

const initial = location.hash.replace('#', '');
show(mounters[initial] ? initial : 'hojas');

// precalentar el núcleo WASM
run('version', {}).then(
  (v) => console.log(`mxm-core ${v} listo`),
  (e) => toast(`No se pudo cargar el núcleo WebAssembly: ${e.message}`, 'err'),
);
