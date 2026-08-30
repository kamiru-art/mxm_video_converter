// Estado del proyecto compartido entre fases (vive en memoria).

import { run } from './pool.js';

export const project = {
  /** [{name, blob, thumb (OffscreenCanvas), w, h, hasAlpha, needsWasmDecode}] */
  frames: [],
  videoMeta: {},
  /** deduplicación: null o {reps: [idx], repOf: [idx]} sobre la SELECCIÓN */
  layoutJson: null,       // último layout.json generado (fase ①)
  /** PNG de las hojas de la última generación (solo proyectos cortos): la
   *  fase ② las usa para simular escaneos sin imprimir nada. */
  sheetImages: new Map(),  // nombre de hoja → Blob PNG
  processedFrames: new Map(), // etiqueta → {png: Uint8Array} (fase ②)
  lastReport: null,
};

const rgbaCache = new Map(); // `${idx}:${full}` → {data,w,h}
let cacheBytes = 0;

export function clearFrames() {
  project.frames = [];
  project.videoMeta = {};
  rgbaCache.clear();
  cacheBytes = 0;
}

/** Decodifica un fotograma a RGBA. full=true → resolución nativa. */
export async function frameImageData(idx, full) {
  const key = `${idx}:${full ? 1 : 0}`;
  const hit = rgbaCache.get(key);
  if (hit) return hit;
  const f = project.frames[idx];
  let out;
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
    const ctx = c.getContext('2d');
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
      cacheBytes -= rgbaCache.get(k0).data.byteLength;
      rgbaCache.delete(k0);
    }
  }
  return out;
}

function shrinkIfNeeded(rgba, w, h, maxSide) {
  if (!maxSide || Math.max(w, h) <= maxSide) return { data: rgba, w, h };
  const k = maxSide / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * k));
  const nh = Math.max(1, Math.round(h * k));
  const src = new OffscreenCanvas(w, h);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), w, h), 0, 0);
  const dst = new OffscreenCanvas(nw, nh);
  dst.getContext('2d').drawImage(src, 0, 0, nw, nh);
  const d = dst.getContext('2d').getImageData(0, 0, nw, nh);
  return { data: new Uint8Array(d.data.buffer.slice(0)), w: nw, h: nh };
}

/** Miniatura como OffscreenCanvas (para dedup/histograma/vista de tira). */
export async function ensureThumb(idx) {
  const f = project.frames[idx];
  if (f.thumb) return f.thumb;
  const { data, w, h } = await frameImageData(idx, false);
  const tw = 256;
  const th = Math.max(1, Math.round((h / w) * tw));
  const src = new OffscreenCanvas(w, h);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer.slice(0)), w, h), 0, 0);
  const c = new OffscreenCanvas(tw, th);
  c.getContext('2d').drawImage(src, 0, 0, tw, th);
  f.thumb = c;
  return c;
}
