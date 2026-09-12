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

import type { Bytes } from './types.ts';
import { sanitizeLabel } from './ui.ts';

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

const dirPromises = new Map<string, Promise<FileSystemDirectoryHandle | null>>();
/** Un vaciado de la caché de fotogramas en curso: esa carpeta no se vuelve
 *  a crear hasta que termine, o el borrado se llevaría por delante los
 *  archivos nuevos. (Las salidas van por nombre único y por edad.) */
let clearing: Promise<void> = Promise.resolve();

function supported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}

function cacheDir(name = DIR): Promise<FileSystemDirectoryHandle | null> {
  let p = dirPromises.get(name);
  if (!p) {
    p = (async () => {
      if (!supported()) return null;
      await clearing;
      try {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(name, { create: true });
      } catch {
        return null; // sin cuota, modo privado, política del navegador…
      }
    })();
    dirPromises.set(name, p);
  }
  return p;
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
    await w.write(data);
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
  if (!supported()) return null;
  try {
    await clearing;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OUT, { create: true });
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
      write: (chunk) => w.write(chunk),
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

/** Un archivo de salida para un muxer que escribe por POSICIÓN: el MOV
 *  vuelve al principio del `mdat` a cerrar su tamaño cuando termina. El
 *  stream de OPFS acepta `{type: 'write', position, data}`, que es justo lo
 *  que manda el StreamTarget de mediabunny, así que se le entrega tal cual.
 *  Quien escribe cierra el stream; `file()` devuelve el archivo entero,
 *  servido por el disco. null si no hay OPFS: el muxer se queda en memoria. */
export interface SeekableOutput {
  readonly writable: FileSystemWritableFileStream;
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
    return {
      writable,
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

/** Borra las salidas viejas: todas al montar la fase, y al empezar una
 *  generación las de hace más de `olderThanMs` (la descarga de la anterior
 *  puede seguir leyendo la suya). */
export async function clearOutputs(olderThanMs = 0): Promise<void> {
  if (!supported()) return;
  try {
    const root = await navigator.storage.getDirectory();
    if (!olderThanMs) {
      await root.removeEntry(OUT, { recursive: true });
      return;
    }
    const dir = await root.getDirectoryHandle(OUT);
    const now = Date.now();
    for await (const [name, h] of dir.entries()) {
      // cada archivo por su cuenta: uno bloqueado (una descarga en curso lo
      // está leyendo) no impide borrar los demás
      try {
        if (h.kind !== 'file') continue;
        const f = await (h as FileSystemFileHandle).getFile();
        if (now - f.lastModified > olderThanMs) await dir.removeEntry(name);
      } catch {
        /* en uso, o ya no está */
      }
    }
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

/** Mientras una exportación lee los fotogramas del disco, NADIE los borra.
 *  La fase ② los borra al montarse y al vaciar su informe, y la ① al
 *  extraer: cualquiera de esas cosas, hecha en otra pestaña de la
 *  aplicación mientras el muxer copiaba, le quitaba los archivos de debajo.
 *  Devuelve la función que suelta el préstamo. (Entre PESTAÑAS distintas no
 *  alcanza: OPFS es del origen, no de la pestaña.) */
export function holdFrames(): () => void {
  readers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    readers--;
  };
}

/** Vacía la caché. Al empezar una extracción y al montar la fase: un
 *  proyecto no sobrevive a la recarga, así que sus archivos tampoco. */
export function clearFrameCache(dirName = DIR): Promise<void> {
  if (readers > 0) {
    console.warn(`[opfs] "${dirName}" kept: an export is reading it`);
    return Promise.resolve();
  }
  dirPromises.delete(dirName);
  if (!supported()) return Promise.resolve();
  clearing = clearing.then(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dirName, { recursive: true });
    } catch {
      /* no existía, o el navegador no deja */
    }
  });
  return clearing;
}

let exportSeq = 0;

/** Un fotograma recompuesto para la exportación, a disco. */
export function storeExportFrame(png: Bytes | Blob): Promise<Blob> {
  return storeFrame(`${++exportSeq}.png`, png, EXPORT);
}

/** Fuera los recompuestos de la exportación anterior: al empezar otra, que
 *  es cuando ya nadie los referencia (el panel bloquea una segunda a la vez). */
export function clearExportCache(): Promise<void> {
  return clearFrameCache(EXPORT);
}

/** Fuera los recortes de la fase ②: al montarla (los de la sesión
 *  anterior) y al vaciar el informe, que es cuando ya nadie los referencia. */
export function clearProcessedCache(): Promise<void> {
  return clearFrameCache(PROCESSED);
}
