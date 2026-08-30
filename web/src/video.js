// Video en el navegador: extracción de fotogramas (WebCodecs vía mediabunny)
// y reconstrucción del video final. Sustituye al ffmpeg de la app original.
//
// Filosofía de calidad: cada fotograma extraído se guarda como PNG (sin
// pérdida) a resolución nativa; no se aplica ningún filtro de color.

import {
  Input, Output, BlobSource, BufferTarget, ALL_FORMATS,
  CanvasSink, CanvasSource, Mp4OutputFormat, WebMOutputFormat,
  QUALITY_LOW, QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { run, recycleIdle } from './pool.js';

// ffmpeg.wasm cubre lo que WebCodecs no: contenedores que mediabunny no abre
// (AVI, MPG…) y códecs que el navegador no decodifica aunque el contenedor
// sea legible (los MOV de cámara: HEVC 10 bits, ProRes, DNxHD…). La detección
// no va por extensión sino por lo que este navegador pueda decodificar.

async function probeMediabunny(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('The file has no video track (or the format is not supported).');
  const duration = await input.computeDuration();
  let fps = 0;
  try {
    const stats = await track.computePacketStats(120);
    fps = stats.averagePacketRate || 0;
  } catch { /* algunos contenedores no lo informan */ }
  return { input, track, duration, fps, width: track.displayWidth, height: track.displayHeight };
}

export async function probeVideo(file) {
  try {
    return await probeMediabunny(file);
  } catch (e) {
    // mediabunny no abre el contenedor: que lo intente ffmpeg.wasm; si
    // tampoco puede, el error original es el informativo
    try {
      const { probeFallback } = await import('./avi.js');
      return await probeFallback(file);
    } catch {
      throw e;
    }
  }
}

/**
 * Extrae fotogramas como PNG lossless a resolución nativa.
 * opts: {start, end, fps (null = todos), onFrame(blob, thumbCanvas, t, i), onProgress(i, est)}
 * Devuelve el número de fotogramas extraídos.
 */
export async function extractFrames(file, opts = {}) {
  const useFallback = async () => {
    const { extractFramesFallback } = await import('./avi.js');
    return extractFramesFallback(file, opts);
  };
  let probe;
  try {
    probe = await probeMediabunny(file);
  } catch (e) {
    try {
      return await useFallback();
    } catch {
      throw e;
    }
  }
  // contenedor legible pero códec fuera del alcance de WebCodecs en este
  // navegador (MOV HEVC 10 bits de cámara, ProRes…): decodificar con ffmpeg
  if (!(await probe.track.canDecode())) {
    console.warn(`[video] ${file.name}: WebCodecs cannot decode this codec here; using the ffmpeg.wasm decoder (slower).`);
    return useFallback();
  }
  const { track, duration, fps: nativeFps } = probe;
  const start = Math.max(0, opts.start ?? 0);
  const end = Math.min(duration, opts.end ?? duration);
  const sink = new CanvasSink(track, { poolSize: 2 });
  let count = 0;

  let emitFailed = false; // distingue fallos del decodificador de fallos de la app
  const emit = async (wrapped, index) => {
    try {
      const canvas = wrapped.canvas;
      // PNG sin pérdida a resolución nativa
      const blob = await canvasToBlob(canvas, 'image/png');
      // miniatura para la interfaz / dedup / histograma
      const tw = 256;
      const th = Math.max(1, Math.round((canvas.height / canvas.width) * tw));
      const thumb = new OffscreenCanvas(tw, th);
      thumb.getContext('2d').drawImage(canvas, 0, 0, tw, th);
      await opts.onFrame?.(blob, thumb, wrapped.timestamp, index, canvas.width, canvas.height);
    } catch (e) {
      emitFailed = true;
      throw e;
    }
  };

  try {
    if (opts.fps && opts.fps > 0) {
      const times = [];
      for (let t = start; t < end - 1e-9; t += 1 / opts.fps) times.push(t);
      if (!times.length) times.push(start);
      let i = 0;
      for await (const wrapped of sink.canvasesAtTimestamps(times)) {
        if (opts.cancelled?.()) break;
        if (wrapped) {
          // count, NO i: canvasesAtTimestamps devuelve null cuando no hay
          // fotograma para ese instante (clip recortado, primer PTS > 0), y
          // con i el primer fotograma se llamaba clip_000003.png, así que las
          // etiquetas impresas dejaban de casar con la línea de tiempo.
          await emit(wrapped, count);
          count++;
        }
        i++;
        opts.onProgress?.(i, times.length);
      }
    } else {
      const est = nativeFps ? Math.round((end - start) * nativeFps) : null;
      let i = 0;
      for await (const wrapped of sink.canvases(start, end)) {
        if (opts.cancelled?.()) break;
        await emit(wrapped, count);
        count++;
        i++;
        opts.onProgress?.(i, est);
      }
    }
  } catch (e) {
    // canDecode dijo que sí pero el decodificador falló antes de dar nada:
    // último intento con ffmpeg.wasm. Un fallo DENTRO de emit (onFrame de la
    // app, cuota de memoria) no es del decodificador: se propaga tal cual.
    if (count === 0 && !emitFailed) {
      console.warn('[video] WebCodecs decode failed, retrying with ffmpeg.wasm:', e);
      return useFallback();
    }
    throw e;
  }
  return { count, fps: opts.fps || nativeFps || 12, duration, origen: file.name };
}

function canvasToBlob(canvas, type) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type });
  return new Promise((res) => canvas.toBlob(res, type));
}

/** Encaja `bmp` centrado en w×h. El reescalado va por el núcleo WASM
 *  (Lanczos3 con antialias, el mismo filtro de las hojas); si el núcleo no
 *  puede, cae al drawImage del navegador en su calidad más alta.
 *  Devuelve {img, dx, dy} cuando reescaló por WASM (cacheable), si no null. */
async function drawFrameFitted(ctx, bmp, w, h) {
  const s = Math.min(w / bmp.width, h / bmp.height);
  const dw = Math.max(1, Math.round(bmp.width * s));
  const dh = Math.max(1, Math.round(bmp.height * s));
  const dx = Math.round((w - dw) / 2);
  const dy = Math.round((h - dh) / 2);
  if (dw === bmp.width && dh === bmp.height) {
    ctx.drawImage(bmp, dx, dy);
    return null;
  }
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height);
    const rgba = new Uint8Array(d.data.buffer);
    const out = await run('resize_rgba', { rgba, w: bmp.width, h: bmp.height, outW: dw, outH: dh }, [rgba.buffer]);
    const img = new ImageData(new Uint8ClampedArray(out.buffer), dw, dh);
    ctx.putImageData(img, dx, dy);
    return { img, dx, dy };
  } catch (e) {
    console.warn('[video] WASM resize failed, using canvas scaling:', e);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, dx, dy, dw, dh);
    return null;
  }
}

/**
 * Reconstruye el video a partir de una secuencia de imágenes (Blob/bytes PNG).
 * frames: array de () => Promise<ImageBitmap> EN ORDEN (con repetidos).
 * opts: { format: 'auto'|'mp4'|'webm', quality: 'very_high'|'high'|'medium'|
 *         'low'|'custom', bitrateMbps: number (con quality='custom'),
 *         targetH: number (0 = resolución nativa de los frames) }
 * Devuelve {bytes, mime, ext}.
 */
export async function buildVideo(frameGetters, fps, onProgress, opts = {}) {
  if (!frameGetters.length) throw new Error('There are no frames to build the video.');
  // dimensiones del primero, escaladas a la resolución pedida y normalizadas
  // a pares (requisito H.264)
  const first = await frameGetters[0]();
  let fw = first.width;
  let fh = first.height;
  if (opts.targetH > 0) {
    fw = fw * (opts.targetH / fh);
    fh = opts.targetH;
  }
  const w = Math.max(2, Math.round(fw / 2) * 2);
  const h = Math.max(2, Math.round(fh / 2) * 2);

  const QUAL = {
    very_high: QUALITY_VERY_HIGH, high: QUALITY_HIGH,
    medium: QUALITY_MEDIUM, low: QUALITY_LOW,
  };
  let bitrate = QUAL[opts.quality] ?? QUALITY_HIGH;
  if (opts.quality === 'custom' && opts.bitrateMbps > 0) {
    // el max del input HTML no frena lo tecleado: tope real aquí
    bitrate = Math.round(Math.min(500, opts.bitrateMbps) * 1e6);
  } else if (opts.quality === 'max') {
    // "visualmente sin pérdida": ~0.5 bits por píxel y frame, con tope.
    // Los codificadores del navegador (WebCodecs) siguen siendo lossy; el
    // modo verdaderamente sin pérdida es buildVideoLossless (PNG en MOV).
    bitrate = Math.min(500e6, Math.max(20e6, Math.round(w * h * fps * 0.5)));
  }

  let candidates = [
    { codec: 'avc', format: () => new Mp4OutputFormat(), mime: 'video/mp4', ext: 'mp4' },
    { codec: 'vp9', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
    { codec: 'av1', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
    { codec: 'vp8', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
  ];
  if (opts.format === 'mp4') candidates = candidates.slice(0, 1);
  else if (opts.format === 'webm') candidates = candidates.slice(1);
  let chosen = null;
  for (const c of candidates) {
    const ok = await getFirstEncodableVideoCodec([c.codec], { width: w, height: h });
    if (ok) { chosen = c; break; }
  }
  if (!chosen) {
    throw new Error(opts.format && opts.format !== 'auto'
      ? `This browser cannot encode ${opts.format.toUpperCase()} at ${w}×${h}. Try "Automatic" format, a lower resolution, or the Lossless quality (it works at any resolution).`
      : `This browser cannot encode video at ${w}×${h} (WebCodecs unavailable or resolution too high). Try a lower resolution, or the Lossless quality: it works at any resolution, including 8K.`);
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const target = new BufferTarget();
  const output = new Output({ format: chosen.format(), target });
  const source = new CanvasSource(canvas, { codec: chosen.codec, bitrate });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const dur = 1 / fps;
  // caché de reescalados por getter: los dibujos deduplicados se repiten en
  // la línea de tiempo (la fase ④ reusa el MISMO getter por dibujo) y volver
  // a pasar cada repetición por Lanczos sería trabajo tirado. Presupuesto en
  // bytes; al llenarse, las repeticiones restantes se reescalan de nuevo.
  const scaled = new Map(); // getter → {img, dx, dy}
  let scaledBytes = 0;
  const SCALED_BUDGET = 300e6;
  for (let i = 0; i < frameGetters.length; i++) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    const hit = scaled.get(frameGetters[i]);
    if (hit) {
      ctx.putImageData(hit.img, hit.dx, hit.dy);
    } else {
      const bmp = i === 0 ? first : await frameGetters[i]();
      // encaja conservando aspecto (los recortes pueden variar 1-2 px entre sí)
      const res = await drawFrameFitted(ctx, bmp, w, h);
      if (i !== 0) bmp.close?.();
      if (res && scaledBytes + res.img.data.byteLength <= SCALED_BUDGET) {
        scaled.set(frameGetters[i], res);
        scaledBytes += res.img.data.byteLength;
      }
    }
    await source.add(i * dur, dur);
    onProgress?.(i + 1, frameGetters.length);
  }
  first.close?.();
  await output.finalize();
  recycleIdle(); // el remuestreo de frames grandes infla la memoria WASM
  return { bytes: new Uint8Array(target.buffer), mime: chosen.mime, ext: chosen.ext };
}

/** ImageBitmap de un fotograma; TIFF va por el decodificador del núcleo
 *  WASM porque los navegadores no lo abren. */
export async function decodeFrameBitmap(blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const tiff = (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0)
    || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a);
  if (!tiff) return createImageBitmap(blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const d = await run('decode_image', { bytes }, [bytes.buffer]);
  const img = new ImageData(new Uint8ClampedArray(d.rgba.buffer, d.rgba.byteOffset, d.w * d.h * 4), d.w, d.h);
  return createImageBitmap(img);
}

/** Dimensiones de una imagen sin decodificarla entera (PNG: cabecera IHDR). */
async function imageDims(blob) {
  const head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  // exigir el tag IHDR además de la firma: un CgBI (PNG de iPhone) trae otro
  // chunk primero y daría dimensiones basura
  const isPng = head.length >= 26
    && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    && head[12] === 0x49 && head[13] === 0x48 && head[14] === 0x44 && head[15] === 0x52;
  if (isPng) {
    const dv = new DataView(head.buffer);
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    if (w > 0 && h > 0 && w * h <= 1e9) return { png: true, w, h };
  }
  const bmp = await decodeFrameBitmap(blob);
  const d = { png: false, w: bmp.width, h: bmp.height };
  bmp.close();
  return d;
}

/**
 * Prepara la secuencia como PNGs uniformes. Si todos los fotogramas ya son
 * PNG del tamaño de salida, van tal cual (passthrough, byte a byte); si no
 * (reescalado pedido, tamaños dispares, TIFF/JPG sueltos), se recompone cada
 * uno sobre lienzo blanco y se recodifica PNG (sin pérdida de píxeles).
 */
async function prepareFramePngs(frames, onProgress, opts = {}) {
  if (!frames.length) throw new Error('There are no frames to build the video.');
  // dimensiones por Blob ÚNICO (la línea de tiempo repite dibujos) y con
  // concurrencia acotada: un lote no-PNG lanzaría cientos de decodes a la vez
  const uniq = [...new Set(frames)];
  const dimsByBlob = new Map();
  const LIMIT = 8;
  for (let i = 0; i < uniq.length; i += LIMIT) {
    const chunk = uniq.slice(i, i + LIMIT);
    const ds = await Promise.all(chunk.map(imageDims));
    chunk.forEach((b, j) => dimsByBlob.set(b, ds[j]));
  }
  const dims = frames.map((f) => dimsByBlob.get(f));
  let outW = dims[0].w;
  let outH = dims[0].h;
  if (opts.targetH > 0) {
    outW = Math.max(1, Math.round(outW * (opts.targetH / outH)));
    outH = opts.targetH;
  }
  const passthrough = dims.every((d) => d.png && d.w === outW && d.h === outH);
  if (passthrough) {
    onProgress?.(frames.length, frames.length);
    return { blobs: frames, outW, outH };
  }
  const blobs = [];
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  const rendered = new Map(); // mismo Blob repetido (dedup) → un solo render
  for (let i = 0; i < frames.length; i++) {
    let b = rendered.get(frames[i]);
    if (!b) {
      const bmp = await decodeFrameBitmap(frames[i]);
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, outW, outH);
      await drawFrameFitted(ctx, bmp, outW, outH);
      bmp.close();
      b = await canvasToBlob(canvas, 'image/png');
      rendered.set(frames[i], b);
    }
    blobs.push(b);
    onProgress?.(i + 1, frames.length);
  }
  recycleIdle();
  return { blobs, outW, outH };
}

/** Muxa/codifica la secuencia de PNGs a un MOV con ffmpeg.wasm.
 *  WORKERFS: los PNG se leen desde los Blobs sin copiarlos a la memoria
 *  WASM; solo el MOV de salida vive en ella. */
// El MOV de salida vive en la memoria WASM de ffmpeg (~2 GB útiles): las
// exportaciones que lo excederían se rechazan con un mensaje claro en vez de
// morir con un abort opaco del módulo.
const MAX_MOV_BYTES = 1.4e9;

function movTooBig(estBytes, kind) {
  return new Error(`This ${kind} export would be about ${(estBytes / 1e9).toFixed(1)} GB; the in-browser muxer can hold about 1.4 GB. Lower the resolution, split the range, or download the processed frames ZIP from the Scans report and assemble it in your editor.`);
}

async function framesToMov(blobs, fps, codecArgs, onEncodeProgress) {
  const { withFF } = await import('./avi.js');
  // sesión exclusiva: la instancia de ffmpeg se comparte con la extracción
  return withFF(async (ff) => {
    const onProg = onEncodeProgress
      ? ({ progress }) => { if (progress > 0 && progress <= 1) onEncodeProgress(progress); }
      : null;
    if (onProg) ff.on('progress', onProg);
    try {
      await ff.createDir('/frames');
      await ff.mount('WORKERFS', {
        blobs: blobs.map((data, i) => ({ name: `f_${String(i + 1).padStart(6, '0')}.png`, data })),
      }, '/frames');
      await ff.exec([
        '-hide_banner', '-loglevel', 'error',
        '-framerate', String(fps), '-i', '/frames/f_%06d.png',
        ...codecArgs, 'out.mov',
      ]);
      const bytes = await ff.readFile('out.mov');
      if (!bytes?.length) throw new Error('The MOV muxer produced no output.');
      return bytes;
    } finally {
      if (onProg) ff.off('progress', onProg);
      try { await ff.unmount('/frames'); } catch { /* sin montar */ }
      try { await ff.deleteDir('/frames'); } catch { /* ya no está */ }
      try { await ff.deleteFile('out.mov'); } catch { /* sin archivo */ }
    }
  });
}

/**
 * Exportación SIN pérdida: cada fotograma va como PNG dentro de un MOV
 * (stream copy, sin recodificar el video). Cualquier resolución, 8K
 * incluido. Lo abren los editores (DaVinci, Premiere) y reproductores con
 * ffmpeg (VLC, IINA); QuickTime Player ya no trae el códec PNG.
 * frames: array de Blob EN ORDEN (con repetidos). opts: { targetH }.
 */
export async function buildVideoLossless(frames, fps, onProgress, opts = {}) {
  const { blobs } = await prepareFramePngs(frames, onProgress, opts);
  const total = blobs.reduce((a, b) => a + b.size, 0);
  if (total > MAX_MOV_BYTES) throw movTooBig(total, 'lossless');
  const bytes = await framesToMov(blobs, fps, ['-c:v', 'copy']);
  return { bytes, mime: 'video/quicktime', ext: 'mov' };
}

/**
 * ProRes 4444 (prores_ks): el máster "de edición" que QuickTime y todos los
 * editores reproducen. Visualmente sin pérdida (10 bits 4:4:4), pero no
 * bit a bit como el PNG en MOV. Matriz BT.709 marcada en el contenedor.
 * onProgress(fraction 0..1) durante la codificación.
 */
export async function buildVideoProres(frames, fps, onProgress, opts = {}) {
  // preparación (reescalado/recomposición) como 0–30 % de la barra; la
  // codificación de ffmpeg ocupa el resto
  const { blobs, outW, outH } = await prepareFramePngs(
    frames, (i, n) => onProgress?.(0.3 * (i / n)), opts);
  // ProRes 4444 ronda 6–7 bits por píxel: estimar antes de codificar minutos
  const est = outW * outH * 0.85 * blobs.length;
  if (est > MAX_MOV_BYTES) throw movTooBig(est, 'ProRes');
  const bytes = await framesToMov(blobs, fps, [
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuv444p10le',
    '-vf', 'scale=out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', 'write_colr', '-vendor', 'apl0',
  ], (p) => onProgress?.(0.3 + 0.7 * p));
  return { bytes, mime: 'video/quicktime', ext: 'mov' };
}
