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

const DIR = 'frames';

let dirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;
/** Un vaciado en curso: la carpeta no se vuelve a crear hasta que termine,
 *  o el borrado se llevaría por delante los archivos nuevos. */
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
