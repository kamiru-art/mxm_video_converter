// El video final, SIEMPRE sin pérdida.
//
// Cada fotograma va como PNG: dentro de un MOV (lo abren DaVinci Resolve,
// Premiere, After Effects, VLC, IINA, ffmpeg) o como secuencia numerada en
// un ZIP (la importa cualquier editor, también los que no leen PNG en MOV,
// como Final Cut). No hay calidades que elegir porque no hay nada que
// perder: los píxeles que salen son los que entraron.
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

import type { InputAudioTrack } from 'mediabunny';
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
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
}

/** Dónde va la secuencia: un MOV, o un ZIP de PNG numerados. */
export type ExportKind = 'mov' | 'frames';

/** Las fases de una exportación, en orden. */
export type ExportStage = 'preparing' | 'sound' | 'writing';

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

/** Cuántos fotogramas conformar a la vez: tantos workers como haya, pero
 *  sin que sus picos (decodificado + lienzo + PNG, unas tres copias del
 *  fotograma) pasen de una cuarta parte de la RAM que el navegador dice
 *  tener. Sin ese dato (Safari, Firefox) se suponen 4 GB, como en la
 *  fase ②: en un teléfono es lo que evita que la pestaña se muera. */
function conformConcurrency(plan: SequencePlan): number {
  const perJob = plan.w * plan.h * (plan.sixteen ? 8 : 4) * 3;
  const budget = (navigator.deviceMemory || 4) * 1e9 * 0.25;
  return Math.max(1, Math.min(poolSize(), Math.floor(budget / Math.max(1, perJob))));
}

/** Los PNG de la secuencia, ya uniformes: los que valen tal cual, y los
 *  demás conformados por el núcleo y guardados en el disco privado. */
async function uniformPngs(
  frames: Blob[],
  plan: SequencePlan,
  infos: Map<Blob, FrameInfo>,
  opts: ExportOptions,
): Promise<Blob[]> {
  // los conformados de la exportación anterior ya no los mira nadie (el
  // archivo que salió de ellos es una copia aparte)
  await clearExportCache();
  const want = plan.alpha ? 6 : 2;
  const todo = [...infos.entries()].filter(
    ([, i]) =>
      !(
        i.png &&
        i.w === plan.w &&
        i.h === plan.h &&
        i.sixteen === plan.sixteen &&
        i.colour === want
      ),
  );
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
        { bytes, w: plan.w, h: plan.h, sixteen: plan.sixteen, alpha: plan.alpha },
        [bytes.buffer],
      );
      done.set(blob, await storeExportFrame(png));
      finished++;
      report();
    }
  };
  const n = Math.min(todo.length, conformConcurrency(plan));
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
  const sound = await pcmForExport(opts, frames.length / fps);
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
    opts.onProgress?.('sound', 0, 1);
    const t0 = performance.now();
    const pcm = await decodePcm(a.track, opts.audio.start, duration, opts.signal, (p) =>
      opts.onProgress?.('sound', p, 1),
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
