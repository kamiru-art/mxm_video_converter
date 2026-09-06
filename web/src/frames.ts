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

import type { EncodedFrame, FrameSource } from './commands.ts';
import { poolSize, run } from './pool.ts';
import { context2d } from './ui.ts';
import type { ExtractOptions } from './video.ts';

/** Ancho de la miniatura que usan la tira, el dedup y el histograma. */
const THUMB_W = 256;

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
  async push(image: FrameSource, t: number): Promise<void> {
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
      // ProjectFrame.thumb es un OffscreenCanvas; el ImageBitmap del worker
      // se vuelca en uno y se cierra
      const canvas = new OffscreenCanvas(thumb.width, thumb.height);
      context2d(canvas).drawImage(thumb, 0, 0);
      thumb.close();
      await this.opts.onFrame?.(png, canvas, job.t, this.count, w, h);
      this.count++;
      this.opts.onProgress?.(this.count, this.est);
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }
}
