// Empaquetado ZIP en streaming (fflate): los PNG ya vienen comprimidos,
// así que se guardan sin recomprimir (nivel 0).

import { Zip, ZipPassThrough } from 'fflate';

/** files: Map<nombre, Uint8Array|Blob>. Devuelve un Blob ZIP. */
export async function makeZip(files, onProgress = () => {}) {
  const chunks = [];
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const zip = new Zip((err, chunk, final) => {
    if (err) return rejectDone(err);
    if (chunk) chunks.push(chunk);
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
  return new Blob(chunks, { type: 'application/zip' });
}
