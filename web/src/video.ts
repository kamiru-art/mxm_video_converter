// Video en el navegador: extracción de fotogramas (WebCodecs vía mediabunny)
// y reconstrucción del video final. Sustituye al ffmpeg de la app original.
//
// Filosofía de calidad: cada fotograma extraído se guarda como PNG (sin
// pérdida) a resolución nativa; no se aplica ningún filtro de color.

import type { InputVideoTrack, OutputFormat, Quality, VideoCodec, WrappedCanvas } from 'mediabunny';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
} from 'mediabunny';
import { BadRangeError } from './errors.ts';
import { FrameQueue } from './frames.ts';
import { recycleIdle, run } from './pool.ts';
import type { Bytes } from './types.ts';
import { context2d } from './ui.ts';

// ffmpeg.wasm cubre lo que WebCodecs no: contenedores que mediabunny no abre
// (AVI, MPG…) y códecs que el navegador no decodifica aunque el contenedor
// sea legible (los MOV de cámara: HEVC 10 bits, ProRes, DNxHD…). La detección
// no va por extensión sino por lo que este navegador pueda decodificar.

export interface ExtractOptions {
  start?: number;
  end?: number;
  /** null/undefined = todos los fotogramas */
  fps?: number | null;
  /** true = sin PNG: el fotograma se queda en el video y onFrame recibe
   *  `blob` null; se vuelve a decodificar cuando hace falta con
   *  decodeVideoFrames(file, [t]). Solo lo honra el camino de WebCodecs,
   *  que decodifica a cientos de fotogramas por segundo; ffmpeg.wasm tarda
   *  minutos por pasada y entrega el PNG igual, así que quien llama mira
   *  `blob`, no esta opción. */
  lazy?: boolean;
  onFrame?: (
    blob: Blob | null,
    thumb: OffscreenCanvas,
    t: number,
    i: number,
    w: number,
    h: number,
  ) => void | Promise<void>;
  /** `i` fotogramas entregados hasta ahora, de unos `est` (null si no se sabe). */
  onProgress?: (i: number, est: number | null) => void;
  /** Parar a mitad: la extracción devuelve lo ya entregado, en orden, con
   *  `cancelled: true`. Se mira entre fotograma y fotograma; con ffmpeg.wasm
   *  además se termina la instancia, porque su exec no se interrumpe. */
  signal?: AbortSignal;
}

export interface ExtractResult {
  count: number;
  fps: number;
  duration: number;
  origen: string;
  /** Parada por `signal` antes del final: `count` es lo que dio tiempo. */
  cancelled: boolean;
}

export interface ProbeResult {
  duration: number;
  fps: number;
  width: number;
  height: number;
  fallback?: boolean;
}

export type FrameGetter = () => Promise<ImageBitmap>;

export interface BuildVideoOptions {
  format?: 'auto' | 'mp4' | 'webm';
  quality?: string;
  bitrateMbps?: number;
  /** 0 = resolución nativa de los frames */
  targetH?: number;
}

export interface VideoResult {
  bytes: Bytes;
  mime: string;
  ext: string;
}

interface MediabunnyProbe {
  input: Input;
  track: InputVideoTrack;
  duration: number;
  fps: number;
  width: number;
  height: number;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

// El Input devuelto es del LLAMADOR: `track` cuelga de él y sigue haciendo
// falta para decodificar, así que quien lo recibe tiene que llamar a
// input.dispose() (cierra el lector del Blob y los decodificadores abiertos).
// Si el sondeo falla no lo recibe nadie y se cierra aquí mismo.
async function probeMediabunny(file: File): Promise<MediabunnyProbe> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The file has no video track (or the format is not supported).');
    const duration = await input.computeDuration();
    let fps = 0;
    try {
      const stats = await track.computePacketStats(120);
      fps = stats.averagePacketRate || 0;
    } catch {
      /* algunos contenedores no lo informan */
    }
    return { input, track, duration, fps, width: track.displayWidth, height: track.displayHeight };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

export async function probeVideo(file: File): Promise<ProbeResult> {
  try {
    const p = await probeMediabunny(file);
    // sondeo y nada más: aquí no decodifica nadie, así que el Input se cierra
    // ya y no se devuelve (ni `track`, que moriría con él). El formato
    // coincide con el de probeFallback
    p.input.dispose();
    return { duration: p.duration, fps: p.fps, width: p.width, height: p.height };
  } catch (e) {
    // mediabunny no abre el contenedor: que lo intente ffmpeg.wasm; si
    // tampoco puede, el error original es el informativo
    try {
      const { probeFallback } = await import('./avi.ts');
      return await probeFallback(file);
    } catch {
      throw e;
    }
  }
}

/** Un rango vacío o invertido tiene que fallar, no colarse: cada
 *  decodificador lo recortaba a su manera (Start 10 con End 5 daba UN
 *  fotograma, Start más allá del final daba cero) y la interfaz lo anunciaba
 *  en verde como una extracción correcta. `duration` es opcional: se conoce
 *  solo después de sondear. Mismo texto en extractFramesFallback (avi.ts). */
function assertRange(start: number, end: number, duration: number | null = null): void {
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return;
  const n = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)} s` : 'not a number');
  // lo mira extractFrames para no taparlo (ver abajo)
  throw new BadRangeError(
    `Invalid time range: start (${n(start)}) must come before end (${n(end)}).` +
      (duration ? ` This video lasts ${duration.toFixed(2)} s.` : ''),
  );
}

/** Instantes a muestrear entre start y end a `fps`; al menos uno. */
function sampleTimes(start: number, end: number, fps: number): number[] {
  const times: number[] = [];
  for (let t = start; t < end - 1e-9; t += 1 / fps) times.push(t);
  if (!times.length) times.push(start);
  return times;
}

/**
 * Extrae fotogramas como PNG lossless a resolución nativa.
 * opts: {start, end, fps (null = todos), onFrame(blob, thumbCanvas, t, i), onProgress(i, est), signal}
 * Devuelve el número de fotogramas extraídos.
 */
export async function extractFrames(file: File, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const useFallback = async (): Promise<ExtractResult> => {
    const { extractFramesFallback } = await import('./avi.ts');
    return extractFramesFallback(file, opts);
  };
  // lo tecleado, antes de decodificar nada: este es el único camino hacia los
  // tres decodificadores (los dos de mediabunny y el de ffmpeg.wasm)
  if (opts.end != null) assertRange(Math.max(0, opts.start ?? 0), opts.end);
  let probe: MediabunnyProbe;
  try {
    probe = await probeMediabunny(file);
  } catch (e) {
    try {
      return await useFallback();
    } catch (e2) {
      // el respaldo es el único que conoce la duración de lo que mediabunny
      // no abre: si lo que rechaza es el rango, ESE es el error informativo
      if (e2 instanceof BadRangeError) throw e2;
      throw e;
    }
  }
  // el Input del sondeo es nuestro a partir de aquí: sigue vivo mientras el
  // CanvasSink decodifica y se cierra pase lo que pase al salir
  try {
    // contenedor legible pero códec fuera del alcance de WebCodecs en este
    // navegador (MOV HEVC 10 bits de cámara, ProRes…): decodificar con ffmpeg
    if (!(await probe.track.canDecode())) {
      console.warn(
        `[video] ${file.name}: WebCodecs cannot decode this codec here; using the ffmpeg.wasm decoder (slower).`,
      );
      return useFallback();
    }
    const { track, duration, fps: nativeFps } = probe;
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.min(duration, opts.end ?? duration);
    // ya recortado a la duración real: cubre el inicio pasado el final
    assertRange(start, end, duration);
    // poolSize 2: mediabunny reutiliza los lienzos, y el fotograma sale de
    // ellos (createImageBitmap) antes de pedir el siguiente
    const sink = new CanvasSink(track, { poolSize: 2 });
    // muestreo disperso a `fps` (decodifica cada paquete UNA vez si los
    // instantes van ordenados, y van), o todos los fotogramas
    const times = opts.fps && opts.fps > 0 ? sampleTimes(start, end, opts.fps) : null;
    const est = times ? times.length : nativeFps ? Math.round((end - start) * nativeFps) : null;
    const canvases: AsyncIterable<WrappedCanvas | null> = times
      ? sink.canvasesAtTimestamps(times)
      : sink.canvases(start, end);
    // el PNG y la miniatura se hacen en los workers, varios a la vez; la cola
    // los entrega en orden y es la que lleva la cuenta (ver frames.ts)
    // sin PNG si el fotograma va a vivir en el video (`lazy`): este
    // decodificador puede volver a leerlo cuando haga falta
    const queue = new FrameQueue(opts, est, !opts.lazy);
    let cancelled = false;

    try {
      for await (const wrapped of canvases) {
        if (opts.signal?.aborted) {
          cancelled = true;
          break;
        }
        // canvasesAtTimestamps devuelve null cuando no hay fotograma para ese
        // instante (clip recortado, primer PTS > 0). Se salta, y el índice
        // del fotograma es el de los ENTREGADOS, no el del instante: si no,
        // el primero se llamaba clip_000003.png y las etiquetas impresas
        // dejaban de casar con la línea de tiempo.
        if (!wrapped) continue;
        // copia en la GPU (~1 ms en 4K) que se transfiere al worker; el
        // lienzo vuelve al pool de mediabunny en el siguiente fotograma
        const image = await createImageBitmap(wrapped.canvas);
        await queue.push(image, wrapped.timestamp);
      }
      await queue.finish();
    } catch (e) {
      // canDecode dijo que sí pero el decodificador falló antes de dar nada:
      // último intento con ffmpeg.wasm. Un fallo DESPUÉS de decodificar
      // (codificar el PNG, el onFrame de la app, cuota de memoria) no es del
      // decodificador: se propaga tal cual.
      if (queue.count === 0 && !queue.failed) {
        console.warn('[video] WebCodecs decode failed, retrying with ffmpeg.wasm:', e);
        return useFallback();
      }
      throw e;
    }
    return {
      count: queue.count,
      fps: opts.fps || nativeFps || 12,
      duration,
      origen: file.name,
      cancelled,
    };
  } finally {
    probe.input.dispose();
  }
}

/**
 * Vuelve a decodificar del video los fotogramas de `times` (segundos, los
 * `t` que dio la extracción) y entrega cada uno como ImageBitmap con el
 * índice que tenía en `times`; quien lo recibe lo cierra. Llegan en orden
 * de TIEMPO, no en el orden pedido: así cada paquete se decodifica una sola
 * vez, y una página de hojas cuesta lo que cuesta decodificar el tramo
 * (~30 ms por fotograma 4K por hardware), no una búsqueda por fotograma.
 */
export async function decodeVideoFrames(
  file: File,
  times: number[],
  onFrame: (index: number, image: ImageBitmap) => void | Promise<void>,
): Promise<void> {
  if (!times.length) return;
  const probe = await probeMediabunny(file);
  try {
    if (!(await probe.track.canDecode())) {
      throw new Error(`${file.name}: this browser can no longer decode the video.`);
    }
    const order = times.map((_t, i) => i).sort((a, b) => times[a] - times[b]);
    const sink = new CanvasSink(probe.track, { poolSize: 2 });
    let k = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(order.map((i) => times[i]))) {
      const index = order[k++];
      if (!wrapped) {
        throw new Error(`${file.name}: no frame at ${times[index].toFixed(3)} s.`);
      }
      const image = await createImageBitmap(wrapped.canvas);
      await onFrame(index, image);
    }
    if (k !== times.length) throw new Error(`${file.name}: the decoder stopped early.`);
  } finally {
    probe.input.dispose();
  }
}

function canvasToBlob(canvas: AnyCanvas, type: string): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type });
  return new Promise((res, rej) =>
    canvas.toBlob((b) => {
      if (b) res(b);
      else rej(new Error('The browser could not encode the frame as PNG.'));
    }, type),
  );
}

/** Compone el alfa sobre BLANCO in situ (Uint8ClampedArray: redondea al
 *  asignar). Blanco porque estos fotogramas acaban impresos en las hojas de
 *  contacto, y en papel lo transparente es papel, no un fondo negro.
 *  Hacen falta las dos cosas: el núcleo remuestrea el alfa sin premultiplicar
 *  (resize_rgba_bytes solo admite imágenes opacas) y putImageData REEMPLAZA
 *  el destino en vez de componer sobre él, así que sin aplanar el mismo
 *  fotograma salía blanco por drawImage y negro por WASM. */
function flattenOverWhite(data: Uint8ClampedArray): void {
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a === 255) continue;
    const k = a / 255;
    data[i - 3] = data[i - 3] * k + 255 * (1 - k);
    data[i - 2] = data[i - 2] * k + 255 * (1 - k);
    data[i - 1] = data[i - 1] * k + 255 * (1 - k);
    data[i] = 255;
  }
}

interface ScaledFrame {
  img: ImageData;
  dx: number;
  dy: number;
}

/** Encaja `bmp` centrado en w×h. El reescalado va por el núcleo WASM
 *  (Lanczos3 con antialias, el mismo filtro de las hojas); si el núcleo no
 *  puede, cae al drawImage del navegador en su calidad más alta.
 *  Devuelve {img, dx, dy} cuando reescaló por WASM (cacheable), si no null. */
async function drawFrameFitted(
  ctx: OffscreenCanvasRenderingContext2D,
  bmp: ImageBitmap,
  w: number,
  h: number,
): Promise<ScaledFrame | null> {
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
    const cx = context2d(c, { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    const d = cx.getImageData(0, 0, bmp.width, bmp.height);
    flattenOverWhite(d.data);
    const rgba = new Uint8Array(d.data.buffer);
    const out = await run(
      'resize_rgba',
      { rgba, w: bmp.width, h: bmp.height, outW: dw, outH: dh },
      [rgba.buffer],
    );
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

interface CodecCandidate {
  codec: VideoCodec;
  format: () => OutputFormat;
  mime: string;
  ext: string;
}

/**
 * Reconstruye el video a partir de una secuencia de imágenes (Blob/bytes PNG).
 * frames: array de () => Promise<ImageBitmap> EN ORDEN (con repetidos).
 * opts: { format: 'auto'|'mp4'|'webm', quality: 'very_high'|'high'|'medium'|
 *         'low'|'custom', bitrateMbps: number (con quality='custom'),
 *         targetH: number (0 = resolución nativa de los frames) }
 * Devuelve {bytes, mime, ext}.
 */
export async function buildVideo(
  frameGetters: FrameGetter[],
  fps: number,
  onProgress?: ((i: number, n: number) => void) | null,
  opts: BuildVideoOptions = {},
): Promise<VideoResult> {
  if (!frameGetters.length) throw new Error('There are no frames to build the video.');
  // dimensiones del primero, escaladas a la resolución pedida y normalizadas
  // a pares (requisito H.264)
  const first = await frameGetters[0]();
  // Todo lo que sigue va en try/finally: el ImageBitmap a resolución nativa y
  // el VideoEncoder que vive dentro del Output son recursos del navegador, no
  // basura recogible. Chrome tiene un tope de sesiones de codificación
  // simultáneas, así que unas pocas exportaciones fallidas sin cerrar el
  // encoder dejaban muertas TODAS las siguientes hasta recargar la página (y
  // recargar se lleva por delante el proyecto, que no se persiste).
  let openBmp: ImageBitmap | null = null; // fotograma en curso, aún sin cerrar
  let output: Output | null = null; // dueño del encoder y del muxer
  try {
    let fw = first.width;
    let fh = first.height;
    const targetH = opts.targetH ?? 0;
    if (targetH > 0) {
      fw = fw * (targetH / fh);
      fh = targetH;
    }
    const w = Math.max(2, Math.round(fw / 2) * 2);
    const h = Math.max(2, Math.round(fh / 2) * 2);

    const QUAL: Record<string, Quality> = {
      very_high: QUALITY_VERY_HIGH,
      high: QUALITY_HIGH,
      medium: QUALITY_MEDIUM,
      low: QUALITY_LOW,
    };
    let bitrate: number | Quality =
      (opts.quality !== undefined && QUAL[opts.quality]) || QUALITY_HIGH;
    const bitrateMbps = opts.bitrateMbps ?? 0;
    if (opts.quality === 'custom' && bitrateMbps > 0) {
      // el max del input HTML no frena lo tecleado: tope real aquí
      bitrate = Math.round(Math.min(500, bitrateMbps) * 1e6);
    } else if (opts.quality === 'max') {
      // "visualmente sin pérdida": ~0.5 bits por píxel y frame, con tope.
      // Los codificadores del navegador (WebCodecs) siguen siendo lossy; el
      // modo verdaderamente sin pérdida es buildVideoLossless (PNG en MOV).
      bitrate = Math.min(500e6, Math.max(20e6, Math.round(w * h * fps * 0.5)));
    }

    let candidates: CodecCandidate[] = [
      { codec: 'avc', format: () => new Mp4OutputFormat(), mime: 'video/mp4', ext: 'mp4' },
      { codec: 'vp9', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
      { codec: 'av1', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
      { codec: 'vp8', format: () => new WebMOutputFormat(), mime: 'video/webm', ext: 'webm' },
    ];
    if (opts.format === 'mp4') candidates = candidates.slice(0, 1);
    else if (opts.format === 'webm') candidates = candidates.slice(1);
    let chosen: CodecCandidate | null = null;
    for (const c of candidates) {
      const ok = await getFirstEncodableVideoCodec([c.codec], { width: w, height: h });
      if (ok) {
        chosen = c;
        break;
      }
    }
    if (!chosen) {
      throw new Error(
        opts.format && opts.format !== 'auto'
          ? `This browser cannot encode ${opts.format.toUpperCase()} at ${w}×${h}. Try "Automatic" format, a lower resolution, or the Lossless quality (it works at any resolution).`
          : `This browser cannot encode video at ${w}×${h} (WebCodecs unavailable or resolution too high). Try a lower resolution, or the Lossless quality: it works at any resolution, including 8K.`,
      );
    }

    const canvas = new OffscreenCanvas(w, h);
    const ctx = context2d(canvas);
    const target = new BufferTarget();
    output = new Output({ format: chosen.format(), target });
    const source = new CanvasSource(canvas, { codec: chosen.codec, bitrate });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();

    const dur = 1 / fps;
    // caché de reescalados por getter: los dibujos deduplicados se repiten en
    // la línea de tiempo (la fase ④ reusa el MISMO getter por dibujo) y volver
    // a pasar cada repetición por Lanczos sería trabajo tirado. Presupuesto en
    // bytes; al llenarse, las repeticiones restantes se reescalan de nuevo.
    const scaled = new Map<FrameGetter, ScaledFrame>(); // getter → {img, dx, dy}
    let scaledBytes = 0;
    const SCALED_BUDGET = 300e6;
    for (let i = 0; i < frameGetters.length; i++) {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, w, h);
      const hit = scaled.get(frameGetters[i]);
      if (hit) {
        // img viene ya aplanado sobre blanco (opaco), así que reemplazar el
        // destino equivale a componer sobre el lienzo blanco de arriba
        ctx.putImageData(hit.img, hit.dx, hit.dy);
      } else {
        const bmp = i === 0 ? first : await frameGetters[i]();
        openBmp = i === 0 ? null : bmp; // `first` lo cierra el finally
        // encaja conservando aspecto (los recortes pueden variar 1-2 px entre sí)
        const res = await drawFrameFitted(ctx, bmp, w, h);
        if (i !== 0) bmp.close();
        openBmp = null;
        if (res && scaledBytes + res.img.data.byteLength <= SCALED_BUDGET) {
          scaled.set(frameGetters[i], res);
          scaledBytes += res.img.data.byteLength;
        }
      }
      await source.add(i * dur, dur);
      onProgress?.(i + 1, frameGetters.length);
    }
    first.close();
    await output.finalize();
    recycleIdle(); // el remuestreo de frames grandes infla la memoria WASM
    if (!target.buffer) throw new Error('The video encoder produced no output.');
    return { bytes: new Uint8Array(target.buffer), mime: chosen.mime, ext: chosen.ext };
  } finally {
    // close() de un ImageBitmap ya cerrado no lanza (queda "detached"), así
    // que el camino bueno pasa por aquí sin enterarse
    openBmp?.close();
    first.close();
    // cancel() suelta encoder y muxer; sobre un Output ya finalizado solo
    // dejaría un aviso en consola, por eso se mira el estado. Su propio fallo
    // se registra y no se relanza: taparía el error de verdad
    if (output && output.state !== 'finalized') {
      try {
        await output.cancel();
      } catch (e) {
        console.warn('[video] could not cancel the encoder cleanly:', e);
      }
    }
  }
}

/** ImageBitmap de un fotograma; TIFF va por el decodificador del núcleo
 *  WASM porque los navegadores no lo abren. */
export async function decodeFrameBitmap(blob: Blob): Promise<ImageBitmap> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const tiff =
    (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && head[3] === 0x2a);
  if (!tiff) return createImageBitmap(blob);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const d = await run('decode_image', { bytes }, [bytes.buffer]);
  const img = new ImageData(
    new Uint8ClampedArray(d.rgba.buffer, d.rgba.byteOffset, d.w * d.h * 4),
    d.w,
    d.h,
  );
  return createImageBitmap(img);
}

interface ImageDims {
  png: boolean;
  w: number;
  h: number;
}

/** Dimensiones de una imagen sin decodificarla entera (PNG: cabecera IHDR). */
async function imageDims(blob: Blob): Promise<ImageDims> {
  const head = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  // exigir el tag IHDR además de la firma: un CgBI (PNG de iPhone) trae otro
  // chunk primero y daría dimensiones basura
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
    const w = dv.getUint32(16);
    const h = dv.getUint32(20);
    if (w > 0 && h > 0 && w * h <= 1e9) return { png: true, w, h };
  }
  const bmp = await decodeFrameBitmap(blob);
  const d: ImageDims = { png: false, w: bmp.width, h: bmp.height };
  bmp.close();
  return d;
}

interface PreparedPngs {
  blobs: Blob[];
  outW: number;
  outH: number;
}

/**
 * Prepara la secuencia como PNGs uniformes. Si todos los fotogramas ya son
 * PNG del tamaño de salida, van tal cual (passthrough, byte a byte); si no
 * (reescalado pedido, tamaños dispares, TIFF/JPG sueltos), se recompone cada
 * uno sobre lienzo blanco y se recodifica PNG (sin pérdida de píxeles).
 */
async function prepareFramePngs(
  frames: Blob[],
  onProgress?: (i: number, n: number) => void,
  opts: { targetH?: number } = {},
): Promise<PreparedPngs> {
  if (!frames.length) throw new Error('There are no frames to build the video.');
  // dimensiones por Blob ÚNICO (la línea de tiempo repite dibujos) y con
  // concurrencia acotada: un lote no-PNG lanzaría cientos de decodes a la vez
  const uniq = [...new Set(frames)];
  const dimsByBlob = new Map<Blob, ImageDims>();
  const LIMIT = 8;
  for (let i = 0; i < uniq.length; i += LIMIT) {
    const chunk = uniq.slice(i, i + LIMIT);
    const ds = await Promise.all(chunk.map(imageDims));
    for (const [j, b] of chunk.entries()) dimsByBlob.set(b, ds[j]);
  }
  const dims = frames.map((f) => {
    const d = dimsByBlob.get(f);
    if (!d) throw new Error('Frame dimensions missing.');
    return d;
  });
  let outW = dims[0].w;
  let outH = dims[0].h;
  const targetH = opts.targetH ?? 0;
  if (targetH > 0) {
    outW = Math.max(1, Math.round(outW * (targetH / outH)));
    outH = targetH;
  }
  const passthrough = dims.every((d) => d.png && d.w === outW && d.h === outH);
  if (passthrough) {
    onProgress?.(frames.length, frames.length);
    return { blobs: frames, outW, outH };
  }
  const blobs: Blob[] = [];
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = context2d(canvas);
  const rendered = new Map<Blob, Blob>(); // mismo Blob repetido (dedup) → un solo render
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

function movTooBig(estBytes: number, kind: string): Error {
  return new Error(
    `This ${kind} export would be about ${(estBytes / 1e9).toFixed(1)} GB; the in-browser muxer can hold about 1.4 GB. Lower the resolution, split the range, or download the processed frames ZIP from the Scans report and assemble it in your editor.`,
  );
}

async function framesToMov(
  blobs: Blob[],
  fps: number,
  codecArgs: string[],
  onEncodeProgress?: (p: number) => void,
): Promise<Bytes> {
  const { withFF, FFFSType } = await import('./avi.ts');
  // sesión exclusiva: la instancia de ffmpeg se comparte con la extracción
  return withFF(async (ff) => {
    const onProg = onEncodeProgress
      ? ({ progress }: { progress: number }) => {
          if (progress > 0 && progress <= 1) onEncodeProgress(progress);
        }
      : null;
    if (onProg) ff.on('progress', onProg);
    try {
      await ff.createDir('/frames');
      await ff.mount(
        FFFSType.WORKERFS,
        {
          blobs: blobs.map((data, i) => ({
            name: `f_${String(i + 1).padStart(6, '0')}.png`,
            data,
          })),
        },
        '/frames',
      );
      await ff.exec([
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        String(fps),
        '-i',
        '/frames/f_%06d.png',
        ...codecArgs,
        'out.mov',
      ]);
      const data = await ff.readFile('out.mov');
      if (typeof data === 'string')
        throw new Error('The MOV muxer returned text instead of bytes.');
      if (!data.length) throw new Error('The MOV muxer produced no output.');
      // readFile copia el archivo fuera de la memoria WASM: ArrayBuffer propio
      return data as Bytes;
    } finally {
      if (onProg) ff.off('progress', onProg);
      try {
        await ff.unmount('/frames');
      } catch {
        /* sin montar */
      }
      try {
        await ff.deleteDir('/frames');
      } catch {
        /* ya no está */
      }
      try {
        await ff.deleteFile('out.mov');
      } catch {
        /* sin archivo */
      }
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
export async function buildVideoLossless(
  frames: Blob[],
  fps: number,
  onProgress?: (i: number, n: number) => void,
  opts: { targetH?: number } = {},
): Promise<VideoResult> {
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
export async function buildVideoProres(
  frames: Blob[],
  fps: number,
  onProgress?: (p: number) => void,
  opts: { targetH?: number } = {},
): Promise<VideoResult> {
  // preparación (reescalado/recomposición) como 0–30 % de la barra; la
  // codificación de ffmpeg ocupa el resto
  const { blobs, outW, outH } = await prepareFramePngs(
    frames,
    (i, n) => onProgress?.(0.3 * (i / n)),
    opts,
  );
  // ProRes 4444 ronda 6–7 bits por píxel: estimar antes de codificar minutos
  const est = outW * outH * 0.85 * blobs.length;
  if (est > MAX_MOV_BYTES) throw movTooBig(est, 'ProRes');
  const bytes = await framesToMov(
    blobs,
    fps,
    [
      '-c:v',
      'prores_ks',
      '-profile:v',
      '4444',
      '-pix_fmt',
      'yuv444p10le',
      '-vf',
      'scale=out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-movflags',
      'write_colr',
      '-vendor',
      'apl0',
    ],
    (p) => onProgress?.(0.3 + 0.7 * p),
  );
  return { bytes, mime: 'video/quicktime', ext: 'mov' };
}
