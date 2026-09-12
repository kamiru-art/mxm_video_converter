// Video en el navegador: extracción de fotogramas (WebCodecs vía mediabunny)
// y reconstrucción del video final. Sustituye al ffmpeg de la app original.
//
// Filosofía de calidad: cada fotograma extraído se guarda como PNG (sin
// pérdida) a resolución nativa; no se aplica ningún filtro de color.

import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type {
  AudioCodec,
  InputAudioTrack,
  InputVideoTrack,
  OutputFormat,
  Quality,
  Target,
  VideoCodec,
  WrappedCanvas,
} from 'mediabunny';
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  QTFF,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  WebMOutputFormat,
} from 'mediabunny';
import { BadRangeError, CancelledError, errMsg, isCancelled, throwIfCancelled } from './errors.ts';
import { FrameQueue } from './frames.ts';
import type { PcmAudio } from './pngmov.ts';
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

/** El audio del video original, para el video final. Los fotogramas
 *  salieron del tramo que empieza en `start` (segundos, VideoMeta.inicio_s)
 *  a los fps del proyecto, así que el sonido de ese tramo, recortado a lo
 *  que dura la secuencia, cae en su sitio sin más. */
export interface AudioFrom {
  file: File;
  start: number;
}

/** Lo común a las tres exportaciones (WebCodecs, PNG en MOV, ProRes). */
export interface ExportOptions {
  /** 0 = resolución nativa de los frames */
  targetH?: number;
  audio?: AudioFrom;
  /** Cancelar (botón Cancel): entre fotograma y fotograma. Con ffmpeg
   *  además se termina la instancia, que es lo único que interrumpe un
   *  exec (ver avi.ts). Sale como CancelledError. */
  signal?: AbortSignal;
  /** Sólo ProRes: tamaño del MOV que produce cada pasada de ffmpeg antes
   *  de unirlo al archivo final. La E2E lo baja para ejercitar la unión de
   *  varios trozos con pocos fotogramas. */
  chunkBytes?: number;
  /** En qué va la exportación, para que la barra diga algo más que un
   *  número: una exportación larga que se queda callada parece colgada.
   *  `p` (0..1) sólo en las fases que saben cuánto llevan. */
  onStage?: (stage: ExportStage, p?: number) => void;
}

/** Las fases de una exportación a MOV, en orden. */
export type ExportStage = 'preparing' | 'sound' | 'encoding' | 'writing';

/** Los fotogramas por segundo mandan en toda la aritmética del archivo (la
 *  escala de tiempo, el reparto por segundos, el tamaño que el contenedor
 *  anuncia antes de escribirlo). Uno imposible no puede llegar al muxer: de
 *  lo que salía era un archivo truncado que decía estar bien. */
function checkFps(fps: number): void {
  if (!Number.isFinite(fps) || fps <= 0)
    throw new Error('The frames per second must be a number greater than zero.');
}

export interface BuildVideoOptions extends ExportOptions {
  format?: 'auto' | 'mp4' | 'webm';
  quality?: string;
  bitrateMbps?: number;
}

export interface VideoResult {
  /** Un Blob cuando el archivo está en el disco privado del navegador (la
   *  ProRes, que no tiene tope de tamaño): leerlo no ocupa memoria. */
  bytes: Bytes | Blob;
  mime: string;
  ext: string;
  /** Lleva la pista de audio del original. */
  audio: boolean;
  /** Se pidió sonido y el video sale mudo: por qué. */
  audioNote?: string;
}

interface MediabunnyProbe {
  input: Input;
  track: InputVideoTrack;
  duration: number;
  fps: number;
  width: number;
  height: number;
}

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
    // el contenedor se abre, pero ¿decodifica este navegador el códec? Si
    // no (HEVC en Firefox, ProRes en todos), la extracción irá por
    // ffmpeg.wasm, minutos en vez de segundos: que el aviso salga AHORA, en
    // el sondeo, y no después de pulsar Extract
    const fallback = !(await p.track.canDecode());
    // sondeo y nada más: aquí no decodifica nadie, así que el Input se cierra
    // ya y no se devuelve (ni `track`, que moriría con él). El formato
    // coincide con el de probeFallback
    p.input.dispose();
    return { duration: p.duration, fps: p.fps, width: p.width, height: p.height, fallback };
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

// ── audio del original ──────────────────────────────────────────

interface OpenAudio {
  input: Input;
  track: InputAudioTrack;
}

/** La pista de audio del video original, o null si no tiene ninguna (o el
 *  navegador no la decodifica): entonces el video sale mudo, como siempre,
 *  y quien llama lo dice. El Input es del llamador: input.dispose(). */
async function openAudio(file: File): Promise<OpenAudio | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    return { input, track };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

/** ¿Llega el audio del original hasta donde empieza el tramo? Un inicio
 *  más allá del final (un layout de otro video, un número mal tecleado)
 *  daría una pista vacía, que el muxer no escribe: mejor mudo y avisado. */
async function audioReaches(track: InputAudioTrack, from: AudioFrom): Promise<boolean> {
  const dur = await track.computeDuration();
  if (from.start < dur - 0.01) return true;
  console.warn(
    `[video] the audio of ${from.file.name} lasts ${dur.toFixed(2)} s; nothing to take from ${from.start.toFixed(2)} s on`,
  );
  return false;
}

/** Con qué codificar el audio para este contenedor y este navegador: AAC
 *  en MP4 y Opus en WebM donde el navegador los codifica (Chrome, Safari;
 *  Firefox no trae codificador AAC y cae a Opus, que MP4 admite y los
 *  navegadores reproducen), y PCM como último recurso. */
async function pickAudioCodec(
  format: OutputFormat,
  track: InputAudioTrack,
): Promise<AudioCodec | null> {
  const wanted: AudioCodec[] = ['aac', 'opus', 'pcm-s16'];
  const supported = format.getSupportedAudioCodecs();
  return getFirstEncodableAudioCodec(
    wanted.filter((c) => supported.includes(c)),
    { numberOfChannels: track.numberOfChannels, sampleRate: track.sampleRate },
  );
}

/** Vuelca en `source` el audio del tramo [start, start + duration) del
 *  original, con el tiempo contado desde el principio del tramo: es el
 *  mismo reloj que los fotogramas (el fotograma i va en i / fps). Corre a
 *  la vez que la codificación del video; el muxer entrelaza. */
async function pumpAudio(
  track: InputAudioTrack,
  source: AudioSampleSource,
  start: number,
  duration: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const end = start + duration;
  const sink = new AudioSampleSink(track);
  for await (const sample of sink.samples(start, end)) {
    try {
      throwIfCancelled(signal, 'Video export cancelled.');
      // el primer bloque suele empezar antes del tramo y el último acabar
      // después: se recortan a la muestra, que es lo que mantiene el
      // sonido alineado con el primer fotograma
      const rate = sample.sampleRate;
      const from = sample.timestamp < start ? Math.round((start - sample.timestamp) * rate) : 0;
      const to =
        sample.timestamp + sample.duration > end
          ? Math.round((end - sample.timestamp) * rate)
          : sample.numberOfFrames;
      if (from >= to) continue;
      const piece = from > 0 || to < sample.numberOfFrames ? sample.trim(from, to) : sample;
      piece.setTimestamp(Math.max(0, piece.timestamp - start));
      await source.add(piece);
      if (piece !== sample) piece.close();
    } finally {
      sample.close();
    }
  }
  source.close();
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
  let audio: OpenAudio | null = null; // el original abierto, si lleva sonido
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
    const format = chosen.format();
    output = new Output({ format, target });
    const source = new CanvasSource(canvas, { codec: chosen.codec, bitrate });
    output.addVideoTrack(source, { frameRate: fps });
    // la pista de audio del original, si la tiene y hay con qué codificarla
    let audioSource: AudioSampleSource | null = null;
    if (opts.audio) {
      audio = await openAudio(opts.audio.file);
      if (audio && !(await audioReaches(audio.track, opts.audio))) {
        audio.input.dispose();
        audio = null;
      }
      if (audio) {
        const codec = await pickAudioCodec(format, audio.track);
        if (codec) {
          audioSource = new AudioSampleSource({ codec, quality: QUALITY_HIGH });
          output.addAudioTrack(audioSource);
        } else {
          console.warn('[video] no audio codec this browser can write into the chosen container');
          audio.input.dispose();
          audio = null;
        }
      } else {
        console.warn(`[video] ${opts.audio.file.name} has no audio track this browser can decode`);
      }
    }
    await output.start();

    const dur = 1 / fps;
    // el audio va a la vez que los fotogramas; su error sale al esperarlo
    const audioDone =
      audio && audioSource && opts.audio
        ? pumpAudio(
            audio.track,
            audioSource,
            opts.audio.start,
            frameGetters.length * dur,
            opts.signal,
          )
        : Promise.resolve();
    audioDone.catch(() => {});
    // caché de reescalados por getter: los dibujos deduplicados se repiten en
    // la línea de tiempo (la fase ④ reusa el MISMO getter por dibujo) y volver
    // a pasar cada repetición por Lanczos sería trabajo tirado. Presupuesto en
    // bytes; al llenarse, las repeticiones restantes se reescalan de nuevo.
    const scaled = new Map<FrameGetter, ScaledFrame>(); // getter → {img, dx, dy}
    let scaledBytes = 0;
    const SCALED_BUDGET = 300e6;
    for (let i = 0; i < frameGetters.length; i++) {
      throwIfCancelled(opts.signal, 'Video export cancelled.');
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
    await audioDone;
    await output.finalize();
    recycleIdle(); // el remuestreo de frames grandes infla la memoria WASM
    if (!target.buffer) throw new Error('The video encoder produced no output.');
    return {
      bytes: new Uint8Array(target.buffer),
      mime: chosen.mime,
      ext: chosen.ext,
      audio: !!audioSource,
    };
  } finally {
    // close() de un ImageBitmap ya cerrado no lanza (queda "detached"), así
    // que el camino bueno pasa por aquí sin enterarse
    openBmp?.close();
    first.close();
    audio?.input.dispose();
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
  /** El PNG lleva canal alfa (tipo de color 4 o 6). Lo que no es PNG se da
   *  por opaco: se recompone sobre blanco antes de codificarlo. */
  alpha: boolean;
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
    const colour = head[25];
    if (w > 0 && h > 0 && w * h <= 1e9)
      return { png: true, w, h, alpha: colour === 4 || colour === 6 };
  }
  const bmp = await decodeFrameBitmap(blob);
  const d: ImageDims = { png: false, w: bmp.width, h: bmp.height, alpha: false };
  bmp.close();
  return d;
}

interface PreparedPngs {
  blobs: Blob[];
  outW: number;
  outH: number;
  /** Alguno de los PNG lleva alfa: el MOV lo dice en su descripción de
   *  muestra (32 bits de profundidad en vez de 24). Mirar sólo el primero
   *  se equivocaría con una secuencia mezclada. */
  alpha: boolean;
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
  opts: ExportOptions = {},
): Promise<PreparedPngs> {
  if (!frames.length) throw new Error('There are no frames to build the video.');
  throwIfCancelled(opts.signal, 'Video export cancelled.');
  // las recomposiciones de la exportación anterior ya no las mira nadie (el
  // archivo que salió de ellas es una copia aparte), y ocupan tanto como los
  // fotogramas: se van SIEMPRE al empezar, también si esta exportación
  // resulta ser passthrough y no recompone nada
  await (await import('./opfs.ts')).clearExportCache();
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
    return { blobs: frames, outW, outH, alpha: dims.some((d) => d.alpha) };
  }
  // cada recomposición sale del núcleo como bytes y va al disco privado
  // (OPFS): un Blob de convertToBlob por fotograma cuenta contra el cupo de
  // Blobs de Chrome hasta que el recolector lo suelta, y pasado el cupo los
  // siguientes ya no se pueden leer (ver opfs.ts). Los recortes de la fase
  // ② varían 1–2 px entre sí, así que este camino es el habitual
  const { storeExportFrame } = await import('./opfs.ts');
  const blobs: Blob[] = [];
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = context2d(canvas);
  const rendered = new Map<Blob, Blob>(); // mismo Blob repetido (dedup) → un solo render
  for (let i = 0; i < frames.length; i++) {
    throwIfCancelled(opts.signal, 'Video export cancelled.');
    let b = rendered.get(frames[i]);
    if (!b) {
      const bmp = await decodeFrameBitmap(frames[i]);
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, outW, outH);
      await drawFrameFitted(ctx, bmp, outW, outH);
      bmp.close();
      const img = ctx.getImageData(0, 0, outW, outH);
      const rgba = new Uint8Array(img.data.buffer);
      const png = await run('encode_png_rgba', { rgba, w: outW, h: outH }, [rgba.buffer]);
      b = await storeExportFrame(png);
      rendered.set(frames[i], b);
    }
    blobs.push(b);
    onProgress?.(i + 1, frames.length);
  }
  recycleIdle();
  // recompuestos: todos salen RGBA del núcleo
  return { blobs, outW, outH, alpha: true };
}

/** Espera `p`, pero NUNCA para siempre: sale por la señal de parada o si
 *  tarda más de `ms` sin resolverse. Lo que quedase en marcha se abandona.
 *  Todo lo que espera a un decodificador del navegador pasa por aquí: un
 *  `AudioDecoder` que acepta la configuración y luego no entrega nada
 *  dejaría la exportación esperando con la barra quieta, que es justo el
 *  fallo que este módulo tuvo con ffmpeg. */
function bounded<T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new CancelledError('Video export cancelled.'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`${what} did not answer in ${(ms / 1000).toFixed(0)} s.`)),
      ms,
    );
    if (signal) {
      onAbort = () => rej(new CancelledError('Video export cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([p, guard]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  });
}

/** Lo que se le da a un decodificador del navegador para responder. Un
 *  bloque de sonido son milisegundos; esto es sólo el tope de lo absurdo. */
const AUDIO_STALL_MS = 60e3;

/**
 * El sonido del tramo [start, start + duration) del original como PCM de 16
 * bits entrelazado, que es lo que llevan los MOV de edición. Lo decodifica
 * el NAVEGADOR (WebCodecs, vía mediabunny): para llegar aquí el original ya
 * tiene que ser decodificable por él, porque `openAudio` lo exige. Antes lo
 * hacía una pasada de ffmpeg.wasm, que costaba cargar 32 MB de núcleo, leer
 * el clip entero por WORKERFS y, con el núcleo multihilo, arriesgar un
 * cuelgue del que no se sale.
 *
 * El reloj se pone a cero en el primer fotograma: cada bloque se copia en su
 * sitio por marca de tiempo, así que un hueco del original (o el final, si
 * el clip se acaba antes) queda en silencio y la pista dura exactamente lo
 * que el video. Más de dos canales se quedan en los dos primeros, que en
 * cualquier disposición estándar son el frontal izquierdo y el derecho.
 */
async function decodePcm(
  track: InputAudioTrack,
  start: number,
  duration: number,
  signal?: AbortSignal,
  onProgress?: (p: number) => void,
): Promise<PcmAudio | null> {
  const end = start + duration;
  const sink = new AudioSampleSink(track);
  // el iterador a mano y no `for await`: así cada espera pasa por bounded()
  // y una parada o un decodificador mudo salen en vez de quedarse ahí
  const it = sink.samples(start, end)[Symbol.asyncIterator]();
  let out: Bytes | null = null;
  let rate = 0;
  let channels = 0;
  let frames = 0;
  try {
    for (;;) {
      const step = await bounded(it.next(), AUDIO_STALL_MS, 'The sound decoder', signal);
      if (step.done) break;
      const sample = step.value;
      try {
        // el primer bloque suele empezar antes del tramo y el último acabar
        // después: se recortan a la muestra, que es lo que mantiene el
        // sonido alineado con el primer fotograma
        const from =
          sample.timestamp < start ? Math.round((start - sample.timestamp) * sample.sampleRate) : 0;
        const to =
          sample.timestamp + sample.duration > end
            ? Math.round((end - sample.timestamp) * sample.sampleRate)
            : sample.numberOfFrames;
        if (from >= to) continue;
        const piece = from > 0 || to < sample.numberOfFrames ? sample.trim(from, to) : sample;
        try {
          if (!out) {
            rate = piece.sampleRate;
            channels = Math.min(2, piece.numberOfChannels);
            frames = Math.max(1, Math.round(duration * rate));
            out = new Uint8Array(new ArrayBuffer(frames * channels * 2));
          }
          // nunca negativo: un bloque que empieza fracciones de muestra
          // antes del tramo daría un desplazamiento negativo y la vista
          // sobre el buffer lanzaría
          const at = Math.max(0, Math.round((piece.timestamp - start) * rate));
          if (at >= frames) continue;
          const n = Math.min(piece.numberOfFrames, frames - at);
          if (n <= 0) continue;
          const src = new Int16Array(piece.allocationSize(PCM_COPY) / 2);
          piece.copyTo(src, PCM_COPY);
          const dst = new Int16Array(out.buffer, out.byteOffset + at * channels * 2, n * channels);
          mixInto(dst, src, n, channels, piece.numberOfChannels);
          onProgress?.(Math.min(1, (at + n) / frames));
        } finally {
          if (piece !== sample) piece.close();
        }
      } finally {
        sample.close();
      }
    }
  } finally {
    // cerrar el iterador suelta el decodificador aunque se salga a mitad
    await it.return?.().catch(() => {});
  }
  return out ? { pcm: out, channels, sampleRate: rate } : null;
}

/**
 * Copia `n` muestras de `src` (entrelazado, `srcCh` canales) en `dst`
 * (entrelazado, `dstCh` canales).
 *
 * Con más de dos canales NO se tiran los demás: se pliegan a estéreo con
 * los coeficientes de siempre (Lo/Ro), porque en material de cine el
 * diálogo va en el canal central y quedarse con el frontal izquierdo y el
 * derecho lo dejaría fuera. El orden de canales es el estándar con el que
 * los decodificadores entregan el audio (FL, FR, FC, LFE, SL, SR); el LFE
 * no entra en la mezcla, como en cualquier pliegue a estéreo.
 */
function mixInto(dst: Int16Array, src: Int16Array, n: number, dstCh: number, srcCh: number): void {
  if (srcCh === dstCh) {
    dst.set(src.subarray(0, n * dstCh));
    return;
  }
  if (srcCh === 1) {
    // mono a estéreo no debería pasar (dstCh = min(2, srcCh)), pero si pasa
    for (let i = 0; i < n; i++) for (let c = 0; c < dstCh; c++) dst[i * dstCh + c] = src[i];
    return;
  }
  const HALF = Math.SQRT1_2;
  const clip = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));
  for (let i = 0; i < n; i++) {
    const o = i * srcCh;
    let l = src[o];
    let r = src[o + 1];
    if (srcCh >= 3) {
      const centre = src[o + 2] * HALF; // el diálogo
      l += centre;
      r += centre;
    }
    // los envolventes, si los hay: el LFE (canal 3 de un 5.1) se queda fuera
    if (srcCh >= 6) {
      l += src[o + 4] * HALF;
      r += src[o + 5] * HALF;
    } else if (srcCh === 5) {
      l += src[o + 3] * HALF;
      r += src[o + 4] * HALF;
    } else if (srcCh === 4) {
      l += src[o + 3] * HALF;
      r += src[o + 3] * HALF;
    }
    dst[i * dstCh] = clip(l);
    dst[i * dstCh + 1] = clip(r);
  }
}

/** PCM de 16 bits entrelazado: un solo plano. */
const PCM_COPY = { planeIndex: 0, format: 's16' } as const;

/** Lo que se pudo sacar del original: el sonido, o por qué no hay. */
interface ExportSound {
  pcm: PcmAudio | null;
  /** Para la interfaz cuando se pidió sonido y no lo hay. */
  note?: string;
}

/** El sonido que pide `opts`, ya decodificado, o el motivo de que no lo
 *  haya. Nunca lanza por culpa del audio: un fallo suyo deja el video mudo
 *  con su explicación, porque perder una exportación de minutos por una
 *  pista rota sería peor. Una PARADA sí sale: es lo que se pidió. */
async function pcmForExport(opts: ExportOptions, duration: number): Promise<ExportSound> {
  if (!opts.audio) return { pcm: null };
  const name = opts.audio.file.name;
  const a = await bounded(
    openAudio(opts.audio.file).catch((e: unknown) => {
      console.warn('[video] could not open the original for its audio:', e);
      return null;
    }),
    AUDIO_STALL_MS,
    'Opening the original',
    opts.signal,
  );
  if (!a) return { pcm: null, note: `${name} has no audio track this browser can read` };
  try {
    if (
      !(await bounded(
        audioReaches(a.track, opts.audio),
        AUDIO_STALL_MS,
        'The original',
        opts.signal,
      ))
    ) {
      return {
        pcm: null,
        note: `the sound of ${name} does not reach ${opts.audio.start.toFixed(2)} s`,
      };
    }
    opts.onStage?.('sound', 0);
    const t0 = performance.now();
    const pcm = await decodePcm(a.track, opts.audio.start, duration, opts.signal, (p) =>
      opts.onStage?.('sound', p),
    );
    if (!pcm) return { pcm: null, note: `${name} decoded no sound for that range` };
    console.info(
      `[video] sound: ${(pcm.pcm.length / 1e6).toFixed(1)} MB of PCM, ${pcm.channels} ch at ${pcm.sampleRate} Hz, decoded in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
    return { pcm };
  } catch (e) {
    if (isCancelled(e)) throw e;
    console.warn('[video] the sound could not be decoded; the video comes out silent:', e);
    return { pcm: null, note: `the sound of ${name} could not be decoded (${errMsg(e)})` };
  } finally {
    a.input.dispose();
  }
}

/** Monta la secuencia entera como /frames/f_000001.png… (WORKERFS: ffmpeg
 *  lee cada Blob bajo demanda, sin copiarlo). */
async function mountFrames(ff: FFmpeg, blobs: Blob[]): Promise<void> {
  const { FFFSType } = await import('./avi.ts');
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
}

async function unmountFrames(ff: FFmpeg): Promise<void> {
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
}

/** Saca un archivo de ffmpeg (readFile lo copia fuera de su memoria:
 *  ArrayBuffer propio) y lo borra de allí. */
async function readOutput(ff: FFmpeg, name: string, who: string): Promise<Bytes> {
  const data = await ff.readFile(name);
  if (typeof data === 'string') throw new Error(`${who} returned text instead of bytes.`);
  if (!data.length) throw new Error(`${who} produced no output.`);
  try {
    await ff.deleteFile(name);
  } catch {
    /* ya no está */
  }
  return data as Bytes;
}

/**
 * Exportación SIN pérdida: cada fotograma va como PNG dentro de un MOV,
 * byte a byte (muxer propio, pngmov.ts; sin tope de tamaño y sin ffmpeg).
 * Cualquier resolución, 8K incluido. Lo abren los editores (DaVinci,
 * Premiere) y reproductores con ffmpeg (VLC, IINA); QuickTime Player ya no
 * trae el códec PNG. frames: array de Blob EN ORDEN (con repetidos).
 */
export async function buildVideoLossless(
  frames: Blob[],
  fps: number,
  onProgress?: (i: number, n: number) => void,
  opts: ExportOptions = {},
): Promise<VideoResult> {
  checkFps(fps);
  opts.onStage?.('preparing');
  const { blobs, outW, outH, alpha } = await prepareFramePngs(frames, onProgress, opts);
  throwIfCancelled(opts.signal, 'Video export cancelled.');
  const sound = await pcmForExport(opts, blobs.length / fps);
  throwIfCancelled(opts.signal, 'Video export cancelled.');
  const [{ openOutput }, { writePngMov }] = await Promise.all([
    import('./opfs.ts'),
    import('./pngmov.ts'),
  ]);
  opts.onStage?.('writing');
  const out = await openOutput(`${Date.now()}-lossless.mov`, 'video/quicktime');
  try {
    await writePngMov(out, blobs, fps, outW, outH, sound.pcm, {
      signal: opts.signal,
      onProgress,
      alpha,
    });
    const bytes = await out.close();
    return {
      bytes,
      mime: 'video/quicktime',
      ext: 'mov',
      audio: !!sound.pcm,
      audioNote: sound.note,
    };
  } catch (e) {
    await out.abort();
    throw e;
  }
}

// ── ProRes por trozos ────────────────────────────────────────────────────
//
// ffmpeg.wasm codifica la secuencia en TROZOS de unos cientos de MB, cada
// uno un MOV ProRes propio que sale de su memoria nada más terminar; mediabunny
// los une (copia de paquetes, sin recodificar) en un solo MOV escrito por
// trozos en el disco privado del navegador (OPFS), con el audio como PCM. El
// pico de memoria es de dos copias de un trozo, dure lo que dure la
// película: un ProRes de 5 GB sale igual que uno de 200 MB. Antes el MOV
// entero vivía en la memoria de ffmpeg y todo lo que pasaba de 1.4 GB se
// rechazaba (Old Fires, 180 fotogramas 4K: 1.6 GB).

/** MOV que produce cada pasada de ffmpeg antes de sacarlo de su memoria. */
const PRORES_CHUNK_BYTES = 200e6;
/** Sin una señal de vida de ffmpeg en este tiempo, la pasada se da por
 *  colgada. Un trozo de 4K son segundos y el progreso llega por fotograma,
 *  así que este silencio sólo lo produce un módulo atascado. */
const STALL_MS = 180e3;
/** ProRes 4444 ronda 6–7 bits por píxel: sirve para dimensionar los trozos. */
const PRORES_BYTES_PER_PX = 0.85;

const PRORES_ARGS = [
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
];

/** Lo que se le pide a ffmpeg arriba, marcado en el `colr` del MOV final:
 *  el demuxer no trae el rango (el `nclc` de QuickTime no lo lleva) y sin
 *  él mediabunny no escribe el atom. yuv444p10le sale en rango limitado. */
const PRORES_COLOR: VideoColorSpaceInit = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
};

/** Dónde escribe el muxer del MOV final: en OPFS (por posición: el MOV
 *  cierra el tamaño del mdat al final) o, sin OPFS, en memoria. */
interface MovTarget {
  target: Target;
  finish(): Promise<Bytes | Blob>;
  abort(): Promise<void>;
}

async function openMovTarget(): Promise<MovTarget> {
  const { openSeekableOutput } = await import('./opfs.ts');
  const disk = await openSeekableOutput(`${Date.now()}-prores.mov`, 'video/quicktime');
  if (disk) {
    return {
      target: new StreamTarget(disk.writable, { chunked: true }),
      finish: () => disk.file(),
      abort: () => disk.abort(),
    };
  }
  const target = new BufferTarget();
  return {
    target,
    async finish() {
      if (!target.buffer) throw new Error('The MOV muxer produced no output.');
      return new Uint8Array(target.buffer);
    },
    async abort() {},
  };
}

/** Copia los paquetes del MOV de un trozo a la pista de salida, con el
 *  tiempo que le toca a cada fotograma en la secuencia entera. */
async function appendProresChunk(
  chunk: Blob,
  video: EncodedVideoPacketSource,
  firstFrame: number,
  count: number,
  fps: number,
  outW: number,
  outH: number,
): Promise<void> {
  const input = new Input({ source: new BlobSource(chunk), formats: [QTFF] });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track?.codec !== 'prores')
      throw new Error('ffmpeg produced a chunk without a ProRes track.');
    const sink = new EncodedPacketSink(track);
    let j = 0;
    for await (const p of sink.packets()) {
      // el primer paquete de todo el MOV lleva la configuración del
      // decodificador: el fourcc (ap4h), el tamaño y el espacio de color
      const meta: EncodedVideoChunkMetadata | undefined =
        firstFrame === 0 && j === 0
          ? {
              decoderConfig: {
                ...((await track.getDecoderConfig()) ?? { codec: 'ap4h' }),
                codedWidth: outW,
                codedHeight: outH,
                colorSpace: PRORES_COLOR,
              },
            }
          : undefined;
      await video.add(
        new EncodedPacket(p.data, 'key', (firstFrame + j) / fps, 1 / fps, firstFrame + j),
        meta,
      );
      j++;
    }
    if (j !== count) throw new Error(`ffmpeg wrote ${j} frames of a chunk of ${count}.`);
  } finally {
    input.dispose();
  }
}

/**
 * Va soltando el PCM en la pista de audio del MOV a medida que el video
 * avanza: `upTo(t)` añade lo que cubre hasta el segundo t. Se llama tras
 * cada trozo de video, así que el archivo queda entrelazado como cualquier
 * MOV y el muxer no tiene que guardar en memoria un lado esperando al otro.
 * Paquetes de un segundo, que es también como los trocea el demuxer de WAV.
 */
function pcmFeeder(
  source: EncodedAudioPacketSource,
  pcm: PcmAudio,
): (upTo: number) => Promise<void> {
  const bytesPerFrame = pcm.channels * 2;
  const total = Math.floor(pcm.pcm.length / bytesPerFrame);
  let done = 0;
  let first = true;
  return async (upTo: number) => {
    const target = Number.isFinite(upTo)
      ? Math.min(total, Math.round(upTo * pcm.sampleRate))
      : total;
    while (done < target) {
      const n = Math.min(pcm.sampleRate, target - done);
      const data = pcm.pcm.subarray(done * bytesPerFrame, (done + n) * bytesPerFrame);
      const packet = new EncodedPacket(
        data,
        'key',
        done / pcm.sampleRate,
        n / pcm.sampleRate,
        done,
      );
      await source.add(
        packet,
        first
          ? {
              decoderConfig: {
                codec: 'pcm-s16',
                sampleRate: pcm.sampleRate,
                numberOfChannels: pcm.channels,
              },
            }
          : undefined,
      );
      first = false;
      done += n;
    }
  };
}

/**
 * ProRes 4444 (prores_ks): el máster "de edición" que QuickTime y todos los
 * editores reproducen. Visualmente sin pérdida (10 bits 4:4:4), pero no
 * bit a bit como el PNG en MOV. Matriz BT.709 marcada en el contenedor.
 * Sin tope de tamaño: ver "ProRes por trozos" arriba.
 * onProgress(fraction 0..1) durante la codificación.
 */
export async function buildVideoProres(
  frames: Blob[],
  fps: number,
  onProgress?: (p: number) => void,
  opts: ExportOptions = {},
): Promise<VideoResult> {
  checkFps(fps);
  // la barra NO retrocede: los avisos de ffmpeg del final de un trozo y del
  // principio del siguiente se solapan, y un número que baja parece un
  // fallo aunque el archivo vaya bien
  let reported = 0;
  const report = (p: number): void => {
    const clamped = Math.max(reported, Math.min(1, p));
    reported = clamped;
    onProgress?.(clamped);
  };
  // preparación (reescalado/recomposición) como 0–30 % de la barra; la
  // codificación de ffmpeg ocupa el resto
  opts.onStage?.('preparing');
  const { blobs, outW, outH } = await prepareFramePngs(
    frames,
    (i, m) => report(0.3 * (i / m)),
    opts,
  );
  const n = blobs.length;
  const perFrame = outW * outH * PRORES_BYTES_PER_PX;
  const chunkBytes = opts.chunkBytes ?? PRORES_CHUNK_BYTES;
  const chunkFrames = Math.max(1, Math.min(n, Math.floor(chunkBytes / perFrame)));
  const duration = n / fps;
  const { withFF, abortFF, execWatched, ffmpegThreads } = await import('./avi.ts');
  throwIfCancelled(opts.signal, 'Video export cancelled.');
  // el sonido, decodificado ANTES de abrir la sesión de ffmpeg: así el MOV
  // ya sabe si lleva pista de audio cuando se escribe el primer byte
  const sound = await pcmForExport(opts, duration);
  const pcm = sound.pcm;
  throwIfCancelled(opts.signal, 'Video export cancelled.');

  opts.onStage?.('encoding');
  // el archivo se abre y TODO lo que puede fallar va dentro del try: una
  // pista mal formada dejaba si no un archivo a medias y su escritura
  // abierta, que el navegador no suelta hasta recargar
  const out = await openMovTarget();
  let output: Output | null = null;
  try {
    output = new Output({ format: new MovOutputFormat(), target: out.target });
    const video = new EncodedVideoPacketSource('prores');
    output.addVideoTrack(video, { frameRate: fps, hasOnlyKeyPackets: true });
    const audio = pcm ? new EncodedAudioPacketSource('pcm-s16') : null;
    if (audio) output.addAudioTrack(audio);
    const feedAudio = audio && pcm ? pcmFeeder(audio, pcm) : null;
    await output.start();
    // sesión exclusiva: la instancia de ffmpeg se comparte con la extracción
    await withFF(async (ff) => {
      const onAbort = (): void => {
        void abortFF();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      let chunkStart = 0;
      let chunkCount = 0;
      // `time` son los microsegundos de video ya escritos en la pasada en
      // curso: fotogramas del trozo, sumados a los de los trozos anteriores
      const onProg = ({ time }: { time: number }): void => {
        if (!(time > 0)) return;
        const done = chunkStart + Math.min(chunkCount, (time / 1e6) * fps);
        report(0.3 + 0.7 * (done / n));
      };
      ff.on('progress', onProg);
      try {
        throwIfCancelled(opts.signal, 'Video export cancelled.');
        await mountFrames(ff, blobs);
        for (chunkStart = 0; chunkStart < n; chunkStart += chunkFrames) {
          throwIfCancelled(opts.signal, 'Video export cancelled.');
          chunkCount = Math.min(chunkFrames, n - chunkStart);
          await execWatched(
            ff,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              // `-stats` con `-loglevel error`: sin él no sale NADA por el
              // log y el vigilante se queda sin pulso que mirar salvo el
              // progreso del propio núcleo
              '-stats',
              '-framerate',
              String(fps),
              '-start_number',
              String(chunkStart + 1),
              '-i',
              '/frames/f_%06d.png',
              '-frames:v',
              String(chunkCount),
              // `-threads 1` DESPUÉS del -i, que es donde llega al
              // codificador, y sólo con el núcleo multihilo: ahí es donde un
              // codificador con hilos se cuelga (ver avi.ts). Con el núcleo
              // de un hilo no habría diferencia y sí sería más lento.
              ...(ffmpegThreads() === 'multi' ? ['-threads', '1'] : []),
              ...PRORES_ARGS,
              'chunk.mov',
            ],
            STALL_MS,
            'The ProRes encoder',
          );
          const bytes = await readOutput(ff, 'chunk.mov', 'The ProRes encoder');
          throwIfCancelled(opts.signal, 'Video export cancelled.');
          await appendProresChunk(
            new Blob([bytes], { type: 'video/quicktime' }),
            video,
            chunkStart,
            chunkCount,
            fps,
            outW,
            outH,
          );
          // el sonido de lo que acaba de escribirse, para que el archivo
          // quede entrelazado
          await feedAudio?.((chunkStart + chunkCount) / fps);
          report(0.3 + 0.7 * ((chunkStart + chunkCount) / n));
        }
        await feedAudio?.(Number.POSITIVE_INFINITY);
      } catch (e) {
        // la instancia terminada por onAbort rechaza lo que estuviera en
        // curso: es la parada, no un fallo
        throwIfCancelled(opts.signal, 'Video export cancelled.');
        throw e;
      } finally {
        opts.signal?.removeEventListener('abort', onAbort);
        ff.off('progress', onProg);
        await unmountFrames(ff);
        try {
          await ff.deleteFile('chunk.mov');
        } catch {
          /* ya no está */
        }
      }
    });
    await output.finalize();
    const bytes = await out.finish();
    return {
      bytes,
      mime: 'video/quicktime',
      ext: 'mov',
      audio: !!pcm,
      audioNote: sound.note,
    };
  } catch (e) {
    // cancel() cierra el archivo a medias; abort() lo borra del disco. Su
    // propio fallo se registra y no se relanza: taparía el error de verdad
    if (output && output.state !== 'finalized') {
      try {
        await output.cancel();
      } catch (e2) {
        console.warn('[video] could not cancel the MOV muxer cleanly:', e2);
      }
    }
    await out.abort();
    throw e;
  }
}
