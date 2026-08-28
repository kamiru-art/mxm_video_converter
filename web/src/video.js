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

  const emit = async (wrapped, index) => {
    const canvas = wrapped.canvas;
    // PNG sin pérdida a resolución nativa
    const blob = await canvasToBlob(canvas, 'image/png');
    // miniatura para la interfaz / dedup / histograma
    const tw = 256;
    const th = Math.max(1, Math.round((canvas.height / canvas.width) * tw));
    const thumb = new OffscreenCanvas(tw, th);
    thumb.getContext('2d').drawImage(canvas, 0, 0, tw, th);
    await opts.onFrame?.(blob, thumb, wrapped.timestamp, index, canvas.width, canvas.height);
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
          await emit(wrapped, i);
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
        await emit(wrapped, i);
        count++;
        i++;
        opts.onProgress?.(i, est);
      }
    }
  } catch (e) {
    // canDecode dijo que sí pero el decodificador falló antes de dar nada:
    // último intento con ffmpeg.wasm
    if (count === 0) {
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
 *  puede, cae al drawImage del navegador en su calidad más alta. */
async function drawFrameFitted(ctx, bmp, w, h) {
  const s = Math.min(w / bmp.width, h / bmp.height);
  const dw = Math.max(1, Math.round(bmp.width * s));
  const dh = Math.max(1, Math.round(bmp.height * s));
  const dx = Math.round((w - dw) / 2);
  const dy = Math.round((h - dh) / 2);
  if (dw === bmp.width && dh === bmp.height) {
    ctx.drawImage(bmp, dx, dy);
    return;
  }
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height);
    const rgba = new Uint8Array(d.data.buffer);
    const out = await run('resize_rgba', { rgba, w: bmp.width, h: bmp.height, outW: dw, outH: dh }, [rgba.buffer]);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), dw, dh), dx, dy);
  } catch (e) {
    console.warn('[video] WASM resize failed, using canvas scaling:', e);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, dx, dy, dw, dh);
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
    bitrate = Math.round(opts.bitrateMbps * 1e6);
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
  for (let i = 0; i < frameGetters.length; i++) {
    const bmp = i === 0 ? first : await frameGetters[i]();
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    // encaja conservando aspecto (los recortes pueden variar 1-2 px entre sí)
    await drawFrameFitted(ctx, bmp, w, h);
    if (i !== 0) bmp.close?.();
    await source.add(i * dur, dur);
    onProgress?.(i + 1, frameGetters.length);
  }
  first.close?.();
  await output.finalize();
  recycleIdle(); // el remuestreo de frames grandes infla la memoria WASM
  return { bytes: new Uint8Array(target.buffer), mime: chosen.mime, ext: chosen.ext };
}

/** Dimensiones de una imagen sin decodificarla entera (PNG: cabecera IHDR). */
async function imageDims(blob) {
  const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    const dv = new DataView(head.buffer);
    return { png: true, w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  const bmp = await createImageBitmap(blob);
  const d = { png: false, w: bmp.width, h: bmp.height };
  bmp.close();
  return d;
}

/**
 * Exportación SIN pérdida: cada fotograma va como PNG dentro de un MOV
 * (stream copy de ffmpeg.wasm, sin recodificar el video). Funciona a
 * cualquier resolución, 8K incluido; lo abren los editores (DaVinci,
 * Premiere, QuickTime), no los reproductores del navegador.
 * frames: array de Blob EN ORDEN (con repetidos). opts: { targetH }.
 * Devuelve {bytes, mime, ext}.
 */
export async function buildVideoLossless(frames, fps, onProgress, opts = {}) {
  if (!frames.length) throw new Error('There are no frames to build the video.');
  const dims = await Promise.all(frames.map(imageDims));
  let outW = dims[0].w;
  let outH = dims[0].h;
  if (opts.targetH > 0) {
    outW = Math.max(1, Math.round(outW * (opts.targetH / outH)));
    outH = opts.targetH;
  }
  // Si todos los fotogramas ya son PNG del tamaño de salida, van BYTE A BYTE
  // al contenedor: sin pérdida de punta a punta. Si no (reescalado pedido,
  // tamaños dispares, TIFF/JPG sueltos), se recompone cada uno sobre lienzo
  // blanco y se recodifica PNG (también sin pérdida de píxeles).
  const passthrough = dims.every((d) => d.png && d.w === outW && d.h === outH);
  let blobs;
  if (passthrough) {
    blobs = frames;
    onProgress?.(frames.length, frames.length);
  } else {
    blobs = [];
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    const rendered = new Map(); // mismo Blob repetido (dedup) → un solo render
    for (let i = 0; i < frames.length; i++) {
      let b = rendered.get(frames[i]);
      if (!b) {
        const bmp = await createImageBitmap(frames[i]);
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
  }
  const { getFF, release } = await import('./avi.js');
  const ff = await getFF();
  try {
    // WORKERFS: los PNG se leen desde los Blobs sin copiarlos a la memoria
    // WASM; solo el MOV de salida vive en ella
    await ff.createDir('/lossless');
    await ff.mount('WORKERFS', {
      blobs: blobs.map((data, i) => ({ name: `f_${String(i + 1).padStart(6, '0')}.png`, data })),
    }, '/lossless');
    await ff.exec([
      '-hide_banner', '-loglevel', 'error',
      '-framerate', String(fps), '-i', '/lossless/f_%06d.png',
      '-c:v', 'copy', 'out.mov',
    ]);
    const bytes = await ff.readFile('out.mov');
    if (!bytes?.length) throw new Error('The lossless muxer produced no output.');
    return { bytes, mime: 'video/quicktime', ext: 'mov' };
  } finally {
    try { await ff.unmount('/lossless'); } catch { /* sin montar */ }
    try { await ff.deleteFile('out.mov'); } catch { /* sin archivo */ }
    await release();
  }
}
