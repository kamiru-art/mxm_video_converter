// Video en el navegador: extracción de fotogramas (WebCodecs vía mediabunny,
// con ffmpeg.wasm de respaldo). La reconstrucción del video final, siempre
// sin pérdida, está en export.ts.
//
// Filosofía de calidad: cada fotograma extraído se guarda como PNG (sin
// pérdida) a resolución nativa; no se aplica ningún filtro de color.

import type { InputVideoTrack, WrappedCanvas } from 'mediabunny';
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { BadRangeError } from './errors.ts';
import { FrameQueue } from './frames.ts';

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
