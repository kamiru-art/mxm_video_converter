// Estado del proyecto compartido entre fases (vive en memoria).

import { poolSize, run } from './pool.ts';
import type { Bytes, VideoMeta } from './types.ts';
import { context2d } from './ui.ts';
import { decodeVideoFrames } from './video.ts';

/** Un fotograma que vive en su video: se decodifica cuando hace falta. */
export interface VideoRef {
  file: File;
  /** Instante del fotograma, en segundos, tal como lo dio la extracción. */
  t: number;
}

/** Un fotograma cargado en la fase ①: de un video, de una carpeta de
 *  imágenes o del ejemplo. */
export interface ProjectFrame {
  name: string;
  /** El archivo: la imagen de la carpeta, el PNG del ejemplo o el PNG que
   *  dejó ffmpeg.wasm en la caché de disco. Null cuando vive en `video`. */
  blob: Blob | null;
  /** Fotograma decodificable por WebCodecs: no se guarda ningún PNG; el
   *  video es la fuente y se lee de nuevo para las hojas, la vista previa y
   *  la exportación. Así no hay copia intermedia (ni en memoria ni en
   *  calidad) por muchos fotogramas que sean. */
  video?: VideoRef;
  /** Miniatura de 256 px de ancho; se crea bajo demanda (ensureThumb). */
  thumb: OffscreenCanvas | null;
  w: number;
  h: number;
  hasAlpha: boolean;
  /** TIFF y PNG de 16 bits: los decodifica el núcleo Rust, no el navegador. */
  needsWasmDecode?: boolean;
  /** Extraído de un video: nombre del video y posición, para etiquetarlo. */
  videoStem?: string;
  seq?: number;
}

/** RGBA de 8 bits ya decodificado. */
export interface RgbaImage {
  data: Bytes;
  w: number;
  h: number;
}

export interface Project {
  frames: ProjectFrame[];
  videoMeta: VideoMeta;
  /** último layout.json generado (fase ①) */
  layoutJson: string | null;
  /** PNG de las hojas de la última generación (solo proyectos cortos): la
   *  fase ② las usa para simular escaneos sin imprimir nada. */
  sheetImages: Map<string, Blob>;
  /** etiqueta → Blob PNG del fotograma (fase ②) */
  processedFrames: Map<string, Blob>;
}

export const project: Project = {
  frames: [],
  videoMeta: {},
  layoutJson: null,
  sheetImages: new Map(),
  processedFrames: new Map(),
};

const rgbaCache = new Map<string, RgbaImage>(); // `${idx}:${full}` → {data,w,h}
let cacheBytes = 0;

/** Fotogramas de video decodificados por adelantado para la página que se
 *  está generando (prefetchVideoFrames): a resolución nativa, se consumen
 *  UNA vez (frameImageData los saca al entregarlos) y no viven más que la
 *  página, que es lo que gen.ts ya tenía en memoria de todos modos. Cada
 *  pasada empieza vaciándolo: lo que dejó una página fallida no vuelve. */
const prefetched = new Map<VideoRef, RgbaImage>();

function cachePreview(key: string, out: RgbaImage): void {
  rgbaCache.set(key, out);
  cacheBytes += out.data.byteLength;
  while (cacheBytes > 300e6 && rgbaCache.size > 8) {
    const k0 = rgbaCache.keys().next().value;
    if (k0 === undefined) break;
    cacheBytes -= rgbaCache.get(k0)?.data.byteLength ?? 0;
    rgbaCache.delete(k0);
  }
}

/** ImageBitmap → RGBA, entero (maxSide null) o encogido a maxSide. */
function bitmapToRgba(bmp: ImageBitmap, maxSide: number | null): RgbaImage {
  let { width: w, height: h } = bmp;
  if (maxSide && Math.max(w, h) > maxSide) {
    const k = maxSide / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = context2d(c);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h);
  return { data: new Uint8Array(d.data.buffer.slice(0)), w, h };
}

/** Agrupa por archivo los fotogramas de video y decodifica cada grupo en
 *  una pasada, en orden de tiempo, entregando (ref, imagen). */
async function decodeGrouped(
  refs: VideoRef[],
  maxSide: number | null,
  onFrame: (ref: VideoRef, img: RgbaImage) => void,
): Promise<void> {
  const byFile = new Map<File, VideoRef[]>();
  for (const r of refs) {
    const list = byFile.get(r.file) ?? [];
    list.push(r);
    byFile.set(r.file, list);
  }
  for (const [file, list] of byFile) {
    await decodeVideoFrames(
      file,
      list.map((r) => r.t),
      (i, bmp) => onFrame(list[i], bitmapToRgba(bmp, maxSide)),
    );
  }
}

/** Decodifica de golpe, y en orden de tiempo, los fotogramas de video de una
 *  página a resolución nativa (los que no lo son se ignoran). Ver `prefetched`. */
export async function prefetchVideoFrames(refs: VideoRef[]): Promise<void> {
  prefetched.clear();
  await decodeGrouped(refs, null, (ref, img) => prefetched.set(ref, img));
}

/** Lo mismo para la vista previa (640 px): los fotogramas de `idxs` que
 *  viven en un video y aún no están en la caché de vistas previas se
 *  decodifican en una pasada, en vez de abrir el video y buscar uno a uno. */
export async function prefetchPreviews(idxs: number[]): Promise<void> {
  const refs: VideoRef[] = [];
  const keyOf = new Map<VideoRef, string>();
  for (const idx of idxs) {
    const f = project.frames[idx];
    const key = `${idx}:0`;
    if (!f?.video || rgbaCache.has(key) || keyOf.has(f.video)) continue;
    refs.push(f.video);
    keyOf.set(f.video, key);
  }
  await decodeGrouped(refs, 640, (ref, img) => {
    const key = keyOf.get(ref);
    if (key) cachePreview(key, img);
  });
}

/** Un fotograma de video decodificado él solo. */
async function decodeOne(ref: VideoRef): Promise<ImageBitmap> {
  let out: ImageBitmap | null = null;
  await decodeVideoFrames(ref.file, [ref.t], (_i, bmp) => {
    out = bmp;
  });
  if (!out) throw new Error('The video frame could not be decoded.');
  return out;
}

/** PNG sin pérdida a resolución nativa de un fotograma que vive en el video:
 *  se codifica al exportar, en un worker, y solo si se exporta. */
export async function framePng(idx: number): Promise<Blob> {
  const f = project.frames[idx];
  if (f.blob) return f.blob;
  if (!f.video) throw new Error(`Frame ${f.name} has no image.`);
  const bmp = await decodeOne(f.video);
  const r = await run('encode_frame', { image: bmp, png: true }, [bmp]);
  if (!r.png) throw new Error('The frame encoder returned no PNG.');
  return r.png;
}

export interface FramePngs {
  /** Un productor por fotograma, en el orden de `idxs`. */
  get: (() => Promise<Blob>)[];
  /** Para la pasada (si sigue): lo que nadie ha pedido no se codifica. */
  cancel: () => void;
}

/** Los PNG de varios fotogramas para el ZIP, uno tras otro. La primera
 *  llamada a un productor arranca UNA pasada de decodificación en orden de
 *  tiempo (cada paquete una vez) que reparte los PNG entre los workers,
 *  varios a la vez, como en la extracción; sin esto cada entrada del ZIP
 *  abría el video, buscaba y codificaba sola (unos 250 ms por fotograma 4K,
 *  y 227 de ellos son un minuto). La pasada no se adelanta al consumidor
 *  más de `limit` fotogramas, salvo que alguien esté esperando uno (así no
 *  puede bloquearse). Un productor llamado por segunda vez (originals Y
 *  frames a la vez) va por el camino lento en vez de retener todos los
 *  Blobs hasta el final del ZIP. */
export function framePngs(idxs: number[]): FramePngs {
  const limit = poolSize() + 1;
  const results = new Map<number, Promise<Blob>>();
  const waiters = new Map<number, (p: Promise<Blob>) => void>();
  const started = new Set<number>();
  let running = false;
  let cancelled = false;
  let wake: (() => void) | null = null; // la pasada, parada por contrapresión
  const deliver = (i: number, p: Promise<Blob>): void => {
    p.catch(() => {}); // el error sale por el productor que la espere
    const w = waiters.get(i);
    if (w) {
      waiters.delete(i);
      w(p);
    } else results.set(i, p);
  };
  const runPipeline = async (): Promise<void> => {
    const inflight: Promise<unknown>[] = [];
    const byFile = new Map<File, { i: number; ref: VideoRef }[]>();
    idxs.forEach((idx, i) => {
      const f = project.frames[idx];
      if (f.video) {
        const list = byFile.get(f.video.file) ?? [];
        list.push({ i, ref: f.video });
        byFile.set(f.video.file, list);
      } else deliver(i, framePng(idx));
    });
    for (const [file, list] of byFile) {
      await decodeVideoFrames(
        file,
        list.map((e) => e.ref.t),
        async (k, bmp) => {
          if (cancelled) {
            bmp.close();
            throw new Error('cancelled');
          }
          const job = run('encode_frame', { image: bmp, png: true }, [bmp]).then((r) => {
            if (!r.png) throw new Error('The frame encoder returned no PNG.');
            return r.png;
          });
          deliver(list[k].i, job);
          const done: Promise<void> = job
            .then(
              () => {},
              () => {},
            )
            .finally(() => {
              inflight.splice(inflight.indexOf(done), 1);
            });
          inflight.push(done);
          // no más de `limit` codificando: el decodificador espera al resto
          if (inflight.length >= limit) await Promise.race(inflight);
          // ni más de `limit` sin recoger, salvo que alguien espere uno
          while (results.size >= limit && waiters.size === 0 && !cancelled) {
            await new Promise<void>((r) => {
              wake = r;
            });
          }
        },
      );
    }
  };
  const failAll = (err: Error): void => {
    for (const [k, w] of waiters) {
      waiters.delete(k);
      w(Promise.reject(err));
    }
    for (let k = 0; k < idxs.length; k++) {
      if (!results.has(k) && !started.has(k)) deliver(k, Promise.reject(err));
    }
  };
  const get = idxs.map((idx, i) => () => {
    if (started.has(i)) return framePng(idx); // segunda copia: camino lento
    started.add(i);
    if (!running) {
      running = true;
      runPipeline().catch((e: unknown) => {
        // un fallo de la pasada rechaza a todos los que aún esperan
        failAll(e instanceof Error ? e : new Error(String(e)));
      });
    }
    const ready = results.get(i);
    if (ready) {
      results.delete(i);
      wake?.();
      wake = null;
      return ready;
    }
    const p = new Promise<Blob>((res, rej) => {
      waiters.set(i, (q) => q.then(res, rej));
    });
    wake?.(); // hay quien espera: que la pasada siga
    wake = null;
    return p;
  });
  const cancel = (): void => {
    cancelled = true;
    wake?.();
    wake = null;
    failAll(new Error('The export was cancelled.'));
  };
  return { get, cancel };
}

/** Empieza un proyecto: se van los fotogramas Y todo lo derivado de ellos.
 *  Dejar el layout, las hojas o los fotogramas procesados del proyecto
 *  anterior no es "conservar trabajo": la fase ④ los da por buenos y rearma
 *  el video que ya no está en pantalla, mientras cada control visible nombra
 *  el proyecto nuevo. */
export function clearFrames(): void {
  project.frames = [];
  project.videoMeta = {};
  project.layoutJson = null;
  project.sheetImages.clear();
  project.processedFrames.clear();
  rgbaCache.clear();
  cacheBytes = 0;
  prefetched.clear();
}

/** Decodifica un fotograma a RGBA. full=true → resolución nativa. */
export async function frameImageData(idx: number, full: boolean): Promise<RgbaImage> {
  const key = `${idx}:${full ? 1 : 0}`;
  const hit = rgbaCache.get(key);
  if (hit) return hit;
  const f = project.frames[idx];
  let out: RgbaImage;
  if (f.video) {
    // del video: lo que se decodificó por adelantado para esta página, o
    // este fotograma solo (vista previa, lupa)
    const pre = full ? prefetched.get(f.video) : undefined;
    if (pre) {
      prefetched.delete(f.video);
      out = pre;
    } else {
      out = bitmapToRgba(await decodeOne(f.video), full ? null : 640);
    }
  } else if (!f.blob) {
    throw new Error(`Frame ${f.name} has no image.`);
  } else if (f.needsWasmDecode) {
    // TIFF/PNG16: decodifica el núcleo Rust
    const bytes = new Uint8Array(await f.blob.arrayBuffer());
    const r = await run('decode_image', { bytes }, [bytes.buffer]);
    out = shrinkIfNeeded(r.rgba, r.w, r.h, full ? null : 640);
  } else {
    out = bitmapToRgba(await createImageBitmap(f.blob), full ? null : 640);
  }
  // caché acotada (solo tamaños de vista previa)
  if (!full) cachePreview(key, out);
  return out;
}

function shrinkIfNeeded(rgba: Bytes, w: number, h: number, maxSide: number | null): RgbaImage {
  if (!maxSide || Math.max(w, h) <= maxSide) return { data: rgba, w, h };
  const k = maxSide / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * k));
  const nh = Math.max(1, Math.round(h * k));
  const src = new OffscreenCanvas(w, h);
  context2d(src).putImageData(
    new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h),
    0,
    0,
  );
  const dst = new OffscreenCanvas(nw, nh);
  const dctx = context2d(dst);
  dctx.drawImage(src, 0, 0, nw, nh);
  const d = dctx.getImageData(0, 0, nw, nh);
  return { data: new Uint8Array(d.data.buffer.slice(0)), w: nw, h: nh };
}

/** Miniatura como OffscreenCanvas (para dedup/histograma/vista de tira). */
export async function ensureThumb(idx: number): Promise<OffscreenCanvas> {
  const f = project.frames[idx];
  if (f.thumb) return f.thumb;
  const { data, w, h } = await frameImageData(idx, false);
  const tw = 256;
  const th = Math.max(1, Math.round((h / w) * tw));
  const src = new OffscreenCanvas(w, h);
  context2d(src).putImageData(
    new ImageData(new Uint8ClampedArray(data.buffer.slice(0)), w, h),
    0,
    0,
  );
  const c = new OffscreenCanvas(tw, th);
  context2d(c).drawImage(src, 0, 0, tw, th);
  f.thumb = c;
  return c;
}
