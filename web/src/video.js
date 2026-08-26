// Video en el navegador: extracción de fotogramas (WebCodecs vía mediabunny)
// y reconstrucción del video final. Sustituye al ffmpeg de la app original.
//
// Filosofía de calidad: cada fotograma extraído se guarda como PNG (sin
// pérdida) a resolución nativa; no se aplica ningún filtro de color.

import {
  Input, Output, BlobSource, BufferTarget, ALL_FORMATS,
  CanvasSink, CanvasSource, Mp4OutputFormat, WebMOutputFormat,
  QUALITY_HIGH, getFirstEncodableVideoCodec,
} from 'mediabunny';

export async function probeVideo(file) {
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

/**
 * Extrae fotogramas como PNG lossless a resolución nativa.
 * opts: {start, end, fps (null = todos), onFrame(blob, thumbCanvas, t, i), onProgress(i, est)}
 * Devuelve el número de fotogramas extraídos.
 */
export async function extractFrames(file, opts = {}) {
  const { input, track, duration, fps: nativeFps } = await probeVideo(file);
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
  return { count, fps: opts.fps || nativeFps || 12, duration, origen: file.name };
}

function canvasToBlob(canvas, type) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type });
  return new Promise((res) => canvas.toBlob(res, type));
}

/**
 * Reconstruye el video a partir de una secuencia de imágenes (Blob/bytes PNG).
 * frames: array de () => Promise<ImageBitmap> EN ORDEN (con repetidos).
 * Devuelve {bytes, mime, ext}.
 */
export async function buildVideo(frameGetters, fps, onProgress) {
  if (!frameGetters.length) throw new Error('There are no frames to build the video.');
  // dimensiones del primero, normalizadas a pares (requisito H.264)
  const first = await frameGetters[0]();
  const w = Math.max(2, Math.floor(first.width / 2) * 2);
  const h = Math.max(2, Math.floor(first.height / 2) * 2);

  const candidates = [
    { codec: 'avc', format: () => new Mp4OutputFormat(), mime: 'video/mp4', ext: 'mp4' },
    { codec: 'vp9', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
    { codec: 'vp8', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
  ];
  let chosen = null;
  for (const c of candidates) {
    const ok = await getFirstEncodableVideoCodec([c.codec], { width: w, height: h });
    if (ok) { chosen = c; break; }
  }
  if (!chosen) throw new Error('This browser cannot encode video (WebCodecs unavailable). Try Chrome/Edge, or download the frames and assemble the video with another tool.');

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const target = new BufferTarget();
  const output = new Output({ format: chosen.format(), target });
  const source = new CanvasSource(canvas, { codec: chosen.codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  const dur = 1 / fps;
  for (let i = 0; i < frameGetters.length; i++) {
    const bmp = i === 0 ? first : await frameGetters[i]();
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    // encaja conservando aspecto (los recortes pueden variar 1-2 px entre sí)
    const s = Math.min(w / bmp.width, h / bmp.height);
    const dw = bmp.width * s, dh = bmp.height * s;
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
    if (i !== 0) bmp.close?.();
    await source.add(i * dur, dur);
    onProgress?.(i + 1, frameGetters.length);
  }
  first.close?.();
  await output.finalize();
  return { bytes: new Uint8Array(target.buffer), mime: chosen.mime, ext: chosen.ext };
}
