// Estado del proyecto compartido entre fases (vive en memoria).

import { run } from './pool.ts';
import type { Bytes, ScanResult, VideoMeta } from './types.ts';
import { context2d } from './ui.ts';

/** Un fotograma cargado en la fase ①: de un video, de una carpeta de
 *  imágenes o del ejemplo. */
export interface ProjectFrame {
  name: string;
  blob: Blob;
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
  lastReport: ScanResult[] | null;
}

export const project: Project = {
  frames: [],
  videoMeta: {},
  layoutJson: null,
  sheetImages: new Map(),
  processedFrames: new Map(),
  lastReport: null,
};

const rgbaCache = new Map<string, RgbaImage>(); // `${idx}:${full}` → {data,w,h}
let cacheBytes = 0;

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
  project.lastReport = null;
  rgbaCache.clear();
  cacheBytes = 0;
}

/** Decodifica un fotograma a RGBA. full=true → resolución nativa. */
export async function frameImageData(idx: number, full: boolean): Promise<RgbaImage> {
  const key = `${idx}:${full ? 1 : 0}`;
  const hit = rgbaCache.get(key);
  if (hit) return hit;
  const f = project.frames[idx];
  let out: RgbaImage;
  if (f.needsWasmDecode) {
    // TIFF/PNG16: decodifica el núcleo Rust
    const bytes = new Uint8Array(await f.blob.arrayBuffer());
    const r = await run('decode_image', { bytes }, [bytes.buffer]);
    out = shrinkIfNeeded(r.rgba, r.w, r.h, full ? null : 640);
  } else {
    const bmp = await createImageBitmap(f.blob);
    const maxSide = full ? null : 640;
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
    out = { data: new Uint8Array(d.data.buffer.slice(0)), w, h };
  }
  // caché acotada (solo tamaños de vista previa)
  if (!full) {
    rgbaCache.set(key, out);
    cacheBytes += out.data.byteLength;
    while (cacheBytes > 300e6 && rgbaCache.size > 8) {
      const k0 = rgbaCache.keys().next().value;
      if (k0 === undefined) break;
      cacheBytes -= rgbaCache.get(k0)?.data.byteLength ?? 0;
      rgbaCache.delete(k0);
    }
  }
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
