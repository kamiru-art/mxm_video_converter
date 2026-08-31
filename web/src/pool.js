// Pool de workers WASM: reparte comandos entre N workers (escaneos en
// paralelo), mantiene afinidad al worker 0 para comandos con estado (PDF) y
// RECICLA los workers cuya memoria WASM creció demasiado — la memoria de
// WebAssembly nunca se encoge, así que tras procesar escaneos grandes la
// única forma de devolverla al sistema es terminar el worker y crear otro.

const N = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
const RECYCLE_BYTES = 700e6; // por worker; los escaneos grandes llegan a esto

// Un worker que NO ha contestado nada en este tiempo teniendo trabajo
// pendiente está atascado. El núcleo corre síncrono dentro del worker, así que
// no hay forma de interrumpirlo: la única salida es la que ya se usa para un
// panic, terminarlo y crear otro. El tope es deliberadamente generoso
// —enderezar un escaneo A3 de 600 ppp en WebAssembly, o armar el PDF de un
// proyecto largo, son minutos en una máquina lenta— porque matar trabajo
// legítimo cuesta más caro que esperar: se pierde también lo que ese worker
// tuviera en cola.
const STALL_MS = 10 * 60e3;

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
    this.poisoned = false; // el WASM hizo panic: reciclar al quedar ocioso
    this.stall = null; // temporizador de "lleva demasiado sin contestar"
    this.worker.onmessage = (ev) => {
      const { id, ok, value, error, mem, pinned, poisoned } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      this.busy--;
      this.mem = mem ?? this.mem;
      this.pinned = !!pinned;
      if (poisoned) this.poisoned = true;
      this.armStall(); // ha contestado: sigue vivo, el reloj vuelve a empezar
      ok ? p.resolve(value) : p.reject(new Error(error));
      maybeRecycle(this);
    };
    // si el script del worker no carga (red, CSP), las promesas pendientes
    // no deben colgar para siempre
    this.worker.onerror = (e) => this.fail(`Processing worker failed: ${e?.message ?? 'could not load'}`);
    // un resultado que el navegador no puede deserializar no llega nunca a
    // onmessage: sin esto, su promesa se queda pendiente y su plaza ocupada
    this.worker.onmessageerror = () => this.fail('A result from the processing worker could not be read. Try again with a smaller image.');
  }
  /** Reloj de "no contesta": UNO por worker, no por llamada. Los comandos se
   *  encolan y el segundo no empieza hasta que acaba el primero, así que un
   *  reloj por llamada mataría al worker por el trabajo de otro; cada
   *  respuesta demuestra que sigue vivo y lo reinicia. */
  armStall() {
    clearTimeout(this.stall);
    this.stall = this.pending.size
      ? setTimeout(() => this.fail('The processing step stopped responding and was restarted. Try again; if it keeps happening, use a smaller scan or fewer sheets at a time.'), STALL_MS)
      : null;
  }
  /** Un worker atascado o roto no va a atender lo que tenga en cola: se
   *  rechaza TODO lo pendiente y se reemplaza, la misma salida que ya se usa
   *  cuando el núcleo hace panic. */
  fail(message) {
    const pend = [...this.pending.values()];
    this.recycle(); // spawn() deja pending vacío, busy en 0 y el reloj parado
    for (const p of pend) p.reject(new Error(message));
  }
  run(cmd, args, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // postMessage ANTES de contar: si el clonado estructurado falla
      // (DataCloneError) el worker no recibe nada, y sumar `busy` de todas
      // formas lo dejaría "ocupado" para siempre — cuatro fallos así y el
      // pool se queda sin plazas.
      try {
        this.worker.postMessage({ id, cmd, args }, transfer);
      } catch (e) {
        reject(new Error(`Could not send the “${cmd}” command to the processing worker: ${e?.message ?? e}`));
        return;
      }
      this.busy++;
      this.pending.set(id, { resolve, reject });
      this.armStall();
    });
  }
  recycle() {
    clearTimeout(this.stall);
    this.worker.terminate();
    this.spawn();
  }
}

const workers = [new WasmWorker()];

/** Recicla un worker ocioso e hinchado o envenenado (transparente). */
function maybeRecycle(w) {
  if (w.busy === 0 && !w.pinned && (w.poisoned || w.mem > RECYCLE_BYTES)) {
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
