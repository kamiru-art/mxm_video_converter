// El video final sin pérdida.
//
// Cada fotograma va como PNG: dentro de un MOV (lo abren DaVinci Resolve,
// Premiere, After Effects, VLC, IINA, ffmpeg) o como secuencia numerada en
// un ZIP (la importa cualquier editor, también los que no leen PNG en MOV,
// como Final Cut). No hay calidades que elegir porque no hay nada que
// perder: los píxeles que salen son los que entraron. La versión
// comprimida, para ver y compartir, está en lossy.ts y parte del mismo plan.
//
// Lo que se decide solo, fotograma a fotograma:
// - la profundidad de la secuencia: 16 bits por canal si CUALQUIERA de los
//   fotogramas los trae (un escaneo de 16 bits, un TIFF), y los de 8 bits
//   se ensanchan (v · 257, exacto). Nunca se baja de 16 a 8;
// - el tamaño: el que tiene la mayoría de los fotogramas;
// - el camino: un PNG que ya es del tamaño, la profundidad y el tipo de la
//   secuencia se copia byte a byte (passthrough, el caso normal desde la
//   fase ②, cuyos recortes salen todos del mismo tamaño); el resto lo
//   conforma el núcleo (conform.rs), en paralelo en los workers, con tantos
//   a la vez como deja la memoria del equipo.

import type { AudioSample, InputAudioTrack } from 'mediabunny';
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { deviceRamGb } from './device.ts';
import { CancelledError, errMsg, isCancelled, throwIfCancelled } from './errors.ts';
import type { FrameInfo } from './imageinfo.ts';
import { imageInfo } from './imageinfo.ts';
import { clearExportCache, openOutput, storeExportFrame } from './opfs.ts';
import type { PcmAudio } from './pngmov.ts';
import { poolSize, recycleIdle, run } from './pool.ts';
import type { Bytes } from './types.ts';
import { ZipSink } from './zip.ts';

/** El audio del video original, para el video final. Los fotogramas
 *  salieron del tramo que empieza en `start` (segundos, VideoMeta.inicio_s)
 *  a los fps del proyecto, así que el sonido de ese tramo, recortado a lo
 *  que dura la secuencia, cae en su sitio sin más. */
export interface AudioFrom {
  file: File;
  start: number;
  /** Con fotogramas saltados y su sonido cortado: los tramos de la línea de
   *  tiempo que quedan, como posiciones [desde, hasta) contadas desde el
   *  primer fotograma del tramo, en orden. El sonido de lo que queda fuera
   *  se quita y el resto se une sin silencios, cada dibujo con el suyo. Sin
   *  esto el sonido corre seguido, que es lo que se quiere cuando ya viene
   *  editado sin esos fotogramas. */
  keep?: Array<[number, number]>;
}

/** Dónde va la secuencia: un MOV, o un ZIP de PNG numerados. */
export type ExportKind = 'mov' | 'frames';

/** Las fases de una exportación, en orden. */
export type ExportStage = 'preparing' | 'sound' | 'writing' | 'encoding';

export interface ExportOptions {
  kind?: ExportKind;
  audio?: AudioFrom;
  /** Cancelar (botón Cancel): entre fotograma y fotograma. Sale como
   *  CancelledError. */
  signal?: AbortSignal;
  /** En qué va la exportación: `done` de `total` en la fase `stage`
   *  (en 'sound', `done` es la fracción y `total` 1). Una exportación
   *  larga que sólo enseña un número parece colgada. */
  onProgress?: (stage: ExportStage, done: number, total: number) => void;
  /** Nombre base de los archivos dentro del ZIP. */
  baseName?: string;
}

export interface VideoResult {
  /** En el disco privado del navegador cuando lo hay: leerlo no ocupa
   *  memoria, y no hay tope de tamaño. */
  bytes: Bytes | Blob;
  mime: string;
  ext: string;
  /** Lleva el sonido del original. */
  audio: boolean;
  /** Se pidió sonido y el video sale mudo: por qué. */
  audioNote?: string;
  plan: SequencePlan;
}

/** Lo que la exportación va a hacer, antes de hacerlo. */
export interface SequencePlan {
  w: number;
  h: number;
  sixteen: boolean;
  alpha: boolean;
  /** Posiciones en la línea de tiempo (con repetidos). */
  frames: number;
  /** Dibujos distintos. */
  unique: number;
  /** Dibujos que van byte a byte. */
  passthrough: number;
  /** Dibujos que el núcleo conforma (tamaño, profundidad o formato). */
  conform: number;
  /** Dibujos de otro tamaño de verdad, que se encajan con Lanczos. */
  resized: number;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(4, Math.floor(b / 100));
}

/** Mira la secuencia y decide tamaño, profundidad, alfa y qué se copia tal
 *  cual. `frames` va en orden y con repetidos (los dibujos deduplicados). */
export async function planSequence(
  frames: Blob[],
  signal?: AbortSignal,
): Promise<{ plan: SequencePlan; infos: Map<Blob, FrameInfo> }> {
  if (!frames.length) throw new Error('There are no frames to build the video.');
  const uniq = [...new Set(frames)];
  const infos = new Map<Blob, FrameInfo>();
  // cabeceras con concurrencia acotada: un lote de TIFF lanzaría cientos
  // de lecturas enteras a la vez
  const LIMIT = 8;
  for (let i = 0; i < uniq.length; i += LIMIT) {
    throwIfCancelled(signal, 'Video export cancelled.');
    const chunk = uniq.slice(i, i + LIMIT);
    const got = await Promise.all(chunk.map(imageInfo));
    for (const [j, b] of chunk.entries()) infos.set(b, got[j]);
  }
  // el tamaño de la mayoría, contando las repeticiones: el que menos
  // fotogramas obliga a tocar
  const votes = new Map<string, number>();
  for (const f of frames) {
    const i = infos.get(f) as FrameInfo;
    const k = `${i.w}x${i.h}`;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  const [w, h] = best.split('x').map(Number);
  const all = [...infos.values()];
  const sixteen = all.some((i) => i.sixteen);
  const alpha = all.some((i) => i.alpha);
  const want = alpha ? 6 : 2;
  let passthrough = 0;
  let resized = 0;
  for (const i of all) {
    if (i.png && i.w === w && i.h === h && i.sixteen === sixteen && i.colour === want)
      passthrough++;
    else if (!(near(i.w, w) && near(i.h, h))) resized++;
  }
  return {
    plan: {
      w,
      h,
      sixteen,
      alpha,
      frames: frames.length,
      unique: uniq.length,
      passthrough,
      conform: uniq.length - passthrough,
      resized,
    },
    infos,
  };
}

/** Pico de conformar UN fotograma del plan: decodificado + lienzo + PNG,
 *  unas tres copias del fotograma. */
export function conformPeakBytes(plan: SequencePlan): number {
  return plan.w * plan.h * (plan.sixteen ? 8 : 4) * 3;
}

/** Cuántos fotogramas conformar a la vez: tantos workers como haya, pero
 *  sin que sus picos pasen de una cuarta parte de la RAM supuesta (ver
 *  deviceRamGb): en un teléfono es lo que evita que la pestaña se muera. */
function conformConcurrency(plan: SequencePlan): number {
  const budget = deviceRamGb() * 1e9 * 0.25;
  return Math.max(
    1,
    Math.min(poolSize(), Math.floor(budget / Math.max(1, conformPeakBytes(plan)))),
  );
}

/** Qué fotogramas valen tal cual y a qué se conforman los demás. */
export interface ConformSpec {
  sixteen: boolean;
  alpha: boolean;
  /** El fotograma se usa como está. */
  fits: (i: FrameInfo) => boolean;
}

/** Lo que pide el MOV sin pérdida: PNG de la profundidad y el tipo de color
 *  de la secuencia, al tamaño del plan. */
function losslessSpec(plan: SequencePlan): ConformSpec {
  const want = plan.alpha ? 6 : 2;
  return {
    sixteen: plan.sixteen,
    alpha: plan.alpha,
    fits: (i) =>
      i.png && i.w === plan.w && i.h === plan.h && i.sixteen === plan.sixteen && i.colour === want,
  };
}

/** Los PNG de la secuencia, ya uniformes: los que valen tal cual, y los
 *  demás conformados por el núcleo y guardados en el disco privado. */
export async function uniformPngs(
  frames: Blob[],
  plan: SequencePlan,
  infos: Map<Blob, FrameInfo>,
  opts: ExportOptions,
  spec: ConformSpec = losslessSpec(plan),
): Promise<Blob[]> {
  // los conformados de la exportación anterior ya no los mira nadie (el
  // archivo que salió de ellos es una copia aparte)
  await clearExportCache();
  const todo = [...infos.entries()].filter(([, i]) => !spec.fits(i));
  const done = new Map<Blob, Blob>();
  let finished = 0;
  const report = (): void => opts.onProgress?.('preparing', finished, todo.length);
  report();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      throwIfCancelled(opts.signal, 'Video export cancelled.');
      const [blob] = todo[next++];
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const png = await run(
        'conform_frame',
        { bytes, w: plan.w, h: plan.h, sixteen: spec.sixteen, alpha: spec.alpha },
        [bytes.buffer],
      );
      done.set(blob, await storeExportFrame(png));
      finished++;
      report();
    }
  };
  const n = Math.min(todo.length, conformConcurrency({ ...plan, sixteen: spec.sixteen }));
  await Promise.all(Array.from({ length: n }, worker));
  if (todo.length) recycleIdle(); // un 4K de 16 bits infla la memoria WASM
  return frames.map((f) => done.get(f) ?? f);
}

/** WAV de PCM de 16 bits entrelazado (little-endian, como el 'sowt'). */
function wavHeader(pcm: PcmAudio): Bytes {
  const h = new Uint8Array(44);
  const dv = new DataView(h.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < 4; i++) h[o + i] = s.charCodeAt(i);
  };
  const size = pcm.pcm.length;
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + size, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, pcm.channels, true);
  dv.setUint32(24, pcm.sampleRate, true);
  dv.setUint32(28, pcm.sampleRate * pcm.channels * 2, true);
  dv.setUint16(32, pcm.channels * 2, true);
  dv.setUint16(34, 16, true);
  tag(36, 'data');
  dv.setUint32(40, size, true);
  return h;
}

/**
 * El video final sin pérdida. `frames`: los PNG/TIFF en el orden de la
 * línea de tiempo, con repetidos (un dibujo deduplicado es el MISMO Blob en
 * cada posición). kind 'mov' da un MOV con los PNG y el sonido en PCM;
 * 'frames', un ZIP con `<base>_000001.png`… y `<base>.wav`.
 */
export async function exportLossless(
  frames: Blob[],
  fps: number,
  opts: ExportOptions = {},
): Promise<VideoResult> {
  // los fps mandan en toda la aritmética del MOV (escala de tiempo, reparto
  // por segundos, tamaño anunciado): uno imposible no puede llegar al muxer
  if (!Number.isFinite(fps) || fps <= 0)
    throw new Error('The frames per second must be a number greater than zero.');
  const kind = opts.kind ?? 'mov';
  const { plan, infos } = await planSequence(frames, opts.signal);
  const pngs = await uniformPngs(frames, plan, infos, opts);
  throwIfCancelled(opts.signal, 'Video export cancelled.');
  const sound = await pcmForExport(opts, frames.length, fps);
  throwIfCancelled(opts.signal, 'Video export cancelled.');
  const progress = (i: number, n: number): void => opts.onProgress?.('writing', i, n);
  if (kind === 'mov') {
    const { writePngMov } = await import('./pngmov.ts');
    const out = await openOutput(`${Date.now()}-lossless.mov`, 'video/quicktime');
    try {
      await writePngMov(out, pngs, fps, plan.w, plan.h, sound.pcm, {
        signal: opts.signal,
        onProgress: progress,
        alpha: plan.alpha,
      });
      return {
        bytes: await out.close(),
        mime: 'video/quicktime',
        ext: 'mov',
        audio: !!sound.pcm,
        audioNote: sound.note,
        plan,
      };
    } catch (e) {
      await out.abort();
      throw e;
    }
  }
  const base = opts.baseName || 'frame';
  const sink = await ZipSink.open(`${Date.now()}-frames.zip`);
  try {
    const digits = Math.max(6, String(pngs.length).length);
    for (const [i, png] of pngs.entries()) {
      throwIfCancelled(opts.signal, 'Video export cancelled.');
      await sink.add(`${base}_${String(i + 1).padStart(digits, '0')}.png`, png);
      progress(i + 1, pngs.length);
    }
    if (sound.pcm) {
      await sink.add(`${base}.wav`, new Blob([wavHeader(sound.pcm), sound.pcm.pcm]));
    }
    return {
      bytes: await sink.finish(),
      mime: 'application/zip',
      ext: 'zip',
      audio: !!sound.pcm,
      audioNote: sound.note,
      plan,
    };
  } catch (e) {
    await sink.abort();
    throw e;
  }
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

/** Espera `p`, pero NUNCA para siempre: sale por la señal de parada o si
 *  tarda más de `ms` sin resolverse. Lo que quedase en marcha se abandona.
 *  Todo lo que espera a un decodificador del navegador pasa por aquí: un
 *  `AudioDecoder` que acepta la configuración y luego no entrega nada
 *  dejaría la exportación esperando con la barra quieta, que es justo el
 *  fallo que este módulo tuvo con ffmpeg. */
export function bounded<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  signal?: AbortSignal,
): Promise<T> {
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
        // después: se toma sólo lo de dentro, a la muestra, que es lo que
        // mantiene el sonido alineado con el primer fotograma
        const from =
          sample.timestamp < start ? Math.round((start - sample.timestamp) * sample.sampleRate) : 0;
        const to =
          sample.timestamp + sample.duration > end
            ? Math.round((end - sample.timestamp) * sample.sampleRate)
            : sample.numberOfFrames;
        if (from >= to) continue;
        if (!out) {
          rate = sample.sampleRate;
          channels = Math.min(2, sample.numberOfChannels);
          frames = Math.max(1, Math.round(duration * rate));
          out = new Uint8Array(new ArrayBuffer(frames * channels * 2));
        }
        // nunca negativo: un bloque que empieza fracciones de muestra
        // antes del tramo daría un desplazamiento negativo y la vista
        // sobre el buffer lanzaría
        const at = Math.max(
          0,
          Math.round((sample.timestamp + from / sample.sampleRate - start) * rate),
        );
        if (at >= frames) continue;
        const n = Math.min(to - from, frames - at);
        if (n <= 0) continue;
        const src = s16Of(sample, from, n);
        const dst = new Int16Array(out.buffer, out.byteOffset + at * channels * 2, n * channels);
        mixInto(dst, src, n, channels, sample.numberOfChannels);
        onProgress?.(Math.min(1, (at + n) / frames));
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

/**
 * `n` muestras de `sample` desde la `from`, en 16 bits entrelazados, sin
 * perder un bit de un original de 16 bits. mediabunny convierte pasando por
 * un valor normalizado: lee el s16 como v / 32768 y lo escribe como v · 32767,
 * así que pedirle s16 (o recortar con `trim`, que copia así) a un bloque que
 * ya es s16, el de un WAV, le restaba uno a cada muestra grande. Se pide en
 * f32, que guarda v / 32768 exacto, y se vuelve a 16 bits aquí con el mismo
 * 32768.
 */
function s16Of(sample: AudioSample, from: number, n: number): Int16Array {
  const f = new Float32Array(n * sample.numberOfChannels);
  sample.copyTo(f, { planeIndex: 0, format: 'f32', frameOffset: from, frameCount: n });
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.round(f[i] * 32768);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** Lo que se pudo sacar del original: el sonido, o por qué no hay. */
export interface ExportSound {
  pcm: PcmAudio | null;
  /** Para la interfaz cuando se pidió sonido y no lo hay. */
  note?: string;
}

/** Lo que dura un empalme del sonido al saltar fotogramas (AudioFrom.keep):
 *  un corte seco entre dos tramos casi siempre chasquea, y unos milisegundos
 *  de fundido cruzado no se oyen como fundido. */
const SPLICE_S = 0.005;

/** ¿Son los tramos de `keep` posiciones válidas, en orden, sin solaparse, y
 *  suman los `frames` fotogramas del video? Un fallo aquí es del que llama,
 *  no del sonido. */
function checkKeep(keep: Array<[number, number]>, frames: number): void {
  let total = 0;
  let last = 0;
  for (const [a, b] of keep) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < last || b <= a)
      throw new Error(`The sound cuts are out of order: ${JSON.stringify(keep)}`);
    total += b - a;
    last = b;
  }
  if (total !== frames)
    throw new Error(`The sound cuts cover ${total} frames and the video has ${frames}`);
}

/**
 * Sólo los tramos `keep` del sonido, uno detrás de otro (AudioFrom.keep).
 * `pcm` empieza en la posición 0 de la línea de tiempo y llega hasta el final
 * del último tramo. Se trabaja sobre el mismo buffer, hacia delante: cada
 * tramo cae en un sitio que nunca está por detrás de donde se lee, así que no
 * hace falta otra copia del sonido entero.
 *
 * Las fronteras se cuentan en fotogramas de SALIDA (la del fotograma k cae en
 * la muestra round(k · rate / fps)), así que la pista dura exactamente lo que
 * el video y cada dibujo arranca con su sonido, sin un desfase que se vaya
 * acumulando de corte en corte. En cada unión, los primeros SPLICE_S del tramo
 * nuevo se funden con el sonido que seguía al anterior (el que se quita), sin
 * mover nada de sitio.
 */
function spliceKept(pcm: PcmAudio, keep: Array<[number, number]>, fps: number): PcmAudio {
  const ch = pcm.channels;
  const rate = pcm.sampleRate;
  const s = new Int16Array(pcm.pcm.buffer, pcm.pcm.byteOffset, pcm.pcm.length >> 1);
  const have = Math.floor(s.length / ch);
  const at = (pos: number): number => Math.round((pos * rate) / fps);
  const fadeN = Math.max(1, Math.round(SPLICE_S * rate));
  let k = 0; // fotogramas de salida ya puestos
  let prevEnd = -1; // la muestra que seguía al tramo anterior en el original
  let prevPos = -1; // la posición en que acababa el tramo anterior
  for (const [a, b] of keep) {
    const dst = at(k);
    const len = at(k + b - a) - dst;
    const src = at(a);
    const n = Math.max(0, Math.min(len, have - src));
    // el fundido se calcula ANTES de mover el tramo: lo que se mueve puede
    // pisar el sonido que seguía al anterior, que es de donde sale el fundido
    let fade: Int16Array | null = null;
    if (prevEnd >= 0 && a !== prevPos) {
      const m = Math.min(fadeN, n, Math.max(0, have - prevEnd));
      fade = new Int16Array(m * ch);
      for (let i = 0; i < m; i++) {
        const w = (i + 0.5) / m;
        for (let c = 0; c < ch; c++) {
          const v = s[(prevEnd + i) * ch + c] * (1 - w) + s[(src + i) * ch + c] * w;
          fade[i * ch + c] = Math.round(v);
        }
      }
    }
    if (n > 0 && dst !== src) s.copyWithin(dst * ch, src * ch, (src + n) * ch);
    // lo que el original no llega a cubrir, en silencio
    if (n < len) s.fill(0, (dst + n) * ch, (dst + len) * ch);
    if (fade) s.set(fade, dst * ch);
    prevEnd = src + len;
    prevPos = b;
    k += b - a;
  }
  const bytes = at(k) * ch * 2;
  return { ...pcm, pcm: pcm.pcm.subarray(0, bytes) };
}

/** El sonido que pide `opts` para un video de `frames` fotogramas a `fps`,
 *  ya decodificado (y cortado, con AudioFrom.keep), o el motivo de que no lo
 *  haya. Nunca lanza por culpa del audio: un fallo suyo deja el video mudo
 *  con su explicación, porque perder una exportación de minutos por una
 *  pista rota sería peor. Una PARADA sí sale: es lo que se pidió. */
export async function pcmForExport(
  opts: ExportOptions,
  frames: number,
  fps: number,
): Promise<ExportSound> {
  if (!opts.audio) return { pcm: null };
  const keep = opts.audio.keep;
  if (keep) checkKeep(keep, frames);
  // con cortes se decodifica hasta el final del último tramo, y se empalma
  const span = keep?.length ? keep[keep.length - 1][1] : frames;
  const duration = span / fps;
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
    opts.onProgress?.('sound', 0, 1);
    const t0 = performance.now();
    const pcm = await decodePcm(a.track, opts.audio.start, duration, opts.signal, (p) =>
      opts.onProgress?.('sound', p, 1),
    );
    if (!pcm) return { pcm: null, note: `${name} decoded no sound for that range` };
    console.info(
      `[video] sound: ${(pcm.pcm.length / 1e6).toFixed(1)} MB of PCM, ${pcm.channels} ch at ${pcm.sampleRate} Hz, decoded in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
    );
    if (keep && (keep.length > 1 || keep[0][0] !== 0)) {
      const cut = spliceKept(pcm, keep, fps);
      console.info(
        `[video] sound cut to ${keep.length} piece(s): ${(span / fps).toFixed(2)} s → ${(frames / fps).toFixed(2)} s`,
      );
      return { pcm: cut };
    }
    return { pcm };
  } catch (e) {
    if (isCancelled(e)) throw e;
    console.warn('[video] the sound could not be decoded; the video comes out silent:', e);
    return { pcm: null, note: `the sound of ${name} could not be decoded (${errMsg(e)})` };
  } finally {
    a.input.dispose();
  }
}
