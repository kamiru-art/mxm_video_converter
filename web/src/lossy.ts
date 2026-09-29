// El video final comprimido: un MP4 para ver y compartir, que se reproduce
// en cualquier navegador, teléfono y QuickTime. El máster sigue siendo el
// sin pérdida (export.ts); esto es la copia ligera, y se hace desde el mismo
// plan (tamaño de la mayoría, dibujos deduplicados, sonido del original).
//
// Pocas opciones a propósito: tres niveles de calidad con bitrate variable
// (el codificador gasta bits donde el dibujo cambia y ahorra en lo quieto,
// alrededor de un objetivo que crece con la resolución) y un bitrate fijo
// para quien necesita un tamaño o un caudal exactos.
//
// Rendimiento: el navegador decodifica los PNG (de 8 o 16 bits) por su
// cuenta, fuera del hilo principal y por delante del codificador; el núcleo
// sólo conforma lo que el navegador no abre (TIFF) o lo que no mide lo que
// la secuencia. Un dibujo repetido se decodifica una vez mientras quepa en
// memoria. El archivo va al disco privado del navegador según se codifica.

import type { AudioCodec, OutputFormat, VideoCodec } from 'mediabunny';
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  getFirstEncodableAudioCodec,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
} from 'mediabunny';
import { errMsg, throwIfCancelled } from './errors.ts';
import type { ExportOptions, SequencePlan, VideoResult } from './export.ts';
import { pcmForExport, planSequence, uniformPngs } from './export.ts';
import type { FrameInfo } from './imageinfo.ts';
import { openSeekableOutput } from './opfs.ts';
import type { PcmAudio } from './pngmov.ts';
import { context2d } from './ui.ts';

/** Los niveles de calidad. `custom` es un bitrate fijo. */
export type CompressedQuality = 'best' | 'high' | 'compact' | 'custom';

/** Nivel de calidad de mediabunny de cada preset, siempre como bitrate
 *  (`preferBitrate`). En H.264 a 1080p son unos 41, 22 y 6 Mbps, y crecen
 *  con los píxeles (4K: unos 150, 80 y 22). No se usa el cuantizador fijo aunque mediabunny lo
 *  ofrezca: Firefox acepta el modo y luego ignora el QP, y los tres presets
 *  salían idénticos (medido en Zen: el mismo archivo byte a byte). */
const LEVELS: Record<Exclude<CompressedQuality, 'custom'>, number> = {
  best: 1.5,
  high: 1.25,
  compact: 0.75,
};

export const MAX_MBPS = 500;

/** H.264 primero: es el que reproduce todo. Los demás, sólo si el navegador
 *  no codifica H.264 a ese tamaño (los codificadores por hardware tienen
 *  tope de resolución). Todos van en MP4. */
const CODECS: VideoCodec[] = ['avc', 'hevc', 'vp9', 'av1'];

export const CODEC_NAMES: Record<string, string> = {
  avc: 'H.264',
  hevc: 'H.265',
  vp9: 'VP9',
  av1: 'AV1',
};

export interface CompressedOptions extends ExportOptions {
  quality?: CompressedQuality;
  /** Con `custom`: el bitrate fijo, en Mbps. */
  mbps?: number;
}

export interface CompressedResult extends VideoResult {
  codec: VideoCodec;
  /** El tamaño del video (encodeSize del plan). */
  w: number;
  h: number;
  /** Se pidió bitrate fijo y el navegador sólo lo sostiene de media. */
  rateNote?: string;
  /** Dibujos que el navegador decodificó tal cual. */
  direct: number;
  /** Dibujos que el núcleo tuvo que conformar (TIFF, otro tamaño). */
  conformed: number;
}

/** El tamaño del video: ancho múltiplo de 4 y alto par. Lo que falta se
 *  añade en blanco a la derecha y abajo, sin remuestrear el dibujo. Par lo
 *  exige el 4:2:0; múltiplo de 4 en el ancho, Chrome: con un ancho de la
 *  forma 4k + 2 (642, 730…) su paso de lienzo a codificador corre la imagen
 *  entera un píxel (medido con WebCodecs a pelo, H.264 y VP9; Firefox y
 *  Safari no lo hacen). */
export function encodeSize(w: number, h: number): [number, number] {
  return [Math.ceil(w / 4) * 4, h + (h & 1)];
}

function qualityFor(q: CompressedQuality, mbps: number, mode: 'constant' | 'variable'): Quality {
  if (q === 'custom') {
    const clamped = Math.min(MAX_MBPS, Math.max(0.1, Number.isFinite(mbps) ? mbps : 0));
    return new Quality({ bitrate: Math.round(clamped * 1e6), bitrateMode: mode });
  }
  return new Quality({ quality: LEVELS[q], preferBitrate: true, bitrateMode: 'variable' });
}

interface Pick {
  codec: VideoCodec;
  quality: Quality;
  rateNote?: string;
}

/** El primer códec que el navegador codifica a `w`×`h` con esa calidad. Con
 *  bitrate fijo, cada códec prueba el modo constante y, si no lo admite, el
 *  mismo bitrate como objetivo medio (y se dice): un H.264 de caudal medio
 *  se reproduce en todas partes, un VP9 constante no en QuickTime ni iOS. */
async function pickCodec(
  w: number,
  h: number,
  q: CompressedQuality,
  mbps: number,
): Promise<Pick | null> {
  const modes: ('constant' | 'variable')[] =
    q === 'custom' ? ['constant', 'variable'] : ['variable'];
  for (const codec of CODECS) {
    for (const mode of modes) {
      const quality = qualityFor(q, mbps, mode);
      if (await canEncodeVideo(codec, { width: w, height: h, quality })) {
        return {
          codec,
          quality,
          rateNote:
            q === 'custom' && mode === 'variable'
              ? 'this browser cannot hold a bitrate fixed, so it keeps it as the average'
              : undefined,
        };
      }
    }
  }
  return null;
}

/** AAC donde el navegador lo codifica (Chrome, Safari), Opus si no. */
async function pickAudioCodec(format: OutputFormat, pcm: PcmAudio): Promise<AudioCodec | null> {
  const supported = format.getSupportedAudioCodecs();
  return getFirstEncodableAudioCodec(
    (['aac', 'opus'] as AudioCodec[]).filter((c) => supported.includes(c)),
    { numberOfChannels: pcm.channels, sampleRate: pcm.sampleRate },
  );
}

/** El sonido ya decodificado (el mismo que lleva el MOV sin pérdida), en
 *  bloques de un segundo. Corre a la vez que el video: el muxer entrelaza
 *  por marca de tiempo, y esperar a uno antes de empezar el otro dejaría
 *  al muxer esperando una pista que no llega. */
async function feedAudio(
  source: AudioSampleSource,
  pcm: PcmAudio,
  signal: AbortSignal | undefined,
): Promise<void> {
  const bpf = pcm.channels * 2;
  const total = Math.floor(pcm.pcm.length / bpf);
  const step = pcm.sampleRate;
  for (let f = 0; f < total; f += step) {
    throwIfCancelled(signal, 'Video export cancelled.');
    const n = Math.min(step, total - f);
    // una COPIA del bloque, no una vista: mediabunny (1.55) crea el
    // AudioData con `data.buffer` y pierde el desplazamiento de la vista,
    // así que cada segundo empezaba por el principio del sonido
    const sample = new AudioSample({
      data: pcm.pcm.slice(f * bpf, (f + n) * bpf),
      format: 's16',
      numberOfChannels: pcm.channels,
      sampleRate: pcm.sampleRate,
      timestamp: f / pcm.sampleRate,
    });
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  }
  source.close();
}

/** Cuántos dibujos pedir por delante del que se codifica. */
const PREFETCH = 4;

/**
 * Los fotogramas decodificados, en el orden de la línea de tiempo. Se piden
 * por delante (el navegador decodifica mientras el codificador trabaja) y un
 * dibujo repetido se queda decodificado hasta su última aparición. Si no
 * caben todos, sale el que vuelve a usarse más tarde, que es la expulsión
 * que menos decodificaciones repite.
 */
class FrameQueue {
  private readonly seq: Blob[];
  private readonly next: number[];
  private readonly live = new Map<Blob, { bmp: Promise<ImageBitmap>; nextUse: number }>();
  private readonly max: number;

  constructor(seq: Blob[], bytesPerFrame: number) {
    this.seq = seq;
    this.next = new Array(seq.length);
    const seen = new Map<Blob, number>();
    for (let i = seq.length - 1; i >= 0; i--) {
      this.next[i] = seen.get(seq[i]) ?? Number.POSITIVE_INFINITY;
      seen.set(seq[i], i);
    }
    const budget = Math.min(512e6, (navigator.deviceMemory || 4) * 1e9 * 0.08);
    this.max = Math.max(2, Math.min(64, Math.floor(budget / Math.max(1, bytesPerFrame))));
  }

  private load(j: number): { bmp: Promise<ImageBitmap>; nextUse: number } {
    const blob = this.seq[j];
    let e = this.live.get(blob);
    if (!e) {
      // los valores guardados, sin gestión de color: así los ve el máster
      // sin pérdida, y un PNG con gAMA/iCCP que pasa tal cual no puede salir
      // de otro color que uno que el núcleo conformó (y que ya no los lleva)
      e = { bmp: createImageBitmap(blob, { colorSpaceConversion: 'none' }), nextUse: j };
      e.bmp.catch(() => {}); // el error sale al pedirlo, no como rechazo suelto
      this.live.set(blob, e);
    }
    return e;
  }

  async take(i: number): Promise<ImageBitmap> {
    const e = this.load(i);
    const end = Math.min(this.seq.length, i + 1 + PREFETCH);
    for (let j = i + 1; j < end && this.live.size < this.max; j++) this.load(j);
    try {
      return await e.bmp;
    } catch (err) {
      throw new Error(`Frame ${i + 1} cannot be decoded by this browser: ${errMsg(err)}`);
    }
  }

  /** El fotograma `i` ya está en el lienzo. */
  done(i: number): void {
    const blob = this.seq[i];
    const e = this.live.get(blob);
    if (!e) return;
    e.nextUse = this.next[i];
    if (e.nextUse === Number.POSITIVE_INFINITY) this.drop(blob);
    while (this.live.size > this.max) {
      let far: Blob | null = null;
      let farUse = -1;
      for (const [b, v] of this.live)
        if (v.nextUse > farUse) {
          far = b;
          farUse = v.nextUse;
        }
      if (!far) break;
      this.drop(far);
    }
  }

  private drop(blob: Blob): void {
    const e = this.live.get(blob);
    if (!e) return;
    this.live.delete(blob);
    e.bmp.then(
      (b) => b.close(),
      () => {},
    );
  }

  dispose(): void {
    for (const b of [...this.live.keys()]) this.drop(b);
  }
}

/** Lo que va a salir, antes de codificar nada: el tamaño par y, con bitrate
 *  fijo, el peso aproximado. Para la interfaz. */
export function describeCompressed(
  plan: SequencePlan,
  fps: number,
  q: CompressedQuality,
  mbps: number,
): string {
  const [w, h] = encodeSize(plan.w, plan.h);
  const size = `${w}×${h}${w !== plan.w || h !== plan.h ? ` (the frames are ${plan.w}×${plan.h}; a white edge fills the difference, the drawing is not resized)` : ''}`;
  const names: Record<CompressedQuality, string> = {
    best: 'Best quality',
    high: 'High quality',
    compact: 'Compact',
    custom: `fixed ${mbps} Mbps`,
  };
  let txt = `Compressed MP4 (H.264 where this browser has it): ${size}, ${plan.frames} frames, ${names[q]}.`;
  if (q === 'custom' && Number.isFinite(mbps) && fps > 0) {
    const mb = (Math.min(MAX_MBPS, mbps) * 1e6 * (plan.frames / fps)) / 8 / 1e6;
    txt += ` About ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB of picture.`;
  } else {
    txt += ' The bitrate follows the picture: still drawings take little, busy ones more.';
  }
  return `${txt} It loses detail on purpose; keep the lossless MOV or PNG frames as the master.`;
}

/**
 * El video comprimido. `frames`, como en exportLossless: en el orden de la
 * línea de tiempo, con repetidos (un dibujo deduplicado es el mismo Blob).
 */
export async function exportCompressed(
  frames: Blob[],
  fps: number,
  opts: CompressedOptions = {},
): Promise<CompressedResult> {
  if (!Number.isFinite(fps) || fps <= 0)
    throw new Error('The frames per second must be a number greater than zero.');
  const q = opts.quality ?? 'high';
  const mbps = opts.mbps ?? 20;
  const { plan, infos } = await planSequence(frames, opts.signal);
  const [w, h] = encodeSize(plan.w, plan.h);
  const pick = await pickCodec(w, h, q, mbps);
  if (!pick)
    throw new Error(
      `This browser cannot compress video at ${w}×${h}. Save it lossless (MOV or PNG frames): that works at any size.`,
    );
  // el navegador abre PNG de cualquier profundidad; el núcleo conforma el
  // resto a PNG de 8 bits, que es lo que el codificador come
  const spec = {
    sixteen: false,
    alpha: plan.alpha,
    fits: (i: FrameInfo) => i.png && i.w === plan.w && i.h === plan.h,
  };
  const conformed = [...infos.values()].filter((i) => !spec.fits(i)).length;
  const pngs = await uniformPngs(frames, plan, infos, opts, spec);
  throwIfCancelled(opts.signal, 'Video export cancelled.');
  const sound = await pcmForExport(opts, frames.length / fps);
  throwIfCancelled(opts.signal, 'Video export cancelled.');

  // el índice (moov) al principio, también escribiendo a disco: con el
  // hueco reservado, un MP4 subido a una web se reproduce mientras baja
  const format = new Mp4OutputFormat({ fastStart: 'reserve' });
  const disk = await openSeekableOutput(`${Date.now()}-video.mp4`, 'video/mp4');
  const memory = disk ? null : new BufferTarget();
  // trozos de 16 MB: pocas escrituras al disco, y el muxer sólo guarda en
  // memoria el que está llenando
  const target = disk
    ? new StreamTarget(disk.stream, { chunked: true, chunkSize: 16 * 2 ** 20 })
    : (memory as BufferTarget);
  const output = new Output({ format, target });
  let queue: FrameQueue | null = null;
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = context2d(canvas, { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const video = new CanvasSource(canvas, {
      codec: pick.codec,
      quality: pick.quality,
      onEncodedPacket: (_packet, meta) => {
        // Desde un lienzo, los tres navegadores codifican en rango limitado
        // (medido: Y = 16 + 219/255 · Y'), pero Safari (26.5) declara
        // `fullRange: true` en la configuración, que mediabunny copia a la
        // caja `colr` del MP4: todo reproductor, QuickTime incluido, lo
        // enseñaba lavado y oscuro. El dato de verdad es el de los píxeles.
        const cs = meta?.decoderConfig?.colorSpace;
        if (cs?.fullRange) cs.fullRange = false;
      },
    });
    output.addVideoTrack(video, { frameRate: fps, maximumPacketCount: pngs.length });
    let audioSource: AudioSampleSource | null = null;
    let audioNote = sound.note;
    if (sound.pcm) {
      const codec = await pickAudioCodec(format, sound.pcm);
      if (codec) {
        audioSource = new AudioSampleSource({ codec, quality: new Quality('high') });
        // paquetes de AAC (1024 muestras) u Opus (20 ms): el tope se cuenta
        // con 10 ms por paquete, holgado; reservar de más cuesta bytes
        const secs = sound.pcm.pcm.length / (sound.pcm.channels * 2) / sound.pcm.sampleRate;
        output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(secs / 0.01) + 64 });
      } else {
        audioNote = `this browser cannot encode ${sound.pcm.channels}-channel sound at ${sound.pcm.sampleRate} Hz for MP4`;
      }
    }
    await output.start();
    const audioDone =
      audioSource && sound.pcm ? feedAudio(audioSource, sound.pcm, opts.signal) : Promise.resolve();
    // un fallo del sonido para la exportación en el fotograma siguiente,
    // no después de codificar minutos de video que se van a tirar
    let audioError: unknown = null;
    audioDone.catch((e: unknown) => {
      audioError = e ?? new Error('The sound encoder failed.');
    });

    queue = new FrameQueue(pngs, plan.w * plan.h * 4);
    const dur = 1 / fps;
    for (let i = 0; i < pngs.length; i++) {
      throwIfCancelled(opts.signal, 'Video export cancelled.');
      if (audioError) throw audioError;
      const bmp = await queue.take(i);
      // con alfa, cada fotograma se compone sobre papel blanco: el lienzo
      // no guarda transparencia y la de uno no puede asomar en el siguiente
      if (plan.alpha) ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0);
      queue.done(i);
      await video.add(i * dur, dur);
      opts.onProgress?.('encoding', i + 1, pngs.length);
    }
    await audioDone;
    await output.finalize();
    const bytes = disk ? await disk.file() : new Uint8Array(memory?.buffer ?? new ArrayBuffer(0));
    if (!(bytes instanceof Blob ? bytes.size : bytes.byteLength))
      throw new Error('The video encoder produced no output.');
    return {
      bytes,
      mime: 'video/mp4',
      ext: 'mp4',
      audio: !!audioSource,
      audioNote: audioSource ? undefined : audioNote,
      plan,
      codec: pick.codec,
      w,
      h,
      rateNote: pick.rateNote,
      direct: plan.unique - conformed,
      conformed,
    };
  } catch (e) {
    // soltar el codificador primero (Chrome limita cuántos hay abiertos) y
    // luego el archivo a medias del disco
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      try {
        await output.cancel();
      } catch (err) {
        console.warn('[video] could not cancel the encoder cleanly:', err);
      }
    }
    await disk?.abort();
    throw e;
  } finally {
    queue?.dispose();
  }
}
