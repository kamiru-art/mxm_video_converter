// Pool de workers WASM: reparte comandos entre N workers (escaneos en
// paralelo) y mantiene afinidad al worker 0 para comandos con estado (PDF).

const N = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));

class WasmWorker {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.busy = 0;
    this.nextId = 1;
    this.worker.onmessage = (ev) => {
      const { id, ok, value, error } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      this.busy--;
      ok ? p.resolve(value) : p.reject(new Error(error));
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
}

const workers = [new WasmWorker()];

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
