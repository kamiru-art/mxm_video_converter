// Pool de workers WASM: reparte comandos entre N workers (escaneos en
// paralelo), mantiene afinidad al worker 0 para comandos con estado (PDF) y
// RECICLA los workers cuya memoria WASM creció demasiado — la memoria de
// WebAssembly nunca se encoge, así que tras procesar escaneos grandes la
// única forma de devolverla al sistema es terminar el worker y crear otro.

const N = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const RECYCLE_BYTES = 700e6; // por worker; los escaneos grandes llegan a esto

class WasmWorker {
  constructor() {
    this.spawn();
  }
  spawn() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.busy = 0;
    this.nextId = 1;
    this.mem = 0;
    this.pinned = false; // PDF a medio construir: no reciclar
    this.worker.onmessage = (ev) => {
      const { id, ok, value, error, mem, pinned } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      this.busy--;
      this.mem = mem ?? this.mem;
      this.pinned = !!pinned;
      ok ? p.resolve(value) : p.reject(new Error(error));
      maybeRecycle(this);
    };
  }
  run(cmd, args, transfer = []) {
    const id = this.nextId++;
    this.busy++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args }, transfer);
    });
  }
  recycle() {
    this.worker.terminate();
    this.spawn();
  }
}

const workers = [new WasmWorker()];

/** Recicla un worker ocioso e hinchado (transparente para los llamadores). */
function maybeRecycle(w) {
  if (w.busy === 0 && !w.pinned && w.mem > RECYCLE_BYTES) {
    w.recycle();
  }
}

/** Recicla ya mismo todos los workers ociosos por encima de `limitBytes`.
 *  Llamar al terminar un lote (generación de hojas, tanda de escaneos). */
export function recycleIdle(limitBytes = 300e6) {
  for (const w of workers) {
    if (w.busy === 0 && !w.pinned && w.mem > limitBytes) w.recycle();
  }
}

function leastBusy() {
  while (workers.length < N && workers.every((w) => w.busy > 0)) {
    workers.push(new WasmWorker());
  }
  return workers.reduce((a, b) => (b.busy < a.busy ? b : a));
}

/** Ejecuta un comando en cualquier worker libre. */
export function run(cmd, args, transfer = []) {
  return leastBusy().run(cmd, args, transfer);
}

/** Ejecuta un comando en el worker 0 (para secuencias con estado: PDF). */
export function run0(cmd, args, transfer = []) {
  return workers[0].run(cmd, args, transfer);
}

export function poolSize() {
  return N;
}
