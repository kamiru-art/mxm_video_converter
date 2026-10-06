// Video en el navegador: extracción de fotogramas (WebCodecs vía mediabunny,
// con ffmpeg.wasm de respaldo). La reconstrucción del video final, siempre
// sin pérdida, está en export.ts.
//
// Filosofía de calidad: cada fotograma extraído se guarda como PNG (sin
// pérdida) a resolución nativa; no se aplica ningún filtro de color, y entra
// con los bits que tiene: un clip de 10 o 12 bits da fotogramas de 16 bits
// (ver "Profundidad" más abajo y rust-core/src/yuv.rs).

import type { InputVideoTrack, VideoSample, WrappedCanvas } from 'mediabunny';
import { ALL_FORMATS, BlobSource, CanvasSink, Input, VideoSampleSink } from 'mediabunny';
import type { DeepFrame, DeepSpec } from './commands.ts';
import { BadRangeError } from './errors.ts';
import { FrameQueue } from './frames.ts';
import type { Bytes } from './types.ts';

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
  /** 8 bits aunque la fuente tenga más: el decodificador por hardware del
   *  navegador en vez de ffmpeg.wasm (ver planDepth). Por defecto, no. */
  fast8?: boolean;
  /** `deep`: el fotograma tiene más de 8 bits por canal (PNG de 16 bits, o
   *  se volverá a decodificar a 16 bits). */
  onFrame?: (
    blob: Blob | null,
    thumb: OffscreenCanvas,
    t: number,
    i: number,
    w: number,
    h: number,
    deep: boolean,
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
  /** Bits por canal de la fuente, si se saben. */
  depth?: number | null;
  /** Fuente de más de 8 bits que este navegador solo decodifica a 8 por
   *  hardware: conservarlos va por ffmpeg.wasm, mucho más lento. */
  deepNeedsFallback?: boolean;
}

// ── Profundidad ───────────────────────────────────────────────
//
// El lienzo del navegador es de 8 bits. Para no perder los bits de más:
//  - si WebCodecs entrega el fotograma en sus planos de 10 o 12 bits (VP9
//    perfil 2, AV1 de 10 bits por software, Firefox y Safari según el
//    códec), se copian con `copyTo` y el núcleo los convierte a RGB de 16
//    bits con la matriz y el rango del propio fotograma;
//  - si la fuente tiene más de 8 bits pero el navegador solo da un
//    fotograma opaco de la GPU (el HEVC de 10 bits de cámara en Chrome:
//    `format` null; medido el 2026-10-06 con un MOV de Lumix, y tampoco una
//    textura float16 de WebGPU conserva más de 8 bits), la extracción va por
//    ffmpeg.wasm, que da `rgb48le`. Es mucho más lenta: `fast8` la evita.
// HDR (PQ, HLG) y BT.2020 se quedan en el lienzo de 8 bits: ahí el navegador
// adapta el color a la pantalla, y una conversión directa saldría lavada.

const DEEP_FORMATS = /^I4(20|22|44)A?P1[02]$/;

/** Bits por canal que declara la pista, o null si no se sabe. */
function codecDepth(cfg: VideoDecoderConfig | null): number | null {
  if (!cfg) return null;
  const c = cfg.codec;
  const vp9 = /^vp09\.\d\d\.\d\d\.(\d\d)/.exec(c);
  if (vp9) return +vp9[1];
  const av1 = /^av01\.\d\.\d\d[MH]\.(\d\d)/.exec(c);
  if (av1) return +av1[1];
  const d = cfg.description;
  const box = !d
    ? null
    : ArrayBuffer.isView(d)
      ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      : new Uint8Array(d);
  if (/^(hev1|hvc1)\./.test(c)) {
    // hvcC: bitDepthLumaMinus8 en los 3 bits bajos del byte 17
    if (box && box.length > 17) return (box[17] & 7) + 8;
    const profile = /^(?:hev1|hvc1)\.[A-C]?(\d+)/.exec(c);
    return profile ? (+profile[1] === 2 ? 10 : 8) : null;
  }
  if (/^(avc1|avc3)\./.test(c)) {
    const profile = Number.parseInt(c.slice(5, 7), 16);
    if (![110, 122, 244].includes(profile)) return 8;
    // avcC: tras los SPS y PPS, la extensión de los perfiles High lleva
    // bit_depth_luma_minus8
    if (box && box.length > 6) {
      let at = 6;
      for (let n = box[5] & 31; n > 0 && at + 2 <= box.length; n--)
        at += 2 + ((box[at] << 8) | box[at + 1]);
      for (let n = box[at++] ?? 0; n > 0 && at + 2 <= box.length; n--)
        at += 2 + ((box[at] << 8) | box[at + 1]);
      if (at + 2 <= box.length) return (box[at + 1] & 7) + 8;
    }
    return 10;
  }
  return null;
}

function isHdrOrWide(sample: VideoSample): boolean {
  // los tipos del DOM de TypeScript aún no listan estos valores
  const transfer: string | null = sample.colorSpace.transfer;
  const primaries: string | null = sample.colorSpace.primaries;
  return transfer === 'pq' || transfer === 'hlg' || primaries === 'bt2020';
}

/** La matriz de WebCodecs en los nombres del núcleo. Sin etiqueta, la
 *  convención: BT.709 en HD, BT.601 por debajo (`height` 0: no decidir). */
export function colourOf(
  m: string | null,
  fullRange: boolean | null,
  height: number,
): { matrix: DeepSpec['matrix'] | null; fullRange: boolean | null } {
  const matrix =
    m === 'bt709'
      ? 'bt709'
      : m === 'bt470bg' || m === 'smpte170m'
        ? 'bt601'
        : m === 'bt2020-ncl'
          ? 'bt2020'
          : m == null && height
            ? height > 576
              ? 'bt709'
              : 'bt601'
            : null;
  return { matrix, fullRange };
}

/** Cómo leer los planos de `sample`, o null si no es un fotograma de más de
 *  8 bits que este módulo sepa convertir (ver "Profundidad"). */
function deepSpecOf(sample: VideoSample): DeepSpec | null {
  if (!sample.format || !DEEP_FORMATS.test(sample.format) || isHdrOrWide(sample)) return null;
  const par = sample.pixelAspectRatio;
  if (par.num !== par.den) return null;
  const { matrix } = colourOf(sample.colorSpace.matrix, null, sample.visibleRect.height);
  if (!matrix) return null;
  return {
    format: sample.format,
    w: sample.visibleRect.width,
    h: sample.visibleRect.height,
    planes: [],
    matrix,
    fullRange: !!sample.colorSpace.fullRange,
    rotation: sample.rotation,
  };
}

/** Los planos de `sample` tal cual, listos para el núcleo. */
async function copyDeep(sample: VideoSample, spec: DeepSpec): Promise<DeepFrame> {
  const data = new Uint8Array(sample.allocationSize()) as Bytes;
  const layout = await sample.copyTo(data);
  return {
    data,
    spec: { ...spec, planes: layout.map((p) => ({ offset: p.offset, stride: p.stride })) },
  };
}

/** El fotograma de 8 bits, girado como manda el video, como hace CanvasSink. */
async function sampleBitmap(sample: VideoSample): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context.');
  sample.draw(ctx, 0, 0);
  return createImageBitmap(canvas);
}

interface DepthPlan {
  depth: number | null;
  /** WebCodecs entrega los planos de más de 8 bits. */
  planes: boolean;
  /** Más de 8 bits que WebCodecs no entrega: hace falta ffmpeg.wasm. */
  needsFallback: boolean;
}

/** Decodifica UN fotograma para saber por dónde conservar la profundidad. */
async function planDepth(track: InputVideoTrack, at: number): Promise<DepthPlan> {
  const depth = codecDepth(await track.getDecoderConfig());
  const sample = await new VideoSampleSink(track).getSample(at);
  if (!sample) return { depth, planes: false, needsFallback: false };
  try {
    if (deepSpecOf(sample))
      return { depth: Math.max(depth ?? 0, 10), planes: true, needsFallback: false };
    return { depth, planes: false, needsFallback: (depth ?? 8) > 8 && !isHdrOrWide(sample) };
  } finally {
    sample.close();
  }
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
    let depth: DepthPlan | null = null;
    try {
      // sin decodificador aquí, la profundidad la dice la pista (y la
      // conserva ffmpeg.wasm, que es por donde irá)
      depth = fallback
        ? {
            depth: codecDepth(await p.track.getDecoderConfig()),
            planes: false,
            needsFallback: false,
          }
        : await planDepth(p.track, 0);
    } catch (e) {
      console.warn('[video] could not read the bit depth:', e);
    }
    // sondeo y nada más: aquí no decodifica nadie, así que el Input se cierra
    // ya y no se devuelve (ni `track`, que moriría con él). El formato
    // coincide con el de probeFallback
    p.input.dispose();
    return {
      duration: p.duration,
      fps: p.fps,
      width: p.width,
      height: p.height,
      fallback,
      depth: depth?.depth ?? null,
      deepNeedsFallback: depth?.needsFallback ?? false,
    };
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
  // `track`: el contenedor que mediabunny sí abrió. Su espacio de color sirve
  // a ffmpeg.wasm cuando su propio log no trae la matriz (un MOV de ProRes
  // escrito por otro ffmpeg puede llegarle sin etiqueta)
  const useFallback = async (track?: InputVideoTrack): Promise<ExtractResult> => {
    const hint = track ? await track.getColorSpace().catch(() => null) : null;
    const { extractFramesFallback } = await import('./avi.ts');
    return extractFramesFallback(
      file,
      opts,
      hint ? colourOf(hint.matrix ?? null, hint.fullRange ?? null, 0) : null,
    );
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
      return await useFallback(probe.track);
    }
    const { track, duration, fps: nativeFps } = probe;
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.min(duration, opts.end ?? duration);
    // ya recortado a la duración real: cubre el inicio pasado el final
    assertRange(start, end, duration);
    const depth = opts.fast8 ? null : await planDepth(track, start);
    if (depth?.needsFallback) {
      console.info(
        `[video] ${file.name}: ${depth.depth}-bit source that WebCodecs only gives at 8 bits here; ffmpeg.wasm keeps the depth.`,
      );
      return await useFallback(probe.track);
    }
    // con await: el `finally` de abajo cierra el Input, y extractDeep lo usa
    if (depth?.planes) return await extractDeep(track, start, end, nativeFps, duration, file, opts);
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
        return await useFallback(probe.track);
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

/** Como el bucle de extractFrames, pero con los planos de más de 8 bits:
 *  cada fotograma va al worker sin pasar por el lienzo. */
async function extractDeep(
  track: InputVideoTrack,
  start: number,
  end: number,
  nativeFps: number,
  duration: number,
  file: File,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const sink = new VideoSampleSink(track);
  const times = opts.fps && opts.fps > 0 ? sampleTimes(start, end, opts.fps) : null;
  const est = times ? times.length : nativeFps ? Math.round((end - start) * nativeFps) : null;
  const samples: AsyncIterable<VideoSample | null> = times
    ? sink.samplesAtTimestamps(times)
    : sink.samples(start, end);
  const queue = new FrameQueue(opts, est, !opts.lazy);
  let cancelled = false;
  for await (const sample of samples) {
    if (opts.signal?.aborted) {
      sample?.close();
      cancelled = true;
      break;
    }
    if (!sample) continue; // ver el mismo caso en extractFrames
    try {
      const spec = deepSpecOf(sample);
      // un fotograma de 8 bits a mitad de un clip de 10 (no debería pasar):
      // entra como los de 8, por el lienzo
      await queue.push(
        spec ? await copyDeep(sample, spec) : await sampleBitmap(sample),
        sample.timestamp,
      );
    } finally {
      sample.close();
    }
  }
  await queue.finish();
  return {
    count: queue.count,
    fps: opts.fps || nativeFps || 12,
    duration,
    origen: file.name,
    cancelled,
  };
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
  onFrame: (index: number, image: ImageBitmap | DeepFrame) => void | Promise<void>,
  deep = false,
): Promise<void> {
  if (!times.length) return;
  const probe = await probeMediabunny(file);
  try {
    if (!(await probe.track.canDecode())) {
      throw new Error(`${file.name}: this browser can no longer decode the video.`);
    }
    const order = times.map((_t, i) => i).sort((a, b) => times[a] - times[b]);
    // `deep`: los planos de más de 8 bits, como en la extracción
    if (deep) {
      const sink = new VideoSampleSink(probe.track);
      let k = 0;
      for await (const sample of sink.samplesAtTimestamps(order.map((i) => times[i]))) {
        const index = order[k++];
        if (!sample) throw new Error(`${file.name}: no frame at ${times[index].toFixed(3)} s.`);
        try {
          const spec = deepSpecOf(sample);
          await onFrame(index, spec ? await copyDeep(sample, spec) : await sampleBitmap(sample));
        } finally {
          sample.close();
        }
      }
      if (k !== times.length) throw new Error(`${file.name}: the decoder stopped early.`);
      return;
    }
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
