// La cabecera de una imagen (tamaño, profundidad, alfa) sin decodificarla.
// Lo usan la carga de una carpeta en la fase ① y el video final: los dos
// necesitan saber si un archivo trae 16 bits antes de decidir qué hacer con
// él, y decodificar entero un TIFF de 4K para eso son 50 MB para nada.

import { run } from './pool.ts';
import type { ImageInfo } from './types.ts';

export interface FrameInfo extends ImageInfo {
  /** Tipo de color del PNG (2 RGB, 6 RGBA…); -1 si no es PNG. */
  colour: number;
}

/** Un TIFF casi siempre tiene su directorio al principio: se prueba con el
 *  primer mega y, si no llega, con el archivo entero. */
const HEAD_BYTES = 1 << 20;

/** Cabecera de una imagen. Un PNG se lee de su IHDR (26 bytes); lo demás
 *  (TIFF, JPEG, WebP, BMP) lo mira el núcleo sin decodificar los píxeles.
 *  Lanza si el núcleo no reconoce el formato. */
export async function imageInfo(blob: Blob): Promise<FrameInfo> {
  const head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  // la firma Y el tag IHDR: un CgBI (PNG de iPhone) trae otro chunk antes
  const isPng =
    head.length >= 26 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[12] === 0x49 &&
    head[13] === 0x48 &&
    head[14] === 0x44 &&
    head[15] === 0x52;
  if (isPng) {
    const dv = new DataView(head.buffer);
    const colour = head[25];
    return {
      w: dv.getUint32(16),
      h: dv.getUint32(20),
      sixteen: head[24] === 16,
      alpha: colour === 4 || colour === 6,
      png: true,
      colour,
    };
  }
  const probe = async (b: Blob): Promise<ImageInfo> => {
    const bytes = new Uint8Array(await b.arrayBuffer());
    return run('probe_image', { bytes }, [bytes.buffer]);
  };
  let info: ImageInfo;
  try {
    info = await probe(blob.size > HEAD_BYTES ? blob.slice(0, HEAD_BYTES) : blob);
  } catch (e) {
    if (blob.size <= HEAD_BYTES) throw e;
    info = await probe(blob);
  }
  return { ...info, colour: -1 };
}
