// Empaquetado ZIP en streaming: los PNG ya vienen comprimidos, así que se
// guardan sin recomprimir. Cada trozo del ZIP va a un archivo de salida
// (opfs.ts): al disco privado del navegador si se puede, y si no a Blobs por
// bloques en memoria. Así un proyecto de decenas de GB no vive nunca entero
// en la memoria de la pestaña ni en el almacén de Blobs del navegador, que
// en Chrome depende del espacio libre del disco del sistema y se agotaba con
// 0,7 GB en una máquina llena. El formato lo escribe zipwriter.ts (ZIP64).

import { type OutputFile, openOutput } from './opfs.ts';
import type { Bytes } from './types.ts';
import { ZipWriter } from './zipwriter.ts';

/** Contenido de una entrada: bytes ya en memoria, un Blob que se lee al
 *  llegar su turno, o una función que lo produce al llegar su turno (un
 *  fotograma que vive en el video y se codifica a PNG solo para exportar). */
export type ZipEntryData = Bytes | Blob | (() => Promise<Bytes | Blob>);

/** Un Blob grande entra en el ZIP por rebanadas de este tamaño. */
const SLICE = 32e6;

/** Un ZIP que se escribe entrada a entrada, en el orden en que se añaden.
 *  Abrir, `add` por cada archivo, `finish` para obtener el Blob; `abort`
 *  si la generación falla, para no dejar el archivo a medias en el disco. */
export class ZipSink {
  private readonly out: OutputFile;
  private readonly zip: ZipWriter;
  private ended = false;

  private constructor(out: OutputFile) {
    this.out = out;
    this.zip = new ZipWriter((chunk) => out.write(chunk as Bytes));
  }

  static async open(name: string): Promise<ZipSink> {
    return new ZipSink(await openOutput(name, 'application/zip'));
  }

  /** 'disk' (OPFS) o 'memory'. */
  get where(): 'disk' | 'memory' {
    return this.out.where;
  }

  /** Añade una entrada entera. Un Blob grande se lee por rebanadas, y cada
   *  trozo del ZIP se escribe antes de leer la siguiente: la memoria no
   *  crece con el tamaño de la entrada. */
  async add(name: string, data: ZipEntryData): Promise<void> {
    if (this.ended) throw new Error('The ZIP is already finished.');
    let ready: Bytes | Blob;
    try {
      ready = typeof data === 'function' ? await data() : data;
    } catch (e) {
      // "NotReadableError" a secas no dice nada: el navegador se quedó sin
      // sitio para los Blobs (memoria y, detrás, disco libre del sistema) y
      // uno de los ya creados no se puede leer. Decir CUÁL y por qué.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Could not read "${name}" while packing the ZIP (${msg}). The browser ran out of room for the files of this project: ` +
          'generate fewer sheets at a time, turn off TIFF or the frame files, or free disk space.',
      );
    }
    await this.zip.begin(name);
    if (ready instanceof Blob) {
      for (let off = 0; off < ready.size; off += SLICE) {
        await this.zip.write(new Uint8Array(await ready.slice(off, off + SLICE).arrayBuffer()));
      }
    } else {
      await this.zip.write(ready);
    }
    await this.zip.end();
  }

  /** Cierra el ZIP y devuelve el archivo entero como Blob. */
  async finish(): Promise<Blob> {
    if (this.ended) throw new Error('The ZIP is already finished.');
    this.ended = true;
    await this.zip.finish();
    return this.out.close();
  }

  /** Descarta el archivo a medias. */
  async abort(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.out.abort();
  }
}

/** files: Map<nombre, contenido>. Devuelve un Blob ZIP. */
export async function makeZip(
  files: Map<string, ZipEntryData>,
  onProgress: (i: number, n: number) => void = () => {},
): Promise<Blob> {
  const sink = await ZipSink.open(`zip-${Date.now()}.zip`);
  try {
    let i = 0;
    for (const [name, data] of files) {
      await sink.add(name, data);
      i++;
      onProgress(i, files.size);
      // ceder el hilo para que la interfaz respire
      if (i % 5 === 0) await new Promise((r) => setTimeout(r));
    }
    return await sink.finish();
  } catch (e) {
    await sink.abort();
    throw e;
  }
}
