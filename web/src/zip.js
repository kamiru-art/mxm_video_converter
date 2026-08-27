// Empaquetado ZIP en streaming (fflate): los PNG ya vienen comprimidos,
// así que se guardan sin recomprimir (nivel 0). Los trozos se consolidan en
// Blobs por bloques: el navegador puede paginarlos a disco y la pestaña no
// retiene cientos de MB en ArrayBuffers mientras se arma el ZIP.

import { Zip, ZipPassThrough } from 'fflate';

const PART_BYTES = 32e6;

/** files: Map<nombre, Uint8Array|Blob>. Devuelve un Blob ZIP. */
export async function makeZip(files, onProgress = () => {}) {
  const parts = [];
  let chunks = [];
  let chunkBytes = 0;
  const flush = () => {
    if (chunks.length) {
      parts.push(new Blob(chunks));
      chunks = [];
      chunkBytes = 0;
    }
  };
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const zip = new Zip((err, chunk, final) => {
    if (err) return rejectDone(err);
    if (chunk) {
      chunks.push(chunk);
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
