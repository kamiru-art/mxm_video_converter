// Caché en disco para los fotogramas que NO se pueden volver a decodificar
// deprisa: los que salen de ffmpeg.wasm (sin decodificador por hardware,
// ProRes, AVI…), donde repetir la pasada cuesta minutos. Los de WebCodecs no
// pasan por aquí: viven en el propio video y se decodifican cuando hacen
// falta (project.ts).
//
// OPFS (Origin Private File System) es el disco privado del navegador para
// este origen, con cuota grande. Un Blob leído de un archivo suyo NO ocupa
// memoria: el navegador lo lee del disco cuando alguien lo pide. Sin OPFS
// (o sin createWritable, Safari antiguo) el Blob se queda en memoria como
// hasta ahora, que Chrome también pagina a disco por su cuenta.
//
// OPFS es del ORIGEN, no de la pestaña: dos pestañas de la aplicación ven
// las mismas carpetas. Por eso cada pestaña escribe en la suya,
// `tabs/<id>/…`, y sólo vacía la suya. Las de pestañas cerradas las barre
// la siguiente que se abre (sweepStorage). Una pestaña que escribió tiene
// tomado un candado de Web Locks con su id, que el navegador suelta solo al
// cerrarla, al recargarla o si se cae, y toca su archivo `alive` cada pocos
// minutos. Antes las carpetas eran comunes y abrir la aplicación en otra
// pestaña (o en la misma, en #scans) borraba los recortes de la primera: su
// ZIP fallaba con "NotFoundError: A requested file or directory could not
// be found…" (medido en Opera y Chrome).

import type { Bytes } from './types.ts';
import { sanitizeLabel } from './ui.ts';

/** Las carpetas de cada pestaña. */
const TABS = 'tabs';
/** Esta pestaña: el nombre de su carpeta y de su candado. */
const TAB_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const LOCK_PREFIX = 'mxm-tab-';
/** Las carpetas de versiones anteriores, comunes a todas las pestañas. Una
 *  pestaña con la versión vieja aún abierta las sigue usando, así que sólo
 *  se borra de ellas lo que lleva un día sin tocarse. */
const LEGACY_DIRS = ['frames', 'processed', 'export', 'out'];
const LEGACY_AGE_MS = 24 * 3600e3;
/** Una salida de una pestaña ya cerrada se respeta este tiempo: su descarga
 *  puede seguir leyéndola (cerrar o recargar la pestaña no la corta). */
const CLOSED_OUTPUT_AGE_MS = 10 * 60e3;
/** La señal de vida de una pestaña: un archivo que toca cada ALIVE_EVERY_MS
 *  mientras vive (los temporizadores se paran en la caché de
 *  atrás/adelante). */
const ALIVE = 'alive';
const ALIVE_EVERY_MS = 5 * 60e3;
/** Una carpeta con señal de vida más reciente que esto no se barre, ni se
 *  pregunta por su candado: puede ser de una página en la caché de
 *  atrás/adelante. Safari 26 le suelta el candado (parecería cerrada y se
 *  borraría), y preguntar por el candado de una página guardada en la caché
 *  de Chrome 146+ la saca de ella (al volver atrás se recargaría y perdería
 *  el proyecto). Lo de una pestaña cerrada se libera, así, una hora más
 *  tarde. */
const ALIVE_GRACE_MS = 60 * 60e3;

const DIR = 'frames';
/** Los fotogramas recortados de los escaneos (fase ②). Un proyecto largo
 *  son cientos de PNG grandes: Chrome guarda los Blobs en memoria hasta
 *  unos 500 MB en total y, pasado eso, los que siguen dejan de poder
 *  leerse ("NotReadableError", medido en Chrome 152 con 180 fotogramas 4K:
 *  fallan del nº 87 en adelante). Un Blob que viene de un archivo de OPFS
 *  no cuenta: lo sirve el disco. */
const PROCESSED = 'processed';
/** Los fotogramas que la exportación recompone (reescalado, TIFF, recortes
 *  de tamaños dispares): mismo motivo. */
const EXPORT = 'export';
/** Salidas (el ZIP y el PDF a medio armar): escritas a trozos, nunca enteras
 *  en memoria. Un Blob leído de aquí lo sirve el disco. */
const OUT = 'out';

/** Lo que se le entrega a un stream de OPFS: una vista que no cubre todo su
 *  búfer se copia antes. Safari (26.5) escribe el ArrayBuffer ENTERO de una
 *  vista, no sus bytes: el sonido del MOV va a trozos de un mismo búfer
 *  (`pcm.subarray`) y el archivo salía con el búfer repetido por trozo,
 *  corrupto y sin moov legible. Chrome y Firefox respetan la vista. */
function exact(chunk: Bytes | Blob): Bytes | Blob {
  if (chunk instanceof Blob) return chunk;
  return chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
    ? chunk
    : chunk.slice();
}

const dirPromises = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
/** Los borrados de esta pestaña, uno detrás de otro. */
let clearing: Promise<void> = Promise.resolve();
/** Cada caché (DIR, PROCESSED, EXPORT) vive en una carpeta por generación,
 *  `processed-0`, `processed-1`…: vaciarla es pasar a la siguiente, y la
 *  anterior se borra en cuanto nadie la lee (holdFrames). Lo que se escribe
 *  después de vaciar va siempre a la carpeta nueva, que ese borrado no
 *  toca. */
const generations = new Map<string, number>();
/** Carpetas vaciadas que esperan a que terminen sus lectores. */
const doomed = new Set<string>();

function folderOf(name: string): string {
  return `${name}-${generations.get(name) ?? 0}`;
}

/** Sin Web Locks no hay forma de saber qué carpetas siguen en uso, y sin
 *  eso o no se borra nunca nada o se borra lo de otra pestaña: se queda en
 *  memoria. Todo navegador con createWritable tiene Web Locks (Chrome 69,
 *  Firefox 96, Safari 15.4). */
function supported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype &&
    !!navigator.locks &&
    typeof navigator.locks.request === 'function'
  );
}

/** Pide el candado `name` sin esperar. true si se concedió: entonces queda
 *  tomado hasta que `hold` termine (para siempre si `hold` no termina). */
function tryLock(name: string, hold: () => Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? hold() : undefined;
      })
      .catch(() => resolve(false));
  });
}

let tabLock: Promise<boolean> | null = null;

/** Toma el candado de esta pestaña y no lo suelta mientras viva. true si lo
 *  tiene: hasta entonces no se escribe nada, o una pestaña que barriera en
 *  ese momento vería la carpeta sin dueño y la borraría. Se toma al escribir
 *  por primera vez, no al abrir ni al vaciar (tabDir): una pestaña que no
 *  guarda nada no lo necesita, y Firefox no guarda en la caché de
 *  atrás/adelante una página con un candado tomado. */
function holdTabLock(): Promise<boolean> {
  if (!tabLock) {
    tabLock = new Promise<boolean>((resolve) => {
      if (!supported()) {
        resolve(false);
        return;
      }
      navigator.locks
        .request(`${LOCK_PREFIX}${TAB_ID}`, { mode: 'exclusive' }, () => {
          resolve(true);
          return new Promise<void>(() => {}); // hasta que la pestaña se cierre
        })
        .catch(() => resolve(false)); // un documento sin candados (sandbox…)
    });
  }
  return tabLock;
}

let beating = false;

/** Toca el archivo `alive` de esta pestaña. */
async function beat(): Promise<void> {
  const tab = await tabDir();
  if (!tab) return;
  try {
    const w = await (await tab.getFileHandle(ALIVE, { create: true })).createWritable();
    await w.write(new Uint8Array([1]));
    await w.close();
  } catch {
    /* sin cuota: la próxima vez */
  }
}

/** Empieza a dar señales de vida, una vez, al crear la carpeta. */
function startHeartbeat(): void {
  if (beating) return;
  beating = true;
  void beat();
  setInterval(() => void beat(), ALIVE_EVERY_MS);
}

let retaking: Promise<void> | null = null;

/** Safari 26 suelta los candados de una página que entra en la caché de
 *  atrás/adelante y no los devuelve al volver. Mientras está en la caché la
 *  protege su señal de vida (ALIVE_GRACE_MS); al volver se toma otra vez el
 *  candado, o la carpeta quedaría sin dueño para siempre.
 *
 *  Se pide con `ifAvailable`, que no espera: si el candado sigue siendo
 *  suyo (Chrome lo conserva; Firefox no guarda en la caché una página con
 *  un candado), no se concede y no pasa nada. No con `query()`: Chrome 146
 *  saca de la caché a toda página cuyo candado alguien consulta. Si no se
 *  concede se intenta otra vez: otra pestaña pudo estar barriendo la carpeta
 *  con el candado de ésta en la mano. */
function retakeTabLock(): Promise<void> {
  retaking ??= (async () => {
    if (!tabLock || !(await tabLock)) return;
    let regained = false;
    for (let i = 0; i < 2 && !regained; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3000));
      // concedido: se había perdido, y ahora es suyo hasta que se cierre
      regained = await tryLock(`${LOCK_PREFIX}${TAB_ID}`, () => new Promise<void>(() => {}));
    }
    // la carpeta pudo borrarse mientras tanto: las carpetas se vuelven a
    // abrir (y a crear), o lo nuevo iría a parar a memoria sin avisar
    if (regained) dirPromises.clear();
    await beat();
  })().finally(() => {
    retaking = null;
  });
  return retaking;
}

if (typeof window !== 'undefined')
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void retakeTabLock();
  });

/** La carpeta de esta pestaña, o null si no hay disco donde escribir (o,
 *  con `create` en false, si todavía no escribió nada: sin escribir, la
 *  pestaña no tiene carpeta ni toma el candado). */
async function tabDir(create = true): Promise<FileSystemDirectoryHandle | null> {
  if (!create && !tabLock) return null;
  if (!(await holdTabLock())) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const tabs = await root.getDirectoryHandle(TABS, { create });
    const dir = await tabs.getDirectoryHandle(TAB_ID, { create });
    if (create) startHeartbeat();
    return dir;
  } catch {
    return null; // sin cuota, modo privado, política del navegador…
  }
}

function cacheDir(name = DIR): Promise<FileSystemDirectoryHandle | null> {
  let p = dirPromises.get(name);
  if (!p) {
    const folder = folderOf(name);
    p = (async () => {
      const tab = await tabDir();
      if (!tab) return null;
      try {
        return await tab.getDirectoryHandle(folder, { create: true });
      } catch {
        return null;
      }
    })();
    dirPromises.set(name, p);
  }
  return p;
}

/** Las entradas de `dir`, leídas enteras ANTES de borrar nada: borrar a
 *  mitad de recorrerla deja el resultado sin definir en la especificación,
 *  y una entrada saltada dejaba la carpeta llena para otra vez. */
async function listEntries(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
  const out: [string, FileSystemHandle][] = [];
  for await (const entry of dir.entries()) out.push(entry);
  return out;
}

/** Borra de `dir` los archivos que llevan más de `olderThanMs` sin tocarse,
 *  cada uno por su cuenta: uno bloqueado (una descarga lo está leyendo) no
 *  impide borrar los demás. Las subcarpetas, enteras si `dirs`. Devuelve
 *  cuántas entradas quedan. */
async function removeOld(
  dir: FileSystemDirectoryHandle,
  olderThanMs: number,
  dirs = false,
): Promise<number> {
  const now = Date.now();
  let left = 0;
  for (const [name, h] of await listEntries(dir)) {
    try {
      if (h.kind === 'directory') {
        if (dirs) await dir.removeEntry(name, { recursive: true });
        else left++;
        continue;
      }
      const f = await (h as FileSystemFileHandle).getFile();
      if (now - f.lastModified > olderThanMs) await dir.removeEntry(name);
      else left++;
    } catch {
      left++; // en uso, o ya no está
    }
  }
  return left;
}

/** ¿Dio la pestaña de `dir` señales de vida hace menos de ALIVE_GRACE_MS? */
async function recentlyAlive(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const f = await (await dir.getFileHandle(ALIVE)).getFile();
    return Date.now() - f.lastModified < ALIVE_GRACE_MS;
  } catch {
    return false; // sin señal (o de una versión anterior, que no la daba)
  }
}

/** Vacía la carpeta de una pestaña cerrada, salvo las salidas recientes (su
 *  descarga puede seguir leyéndolas). true si quedó vacía. */
async function emptyClosedTab(dir: FileSystemDirectoryHandle): Promise<boolean> {
  let left = 0;
  for (const [sub, h] of await listEntries(dir)) {
    try {
      if (h.kind !== 'directory') {
        await dir.removeEntry(sub);
      } else if (sub === OUT) {
        const out = await dir.getDirectoryHandle(OUT);
        if (await removeOld(out, CLOSED_OUTPUT_AGE_MS, true)) left++;
        else await dir.removeEntry(OUT);
      } else {
        await dir.removeEntry(sub, { recursive: true });
      }
    } catch {
      left++; // en uso: la próxima vez
    }
  }
  return left === 0;
}

/** Libera el disco que dejaron las pestañas cerradas (y las versiones
 *  anteriores). Al arrancar la aplicación. Una carpeta se vacía sólo si su
 *  pestaña lleva más de ALIVE_GRACE_MS sin señales de vida Y su candado
 *  está libre: entonces la carpeta se vacía con ese candado en la mano, y
 *  su dueño, si vuelve, lo pide otra vez al rato (retakeTabLock). Nunca toca la
 *  carpeta de esta pestaña. Lo que la pestaña cerrada dejó lo leía sólo
 *  ella, salvo una descarga reciente (CLOSED_OUTPUT_AGE_MS). */
export async function sweepStorage(): Promise<void> {
  if (!supported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    let tabs: FileSystemDirectoryHandle | null = null;
    try {
      tabs = await root.getDirectoryHandle(TABS);
    } catch {
      /* ninguna pestaña escribió nada todavía */
    }
    if (tabs) {
      const tabsDir = tabs;
      for (const [name, h] of await listEntries(tabsDir)) {
        if (h.kind !== 'directory' || name === TAB_ID) continue;
        try {
          const dir = h as FileSystemDirectoryHandle;
          if (await recentlyAlive(dir)) continue;
          // libre: su pestaña se cerró. Tomado: vive (o otra pestaña la
          // está barriendo ahora mismo). La promesa de request() espera a
          // que termine el vaciado
          await navigator.locks
            .request(`${LOCK_PREFIX}${name}`, { ifAvailable: true }, async (lock) => {
              // vacía ya, o la próxima vez (le queda una descarga reciente)
              if (lock && (await emptyClosedTab(dir)))
                await tabsDir.removeEntry(name).catch(() => {});
            })
            .catch(() => {});
        } catch {
          /* ya no está */
        }
      }
    }
    for (const name of LEGACY_DIRS) {
      try {
        const dir = await root.getDirectoryHandle(name);
        if (!(await removeOld(dir, LEGACY_AGE_MS))) await root.removeEntry(name);
      } catch {
        /* no existe, o la usa una pestaña de la versión anterior */
      }
    }
  } catch {
    /* sin OPFS, o el navegador no deja */
  }
}

/** Guarda `data` en disco y devuelve un Blob respaldado por el archivo. Si
 *  no se puede, devuelve un Blob en memoria: nunca falla. Mejor bytes que un
 *  Blob: un Blob en memoria cuenta contra el cupo de Chrome (ver PROCESSED)
 *  hasta que el recolector lo suelta, y los bytes no. */
export async function storeFrame(
  name: string,
  data: Bytes | Blob,
  dirName = DIR,
  type = 'image/png',
): Promise<Blob> {
  const asBlob = (): Blob => (data instanceof Blob ? data : new Blob([data], { type }));
  const dir = await cacheDir(dirName);
  if (!dir) return asBlob();
  let w: FileSystemWritableFileStream | null = null;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    w = await handle.createWritable();
    await w.write(exact(data));
    await w.close();
    w = null;
    return await handle.getFile();
  } catch (e) {
    // la escritura a medias se cierra: si no, el navegador se queda con su
    // archivo temporal y con el bloqueo de la entrada hasta recargar
    if (w) {
      try {
        await w.abort();
      } catch {
        /* ya cerrada */
      }
      try {
        await dir.removeEntry(name);
      } catch {
        /* ya no está */
      }
    }
    // el disco lleno NO se disimula: seguir en memoria acaba en un
    // "NotReadableError" mucho más tarde y en otro sitio (ver PROCESSED),
    // y el usuario nunca sabría que lo que falta es espacio
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      throw new Error(
        'The browser ran out of room on disk for this project. Free space (or empty the site data of this browser) and try again.',
      );
    }
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.warn(`[opfs] frame kept in memory (${err})`);
    return asBlob();
  }
}

/** Un archivo de salida que se escribe por trozos. En OPFS si se puede;
 *  si no, los trozos se juntan en Blobs por bloques en memoria (Chrome los
 *  pagina a disco por su cuenta; Safari antiguo no, y ahí el tope es la
 *  memoria, como antes). `close()` devuelve el archivo entero como Blob. */
export interface OutputFile {
  write(chunk: Bytes | Blob): Promise<void>;
  close(): Promise<Blob>;
  /** Descarta lo escrito (un fallo a mitad): el disco no se queda con el
   *  archivo a medias ni con su bloqueo. */
  abort(): Promise<void>;
  /** Dónde está: 'disk' (OPFS) o 'memory'. */
  readonly where: 'disk' | 'memory';
}

/** ¿Hay disco privado del navegador donde escribir? */
export function opfsSupported(): boolean {
  return supported();
}

const PART_BYTES = 32e6;

function memoryOutput(type: string): OutputFile {
  const parts: Blob[] = [];
  let chunks: (Bytes | Blob)[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (chunks.length) parts.push(new Blob(chunks));
    chunks = [];
    bytes = 0;
  };
  return {
    where: 'memory',
    async write(chunk) {
      chunks.push(chunk);
      bytes += chunk instanceof Blob ? chunk.size : chunk.byteLength;
      if (bytes >= PART_BYTES) flush();
    },
    async close() {
      flush();
      return new Blob(parts, { type });
    },
    async abort() {
      chunks = [];
      parts.length = 0;
    },
  };
}

async function outDir(): Promise<FileSystemDirectoryHandle | null> {
  const tab = await tabDir();
  if (!tab) return null;
  try {
    return await tab.getDirectoryHandle(OUT, { create: true });
  } catch {
    return null;
  }
}

/** Abre `name` para escribirlo por trozos. Nunca falla: sin OPFS, o si OPFS
 *  falla al abrir, escribe en memoria. Un fallo a MITAD (cuota de disco) sí
 *  se propaga desde write(): a esas alturas no hay dónde seguir. */
export async function openOutput(
  name: string,
  type = 'application/octet-stream',
): Promise<OutputFile> {
  const dir = await outDir();
  if (!dir) return memoryOutput(type);
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    return {
      where: 'disk',
      write: (chunk) => w.write(exact(chunk)),
      async close() {
        await w.close();
        const f = await handle.getFile();
        return type ? new Blob([f], { type }) : f;
      },
      async abort() {
        try {
          await w.abort();
        } catch {
          /* ya cerrado */
        }
        try {
          await dir.removeEntry(name);
        } catch {
          /* ya no está */
        }
      },
    };
  } catch (e) {
    console.warn(`[opfs] output "${name}" kept in memory:`, e);
    return memoryOutput(type);
  }
}

/** Un trozo que un muxer escribe en una posición del archivo (el formato
 *  del StreamTarget de mediabunny y de los streams de OPFS). */
export interface PositionedWrite {
  type: 'write';
  data: Uint8Array;
  position: number;
}

/** Un archivo de salida para un muxer que escribe por POSICIÓN: el MP4
 *  vuelve al principio del `mdat` a cerrar su tamaño cuando termina. Cada
 *  trozo pasa por `exact` antes de llegar al stream de OPFS (Safari
 *  escribiría el búfer entero de una vista). Quien escribe cierra el
 *  stream; `file()` devuelve el archivo entero, servido por el disco. null
 *  si no hay OPFS: el muxer se queda en memoria. */
export interface SeekableOutput {
  readonly stream: WritableStream<PositionedWrite>;
  file(): Promise<Blob>;
  /** Descarta lo escrito (un fallo o una parada a mitad). */
  abort(): Promise<void>;
}

export async function openSeekableOutput(
  name: string,
  type: string,
): Promise<SeekableOutput | null> {
  const dir = await outDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    const stream = new WritableStream<PositionedWrite>({
      write: (chunk) =>
        writable.write({
          type: 'write',
          position: chunk.position,
          data: exact(chunk.data as Bytes),
        }),
      close: () => writable.close(),
      abort: () => writable.abort(),
    });
    return {
      stream,
      async file() {
        const f = await handle.getFile();
        return new Blob([f], { type });
      },
      async abort() {
        try {
          await writable.abort();
        } catch {
          /* ya cerrado */
        }
        try {
          await dir.removeEntry(name);
        } catch {
          /* ya no está */
        }
      },
    };
  } catch (e) {
    console.warn(`[opfs] output "${name}" kept in memory:`, e);
    return null;
  }
}

/** Borra las salidas viejas de ESTA pestaña: todas, o al empezar una
 *  generación las de hace más de `olderThanMs` (la descarga de la anterior
 *  puede seguir leyendo la suya). Las de pestañas cerradas las barre
 *  sweepStorage. */
export async function clearOutputs(olderThanMs = 0): Promise<void> {
  const tab = await tabDir(false);
  if (!tab) return;
  try {
    if (!olderThanMs) {
      await tab.removeEntry(OUT, { recursive: true });
      return;
    }
    await removeOld(await tab.getDirectoryHandle(OUT), olderThanMs);
  } catch {
    /* no existía, o el navegador no deja */
  }
}

let processedSeq = 0;

/** Un fotograma recortado de un escaneo, a disco con nombre ÚNICO: la
 *  misma etiqueta vuelve a salir cuando se escanea otra vez la misma hoja,
 *  y pisar el archivo rompería el Blob del recorte anterior, que el informe
 *  sigue mostrando. */
export function storeProcessedFrame(label: string, png: Bytes | Blob): Promise<Blob> {
  // la etiqueta viene del layout y puede traer barras o dos puntos, que
  // OPFS rechaza; el número por delante ya hace único el nombre, así que la
  // etiqueta es sólo para poder mirar la carpeta y entender qué hay
  return storeFrame(`${++processedSeq}-${sanitizeLabel(label)}.png`, png, PROCESSED);
}

let readers = 0;

/** Mientras una exportación (o el ZIP de la fase ②) lee los fotogramas del
 *  disco, NADIE en esta pestaña los borra. La fase ② los borra al montarse,
 *  al vaciar su informe y al reprocesar, y la ① al extraer: cualquiera de
 *  esas cosas, hecha mientras el muxer copiaba, le quitaba los archivos de
 *  debajo. Lo que se vacía mientras tanto se borra al soltar el último
 *  préstamo. Devuelve la función que lo suelta. (Las otras pestañas no los
 *  tocan: cada una tiene su carpeta, ver TABS.) */
export function holdFrames(): () => void {
  readers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    readers--;
    if (readers === 0) void flushDoomed();
  };
}

/** Borra las carpetas vaciadas, si nadie las está leyendo. */
function flushDoomed(): Promise<void> {
  if (readers > 0 || doomed.size === 0) return clearing;
  const folders = [...doomed];
  doomed.clear();
  clearing = clearing.then(async () => {
    const tab = await tabDir(false);
    for (const folder of folders) {
      try {
        await tab?.removeEntry(folder, { recursive: true });
      } catch {
        /* no existía, o el navegador no deja */
      }
    }
  });
  return clearing;
}

/** Vacía la caché. Al empezar una extracción y al montar la fase: un
 *  proyecto no sobrevive a la recarga, así que sus archivos tampoco. Lo
 *  nuevo va desde ya a otra carpeta (generations); la vaciada se borra
 *  ahora, o cuando se suelte el último préstamo de holdFrames. */
export function clearFrameCache(dirName = DIR): Promise<void> {
  if (!supported()) return Promise.resolve();
  doomed.add(folderOf(dirName));
  generations.set(dirName, (generations.get(dirName) ?? 0) + 1);
  dirPromises.delete(dirName);
  return flushDoomed();
}

let exportSeq = 0;

/** Un fotograma recompuesto para la exportación, a disco. */
export function storeExportFrame(png: Bytes | Blob): Promise<Blob> {
  return storeFrame(`${++exportSeq}.png`, png, EXPORT);
}

/** Fuera los recompuestos de la exportación anterior: al empezar otra. Con
 *  la exportación en curso (que tiene tomado el préstamo) se borran al
 *  terminar ella; antes no se borraban nunca y cada exportación sumaba otra
 *  copia de la secuencia en el disco. */
export function clearExportCache(): Promise<void> {
  return clearFrameCache(EXPORT);
}

/** Fuera los recortes de la fase ②: al montarla (los de la sesión
 *  anterior) y al vaciar el informe, que es cuando ya nadie los referencia. */
export function clearProcessedCache(): Promise<void> {
  return clearFrameCache(PROCESSED);
}
