// MOV con un PNG por fotograma y el sonido como PCM de 16 bits: el muxer
// propio de la exportación sin pérdida. Escribe el archivo de una pasada y
// en orden (ftyp, mdat, moov), por trozos y sin tenerlo entero en memoria:
// los PNG se copian byte a byte desde sus Blobs (que viven en OPFS) y el
// tamaño del mdat se sabe de antemano, así que no hay que volver atrás. Sin
// tope de tamaño: co64 y mdat de 64 bits siempre.
//
// Antes lo hacía ffmpeg.wasm (stream copy), pero su MOV de salida vivía en
// la memoria del módulo y todo lo que pasaba de 1.4 GB se rechazaba.
// mediabunny no tiene códec PNG, así que aquí va lo mínimo del formato
// QuickTime que los lectores (ffmpeg y lo que lo lleva dentro: DaVinci,
// Premiere, VLC, IINA) piden para 'png ' y 'sowt'.

import { throwIfCancelled } from './errors.ts';
import type { OutputFile } from './opfs.ts';
import type { Bytes } from './types.ts';

/** Muestras PCM s16le entrelazadas (lo que deja ffmpeg en un WAV). */
export interface PcmAudio {
  pcm: Bytes;
  channels: number;
  sampleRate: number;
}

export interface PngMovOptions {
  signal?: AbortSignal;
  /** Fotogramas escritos hasta ahora, de n. */
  onProgress?: (i: number, n: number) => void;
  /** Los PNG llevan canal alfa: la descripción de muestra dice 32 bits en
   *  vez de 24. Quien llama lo sabe de TODOS los fotogramas; mirar sólo el
   *  primero se equivocaría con una secuencia mezclada. */
  alpha?: boolean;
}

/** Escala de tiempo entera para `fps` (12 → 12/1; 29.97 → 2997/100). */
function frameTiming(fps: number): { timescale: number; delta: number } {
  for (let k = 1; k <= 1000; k++) {
    const t = fps * k;
    if (Math.abs(t - Math.round(t)) < 1e-6) return { timescale: Math.round(t), delta: k };
  }
  return { timescale: Math.round(fps * 1000), delta: 1000 };
}

// ── átomos ────────────────────────────────────────────────────────────────

type Part = Uint8Array | number[];

function concat(parts: Part[]): Bytes {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u16(v: number): number[] {
  return [(v >> 8) & 255, v & 255];
}
function u32(v: number): number[] {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}
function u64(v: number): number[] {
  const hi = Math.floor(v / 2 ** 32);
  return [...u32(hi), ...u32(v >>> 0)];
}
function fourcc(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
/** Cadena Pascal en un campo de `len` bytes (nombre del compresor). */
function pascal(s: string, len: number): number[] {
  const b = [...s].map((c) => c.charCodeAt(0)).slice(0, len - 1);
  return [b.length, ...b, ...new Array(len - 1 - b.length).fill(0)];
}
function cstr(s: string): number[] {
  return [...fourcc(s), 0];
}
function box(type: string, ...parts: Part[]): Bytes {
  const body = concat(parts);
  return concat([u32(8 + body.length), fourcc(type), body]);
}
/** Átomo "full": versión 0 y flags. */
function fbox(type: string, flags: number, ...parts: Part[]): Bytes {
  return box(type, u32(flags & 0xffffff), ...parts);
}

const UNITY_MATRIX = [
  ...u32(0x10000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x10000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x40000000),
];

function mvhd(timescale: number, duration: number, nextTrack: number): Bytes {
  return fbox(
    'mvhd',
    0,
    u32(0), // creación
    u32(0), // modificación
    u32(timescale),
    u32(duration),
    u32(0x10000), // velocidad 1.0
    u16(0x100), // volumen 1.0
    new Array(10).fill(0),
    UNITY_MATRIX,
    new Array(24).fill(0), // predefinidos
    u32(nextTrack),
  );
}

function tkhd(id: number, duration: number, w: number, h: number, audio: boolean): Bytes {
  return fbox(
    'tkhd',
    0xf, // activa, en la película, en la vista previa, en el póster
    u32(0),
    u32(0),
    u32(id),
    u32(0),
    u32(duration),
    new Array(8).fill(0),
    u16(0), // capa
    u16(0), // grupo alternativo
    u16(audio ? 0x100 : 0), // volumen
    u16(0),
    UNITY_MATRIX,
    u32(w << 16),
    u32(h << 16),
  );
}

function mdhd(timescale: number, duration: number): Bytes {
  return fbox('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
}

function hdlr(component: string, type: string, name: string): Bytes {
  return fbox('hdlr', 0, fourcc(component), fourcc(type), new Array(12).fill(0), cstr(name));
}

function dinf(): Bytes {
  // referencia de datos "alias" a este mismo archivo, como escribe ffmpeg en
  // los MOV
  return box('dinf', fbox('dref', 0, u32(1), fbox('alis', 1)));
}

function stsdPng(w: number, h: number, depth: number): Bytes {
  return fbox(
    'stsd',
    0,
    u32(1),
    box(
      'png ',
      new Array(6).fill(0),
      u16(1), // índice de referencia de datos
      u16(0), // versión
      u16(0), // revisión
      u32(0), // fabricante
      u32(0), // calidad temporal
      u32(0), // calidad espacial
      u16(w),
      u16(h),
      u32(0x480000), // 72 ppp
      u32(0x480000),
      u32(0), // tamaño de datos
      u16(1), // fotogramas por muestra
      pascal('PNG', 32),
      u16(depth),
      u16(0xffff), // sin tabla de color
    ),
  );
}

function stsdSowt(channels: number, sampleRate: number): Bytes {
  return fbox(
    'stsd',
    0,
    u32(1),
    box(
      'sowt',
      new Array(6).fill(0),
      u16(1),
      u16(0), // versión 0: hasta 2 canales de 16 bits
      u16(0),
      u32(0),
      u16(channels),
      u16(16),
      u16(0), // id de compresión
      u16(0), // tamaño de paquete
      // 16.16 sin signo: por encima de 65535 Hz no cabe y desbordaría. Se
      // deja en cero, que es lo que escribe ffmpeg, y el ritmo verdadero lo
      // lleva el `mdhd` de la pista, que es de donde lo leen los lectores
      u32(sampleRate <= 0xffff ? sampleRate * 0x10000 : 0),
    ),
  );
}

function stts(count: number, delta: number): Bytes {
  return fbox('stts', 0, u32(1), u32(count), u32(delta));
}

/** Entradas stsc a partir de las muestras por trozo, comprimiendo rachas. */
function stsc(samplesPerChunk: number[]): Bytes {
  const entries: number[] = [];
  let n = 0;
  let last = -1;
  for (const [i, c] of samplesPerChunk.entries()) {
    if (c !== last) {
      entries.push(...u32(i + 1), ...u32(c), ...u32(1));
      n++;
      last = c;
    }
  }
  return fbox('stsc', 0, u32(n), entries);
}

function stsz(sizes: number[] | null, constant: number, count: number): Bytes {
  if (sizes) {
    const table = new Uint8Array(sizes.length * 4);
    const dv = new DataView(table.buffer);
    for (const [i, size] of sizes.entries()) dv.setUint32(i * 4, size);
    return fbox('stsz', 0, u32(0), u32(sizes.length), table);
  }
  return fbox('stsz', 0, u32(constant), u32(count));
}

function co64(offsets: number[]): Bytes {
  const table = new Uint8Array(offsets.length * 8);
  const dv = new DataView(table.buffer);
  offsets.forEach((o, i) => {
    dv.setUint32(i * 8, Math.floor(o / 2 ** 32));
    dv.setUint32(i * 8 + 4, o >>> 0);
  });
  return fbox('co64', 0, u32(offsets.length), table);
}

/**
 * Escribe en `out` el MOV completo: `frames` en orden (con repetidos), a
 * `fps`, todos PNG de `w`×`h`; `audio` opcional, desde el instante cero. El
 * mdat va entrelazado por segundos (los fotogramas de ese segundo y luego
 * su sonido), que es como lo esperan los reproductores.
 */
export async function writePngMov(
  out: OutputFile,
  frames: Blob[],
  fps: number,
  w: number,
  h: number,
  audio: PcmAudio | null,
  opts: PngMovOptions = {},
): Promise<void> {
  const n = frames.length;
  if (!n) throw new Error('There are no frames to build the video.');
  if (!Number.isFinite(fps) || fps <= 0)
    throw new Error('The frames per second must be a number greater than zero.');
  const { timescale, delta } = frameTiming(fps);
  const depth = opts.alpha === false ? 24 : 32;
  const bpf = audio ? 2 * audio.channels : 0; // bytes por muestra de audio
  const nSamples = audio ? Math.floor(audio.pcm.length / bpf) : 0;
  const rate = audio?.sampleRate ?? 1;

  // orden de escritura y offsets, calculados antes de escribir nada
  const ftyp = box('ftyp', fourcc('qt  '), u32(0x200), fourcc('qt  '));
  const sizes = frames.map((f) => f.size);
  const payload = sizes.reduce((a, b) => a + b, 0) + nSamples * bpf;
  const mdatHead = concat([u32(1), fourcc('mdat'), u64(16 + payload)]);
  const secondOf = (i: number): number => Math.floor(i / fps);
  const seconds = Math.max(secondOf(n - 1) + 1, Math.ceil(nSamples / rate));
  const videoOffsets: number[] = new Array(n);
  const audioChunks: { offset: number; samples: number }[] = [];
  type Piece = { frame: number } | { sample0: number; samples: number };
  const order: Piece[] = [];
  let pos = ftyp.length + mdatHead.length;
  let frame = 0;
  for (let k = 0; k < seconds; k++) {
    while (frame < n && secondOf(frame) === k) {
      videoOffsets[frame] = pos;
      pos += sizes[frame];
      order.push({ frame });
      frame++;
    }
    const sample0 = k * rate;
    const samples = Math.min(rate, nSamples - sample0);
    if (samples > 0) {
      audioChunks.push({ offset: pos, samples });
      order.push({ sample0, samples });
      pos += samples * bpf;
    }
  }

  const videoDur = n * delta;
  const audioDurMovie = audio ? Math.round((nSamples / rate) * timescale) : 0;
  const movieDur = Math.max(videoDur, audioDurMovie);
  const trakVideo = box(
    'trak',
    tkhd(1, videoDur, w, h, false),
    box(
      'mdia',
      mdhd(timescale, videoDur),
      hdlr('mhlr', 'vide', 'VideoHandler'),
      box(
        'minf',
        fbox('vmhd', 1, u16(0), u16(0), u16(0), u16(0)),
        hdlr('dhlr', 'alis', 'DataHandler'),
        dinf(),
        box(
          'stbl',
          stsdPng(w, h, depth),
          stts(n, delta),
          stsc([1]), // cada fotograma en su propio trozo
          stsz(sizes, 0, n),
          co64(videoOffsets),
        ),
      ),
    ),
  );
  const trakAudio = audio
    ? box(
        'trak',
        tkhd(2, audioDurMovie, 0, 0, true),
        box(
          'mdia',
          mdhd(rate, nSamples),
          hdlr('mhlr', 'soun', 'SoundHandler'),
          box(
            'minf',
            fbox('smhd', 0, u16(0), u16(0)),
            hdlr('dhlr', 'alis', 'DataHandler'),
            dinf(),
            box(
              'stbl',
              stsdSowt(audio.channels, rate),
              stts(nSamples, 1),
              stsc(audioChunks.map((c) => c.samples)),
              stsz(null, bpf, nSamples),
              co64(audioChunks.map((c) => c.offset)),
            ),
          ),
        ),
      )
    : null;
  const moov = box(
    'moov',
    mvhd(timescale, movieDur, trakAudio ? 3 : 2),
    trakVideo,
    ...(trakAudio ? [trakAudio] : []),
  );

  await out.write(ftyp);
  await out.write(mdatHead);
  let written = 0;
  for (const piece of order) {
    throwIfCancelled(opts.signal, 'Video export cancelled.');
    if ('frame' in piece) {
      await out.write(frames[piece.frame]);
      // el contador, FUERA de la llamada opcional: `f?.(++written)` no
      // evalúa sus argumentos cuando no hay callback, y el recuento se
      // quedaba a cero
      written++;
      opts.onProgress?.(written, n);
    } else if (audio) {
      await out.write(
        audio.pcm.subarray(piece.sample0 * bpf, (piece.sample0 + piece.samples) * bpf),
      );
    }
  }
  await out.write(moov);
  // lo escrito TIENE que ser lo que el mdat anunció: si no, el archivo sale
  // truncado y sin moov, y el navegador lo habría dado por bueno
  if (written !== n) throw new Error(`The MOV muxer wrote ${written} of ${n} frames.`);
}
