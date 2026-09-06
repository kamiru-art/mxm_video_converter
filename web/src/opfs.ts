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

const DIR = 'frames';
/** Salidas (el ZIP y el PDF a medio armar): escritas a trozos, nunca enteras
 *  en memoria. Un Blob leído de aquí lo sirve el disco. */
const OUT = 'out';

let dirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;
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

function cacheDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!dirPromise) {
    dirPromise = (async () => {
      if (!supported()) return null;
      await clearing;
      try {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle(DIR, { create: true });
      } catch {
        return null; // sin cuota, modo privado, política del navegador…
      }
    })();
  }
  return dirPromise;
}

/** Guarda `blob` en disco y devuelve un Blob respaldado por el archivo. Si
 *  no se puede, devuelve el mismo `blob` (en memoria): nunca falla. */
export async function storeFrame(name: string, blob: Blob): Promise<Blob> {
  const dir = await cacheDir();
  if (!dir) return blob;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return await handle.getFile();
  } catch (e) {
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.warn(`[opfs] frame kept in memory (${err})`);
    return blob;
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

/** Vacía la caché. Al empezar una extracción y al montar la fase: un
 *  proyecto no sobrevive a la recarga, así que sus archivos tampoco. */
export function clearFrameCache(): Promise<void> {
  dirPromise = null;
  if (!supported()) return Promise.resolve();
  clearing = clearing.then(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(DIR, { recursive: true });
    } catch {
      /* no existía, o el navegador no deja */
    }
  });
  return clearing;
}
