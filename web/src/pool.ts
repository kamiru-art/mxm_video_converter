// Pool de workers WASM: reparte comandos entre N workers (escaneos en
// paralelo), mantiene afinidad al worker 0 para comandos con estado (PDF) y
// RECICLA los workers cuya memoria WASM creció demasiado — la memoria de
// WebAssembly nunca se encoge, así que tras procesar escaneos grandes la
// única forma de devolverla al sistema es terminar el worker y crear otro.

import type { CommandArgs, CommandName, CommandResult, WorkerRequest, WorkerResponse } from './commands.ts';
import { errMsg } from './errors.ts';

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

// Un worker que muere ANTES de contestar nada no llegó a arrancar: el script
// no cargó o falló al ejecutarse. El caso real es una pestaña que se quedó
// abierta mientras se publicaba una versión nueva: el main.js viejo pide el
// worker-<hash>.js viejo, que ya no existe, y el sitio (una SPA) devuelve el
// index.html con estado 200 en su lugar. Ese worker no va a arrancar por
// mucho que se repita. Volver a crearlo desde el propio `onerror` era un
// bucle sin pausa (crear → fallar → crear…), una petición HTTP por vuelta y
// sin nada visible para el usuario; en producción llegó a cientos de miles
// de peticiones desde una sola pestaña. Ahora un worker que no arrancó se
// vuelve a intentar solo cuando alguien pide un comando, unas pocas veces
// seguidas, y después una vez por minuto como mucho.
const MAX_BOOT_FAILURES = 3;
const BOOT_RETRY_MS = 60e3;
const BOOT_FAILED_MSG = 'The processing engine could not start. Reload the page: this usually happens when the site was updated while this tab was open.';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

class WasmWorker {
  private nextId = 1;
  private bootFailures = 0; // seguidos; la primera respuesta los pone a cero
  private lastBootFailure = 0;
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  busy = 0;
  mem = 0;
  private answered = false; // ha contestado al menos una vez: el script cargó
  pinned = false; // PDF a medio construir: no reciclar
  poisoned = false; // el WASM hizo panic: reciclar al quedar ocioso
  private stall: ReturnType<typeof setTimeout> | null = null; // "lleva demasiado sin contestar"

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.pending = new Map();
    this.busy = 0;
    this.mem = 0;
    this.answered = false;
    this.pinned = false;
    this.poisoned = false;
    this.stall = null;
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const { id, ok, value, error, mem, pinned, poisoned } = ev.data;
      this.answered = true;
      this.bootFailures = 0;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      this.busy--;
      this.mem = mem ?? this.mem;
      this.pinned = !!pinned;
      if (poisoned) this.poisoned = true;
      this.armStall(); // ha contestado: sigue vivo, el reloj vuelve a empezar
      if (ok) p.resolve(value);
      else p.reject(new Error(error ?? 'unknown error'));
      maybeRecycle(this);
    };
    // si el script del worker no carga (red, CSP, versión vieja), las
    // promesas pendientes no deben colgar para siempre. Sin ninguna
    // respuesta previa es un fallo de arranque: ver MAX_BOOT_FAILURES.
    worker.onerror = (e: ErrorEvent) => {
      if (!this.answered) this.fail(BOOT_FAILED_MSG, true);
      else this.fail(`Processing worker failed: ${e?.message || 'unknown error'}`);
    };
    // un resultado que el navegador no puede deserializar no llega nunca a
    // onmessage: sin esto, su promesa se queda pendiente y su plaza ocupada
    worker.onmessageerror = () => this.fail('A result from the processing worker could not be read. Try again with a smaller image.');
  }

  /** Reloj de "no contesta": UNO por worker, no por llamada. Los comandos se
   *  encolan y el segundo no empieza hasta que acaba el primero, así que un
   *  reloj por llamada mataría al worker por el trabajo de otro; cada
   *  respuesta demuestra que sigue vivo y lo reinicia. */
  private armStall(): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = this.pending.size
      ? setTimeout(() => this.fail('The processing step stopped responding and was restarted. Try again; if it keeps happening, use a smaller scan or fewer sheets at a time.'), STALL_MS)
      : null;
  }

  /** Un worker atascado o roto no va a atender lo que tenga en cola: se
   *  rechaza TODO lo pendiente y se termina. El reemplazo NO se crea aquí:
   *  lo crea el siguiente `run()`. Así un worker que no arranca no puede
   *  encadenar creaciones por sí solo, porque cada intento cuesta una
   *  acción del usuario, y además se limita (ver MAX_BOOT_FAILURES). */
  private fail(message: string, boot = false): void {
    const pend = [...this.pending.values()];
    this.kill();
    if (boot) {
      this.bootFailures++;
      this.lastBootFailure = Date.now();
    }
    for (const p of pend) p.reject(new Error(message));
  }

  /** Termina el worker y deja la plaza vacía (worker = null). */
  private kill(): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = null;
    this.worker?.terminate();
    this.worker = null;
    this.pending = new Map();
    this.busy = 0;
    this.mem = 0;
    this.pinned = false;
    this.poisoned = false;
  }

  run<K extends CommandName>(cmd: K, args: CommandArgs<K>, transfer: Transferable[] = []): Promise<CommandResult<K>> {
    if (!this.worker) {
      // plaza vacía por un fallo: se vuelve a intentar, pero no sin freno
      if (this.bootFailures >= MAX_BOOT_FAILURES
          && Date.now() - this.lastBootFailure < BOOT_RETRY_MS) {
        return Promise.reject(new Error(BOOT_FAILED_MSG));
      }
      this.spawn();
    }
    const worker = this.worker as Worker;
    const id = this.nextId++;
    return new Promise<CommandResult<K>>((resolve, reject) => {
      // postMessage ANTES de contar: si el clonado estructurado falla
      // (DataCloneError) el worker no recibe nada, y sumar `busy` de todas
      // formas lo dejaría "ocupado" para siempre — cuatro fallos así y el
      // pool se queda sin plazas.
      try {
        const msg: WorkerRequest = { id, cmd, args };
        worker.postMessage(msg, transfer);
      } catch (e) {
        reject(new Error(`Could not send the “${cmd}” command to the processing worker: ${errMsg(e)}`));
        return;
      }
      this.busy++;
      this.pending.set(id, { resolve: (v) => resolve(v as CommandResult<K>), reject });
      this.armStall();
    });
  }

  /** Reemplazo inmediato de un worker sano pero hinchado o envenenado. Solo
   *  se llama a un worker que ya contestó, así que crear el nuevo aquí no
   *  puede encadenar fallos: si el nuevo no arranca, cae en `fail(…, true)`
   *  y la plaza queda vacía hasta el siguiente `run()`. */
  recycle(): void {
    this.kill();
    this.spawn();
  }
}

const workers: WasmWorker[] = [new WasmWorker()];

/** Recicla un worker ocioso e hinchado o envenenado (transparente). */
function maybeRecycle(w: WasmWorker): void {
  if (w.busy === 0 && !w.pinned && (w.poisoned || w.mem > RECYCLE_BYTES)) {
    w.recycle();
  }
}

/** Recicla ya mismo todos los workers ociosos por encima de `limitBytes`.
 *  Llamar al terminar un lote (generación de hojas, tanda de escaneos). */
export function recycleIdle(limitBytes = 300e6): void {
  for (const w of workers) {
    if (w.busy === 0 && !w.pinned && w.mem > limitBytes) w.recycle();
  }
}

function leastBusy(): WasmWorker {
  while (workers.length < N && workers.every((w) => w.busy > 0)) {
    workers.push(new WasmWorker());
  }
  return workers.reduce((a, b) => (b.busy < a.busy ? b : a));
}

/** Ejecuta un comando en cualquier worker libre. */
export function run<K extends CommandName>(cmd: K, args: CommandArgs<K>, transfer: Transferable[] = []): Promise<CommandResult<K>> {
  return leastBusy().run(cmd, args, transfer);
}

/** Ejecuta un comando en el worker 0 (para secuencias con estado: PDF). */
export function run0<K extends CommandName>(cmd: K, args: CommandArgs<K>, transfer: Transferable[] = []): Promise<CommandResult<K>> {
  return workers[0].run(cmd, args, transfer);
}

export function poolSize(): number {
  return N;
}
