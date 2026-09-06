// Empaquetado ZIP en streaming (fflate): los PNG ya vienen comprimidos,
// así que se guardan sin recomprimir (nivel 0). Los trozos se consolidan en
// Blobs por bloques: el navegador puede paginarlos a disco y la pestaña no
// retiene cientos de MB en ArrayBuffers mientras se arma el ZIP.

import { Zip, ZipPassThrough } from 'fflate';
import type { Bytes } from './types.ts';

const PART_BYTES = 32e6;

/** Contenido de una entrada: bytes ya en memoria o un Blob que se lee al
 *  llegar su turno. */
export type ZipEntryData = Bytes | Blob;

/** files: Map<nombre, Uint8Array|Blob>. Devuelve un Blob ZIP. */
export async function makeZip(
  files: Map<string, ZipEntryData>,
  onProgress: (i: number, n: number) => void = () => {},
): Promise<Blob> {
  const parts: Blob[] = [];
  let chunks: Bytes[] = [];
  let chunkBytes = 0;
  const flush = (): void => {
    if (chunks.length) {
      parts.push(new Blob(chunks));
      chunks = [];
      chunkBytes = 0;
    }
  };
  let resolveDone: () => void = () => {};
  let rejectDone: (e: Error) => void = () => {};
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      rejectDone(err);
      return;
    }
    if (chunk) {
      chunks.push(chunk as Bytes); // fflate reserva sus propios ArrayBuffer
      chunkBytes += chunk.byteLength;
      if (chunkBytes >= PART_BYTES) flush();
    }
    if (final) resolveDone();
  });
  let i = 0;
  for (const [name, data] of files) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    entry.push(bytes, true);
    i++;
    onProgress(i, files.size);
    // ceder el hilo para que la interfaz respire
    if (i % 5 === 0) await new Promise((r) => setTimeout(r));
  }
  zip.end();
  await done;
  flush();
  return new Blob(parts, { type: 'application/zip' });
}
