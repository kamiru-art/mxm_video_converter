// Lectura de ZIP, lo justo para sacar fuentes de los paquetes en que se
// descargan: entradas guardadas (método 0) o comprimidas con deflate
// (método 8), descomprimidas con DecompressionStream. Sin ZIP64 ni cifrado:
// un paquete de fuentes no los usa, y si llega uno se dice por qué no entra.

import type { Bytes } from './types.ts';

export interface ZipEntry {
  /** Ruta dentro del ZIP («Familia/Regular/Familia.ttf»). */
  path: string;
  size: number;
  read: () => Promise<Bytes>;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function inflateRaw(data: Bytes): Promise<Bytes> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Las entradas (sin las carpetas) del ZIP `buf`. Lanza si no es un ZIP
 *  que se pueda leer. */
export function zipEntries(buf: Bytes): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // el final del directorio: 22 bytes, más un comentario de hasta 64 KB
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (dv.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  if (end < 0) throw new Error('This is not a ZIP file that can be read.');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  if (count === 0xffff || p === 0xffffffff)
    throw new Error('This ZIP is in the ZIP64 format; unzip it and upload the fonts inside.');
  const utf8 = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== CENTRAL)
      throw new Error('This ZIP is damaged: its file list is cut short.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const path = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue;
    out.push({
      path,
      size,
      read: async () => {
        if (flags & 1) throw new Error('It is encrypted inside the ZIP; unzip it first.');
        if (local + 30 > buf.length || dv.getUint32(local, true) !== LOCAL)
          throw new Error('The ZIP is damaged at this file.');
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const raw = buf.subarray(start, start + csize);
        if (raw.length !== csize) throw new Error('The ZIP is cut short at this file.');
        if (method === 0) return raw.slice();
        if (method === 8) return inflateRaw(raw);
        throw new Error(`It is compressed with method ${method}, which this page cannot open.`);
      },
    });
  }
  return out;
}
