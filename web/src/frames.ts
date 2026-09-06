// Salida común de los dos decodificadores de video (WebCodecs en video.ts,
// ffmpeg.wasm en avi.ts). Cada fotograma decodificado viaja a un worker del
// pool, que lo codifica a PNG y saca la miniatura; el hilo principal solo lo
// reenvía. Los fotogramas se entregan a la aplicación EN ORDEN y con pocos en
// vuelo, así que un decodificador rápido no se adelanta a la memoria.
//
// Por qué en workers: codificar un fotograma 4K a PNG cuesta ~160 ms en
// Chrome, y se hacía en el hilo principal, un fotograma detrás de otro, con
// el decodificador parado mientras tanto (un clip Lumix de 56 s a 4 fps:
// 227 fotogramas, 36 s). Cuatro workers codificando a la vez bajan el coste
// efectivo a ~60 ms por fotograma, y el decodificador (por hardware, ~300
// fps en 4K) ya no espera a nadie. El PNG lo sigue haciendo el navegador,
// con el mismo resultado byte a byte: lienzo opaco, RGB de 8 bits.

import type { EncodedFrame, FrameSource, RawRgba } from './commands.ts';
import { poolSize, run } from './pool.ts';
import type { Bytes } from './types.ts';
import { context2d } from './ui.ts';
import type { ExtractOptions } from './video.ts';

/** Ancho de la miniatura que usan la tira, el dedup y el histograma. */
const THUMB_W = 256;

/** ImageBitmap → RGBA crudo, en el hilo principal (una lectura de la GPU:
 *  ~15 ms en 4K). Es el camino de reserva cuando el navegador no dibuja bien
 *  un ImageBitmap transferido a un worker. El bitmap se cierra. */
export function bitmapToRaw(bmp: ImageBitmap): RawRgba {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = context2d(c, { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { rgba: new Uint8Array(d.data.buffer) as Bytes, w: c.width, h: c.height };
}

let bitmapPathOk: Promise<boolean> | null = null;

/** ¿Llega bien un ImageBitmap transferido al worker? Se prueba UNA vez con un
 *  degradado conocido: el worker devuelve su miniatura al mismo tamaño y se
 *  compara píxel a píxel. Safari dibujaba otra cosa (bandas de otros
 *  fotogramas) y la vista de miniaturas salía rota; con la prueba, ese
 *  navegador manda los píxeles crudos y el resultado es el mismo en todos. */
export function transferableBitmapsWork(): Promise<boolean> {
  if (!bitmapPathOk) {
    bitmapPathOk = (async () => {
      // del tamaño de un fotograma de verdad a escala: un fallo de la GPU
      // con un lienzo grande no tiene por qué verse en uno de 64 píxeles
      const w = 1024;
      const h = 576;
      const src = new OffscreenCanvas(w, h);
      const ctx = context2d(src);
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          img.data[i] = Math.round((x / (w - 1)) * 255);
          img.data[i + 1] = Math.round((y / (h - 1)) * 255);
          img.data[i + 2] = 128;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      try {
        const bmp = await createImageBitmap(src);
        const r = await run('encode_frame', { image: bmp, thumbW: w, png: false }, [bmp]);
        if (!r.thumb || r.thumb.w !== w || r.thumb.h !== h) return false;
        let diff = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          diff +=
            Math.abs(r.thumb.rgba[i] - img.data[i]) +
            Math.abs(r.thumb.rgba[i + 1] - img.data[i + 1]);
        }
        const ok = diff / (w * h) < 4;
        if (!ok)
          console.warn(
            '[frames] transferred ImageBitmaps render wrong here: sending raw pixels instead',
          );
        return ok;
      } catch (e) {
        // un worker que no arrancó esta vez no dice nada del navegador: se
        // usa el camino seguro ahora y se vuelve a probar en la próxima
        console.warn('[frames] ImageBitmap self-test could not run, sending raw pixels:', e);
        bitmapPathOk = null;
        return false;
      }
    })();
  }
  return bitmapPathOk;
}

/** Lo que se manda al worker: el ImageBitmap tal cual si el navegador lo
 *  transfiere bien, o sus píxeles. */
export async function frameSource(bmp: ImageBitmap): Promise<FrameSource> {
  return (await transferableBitmapsWork()) ? bmp : bitmapToRaw(bmp);
}

interface Job {
  result: Promise<EncodedFrame>;
  /** Instante del fotograma en el video, en segundos. */
  t: number;
}

export class FrameQueue {
  private jobs: Job[] = [];
  /** En vuelo como mucho: uno por worker y otro esperando a que uno se
   *  libere. Cada fotograma 4K en vuelo son ~33 MB en el worker. */
  private readonly limit = poolSize() + 1;
  /** Fotogramas ya entregados a onFrame; también el índice del siguiente. */
  count = 0;
  /** Falló la codificación o el onFrame de la aplicación, no el
   *  decodificador: quien llama no debe reintentar con otro decodificador. */
  failed = false;
  private readonly opts: ExtractOptions;
  private readonly est: number | null;
  private readonly png: boolean;

  /** `png` lo decide el decodificador, no `opts.lazy`: WebCodecs puede
   *  volver a decodificar y lo omite; ffmpeg.wasm no puede y lo entrega
   *  siempre, con la misma `opts`. */
  constructor(opts: ExtractOptions, est: number | null, png: boolean) {
    this.opts = opts;
    this.est = est;
    this.png = png;
  }

  /** Encola un fotograma. Solo espera si hay demasiados en vuelo. */
  async push(source: FrameSource, t: number): Promise<void> {
    const image = 'rgba' in source ? source : await frameSource(source);
    const transfer: Transferable[] = 'rgba' in image ? [image.rgba.buffer] : [image];
    const png = this.png;
    const result = run('encode_frame', { image, thumbW: THUMB_W, png }, transfer);
    // el error sale por emit(), en orden; sin esto una promesa que aún nadie
    // espera avisaría de "unhandled rejection"
    result.catch(() => {});
    this.jobs.push({ result, t });
    while (this.jobs.length > this.limit) await this.emit();
  }

  /** Entrega lo que queda en vuelo. */
  async finish(): Promise<void> {
    while (this.jobs.length) await this.emit();
  }

  private async emit(): Promise<void> {
    const job = this.jobs.shift();
    if (!job) return;
    try {
      const { png, thumb, w, h } = await job.result;
      if (!thumb) throw new Error('The frame encoder returned no thumbnail.');
      // ProjectFrame.thumb es un OffscreenCanvas: los píxeles se vuelcan en uno
      const canvas = new OffscreenCanvas(thumb.w, thumb.h);
      context2d(canvas).putImageData(
        new ImageData(new Uint8ClampedArray(thumb.rgba.buffer), thumb.w, thumb.h),
        0,
        0,
      );
      await this.opts.onFrame?.(png, canvas, job.t, this.count, w, h);
      this.count++;
      this.opts.onProgress?.(this.count, this.est);
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
}
