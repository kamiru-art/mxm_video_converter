// Verificación del video sin pérdida POR FUERA del navegador.
//
// La página (src/e2e.ts) exporta una secuencia difícil, un MOV, un ZIP de
// fotogramas y un MOV con alfa, y deja también las fuentes. Aquí se
// decodifica todo con el ffmpeg de la máquina, que no comparte una línea de
// código con el que escribió los archivos, y se compara muestra a muestra en
// 16 bits: un fotograma de 16 bits tiene que salir idéntico, uno de 8 bits
// ensanchado exactamente (v · 257, que es también lo que hace ffmpeg al
// pasar rgb24 a rgb48) y, si medía 322×179, centrado en 320×180 sin
// remuestrear. Si la exportación perdiera un solo bit en cualquier sitio,
// alguna de estas igualdades falla.
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis TypeScript
// borrable, como en e2e-run.mts.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface LosslessResult {
  ok: boolean;
  checks: Record<string, boolean>;
  outputs: Record<string, string>;
  log: string[];
}

interface Stream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  channels?: number;
  sample_rate?: string;
  duration?: string;
  nb_frames?: string;
}

function probe(file: string): Stream[] {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`ffprobe ${file}: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { streams: Stream[] }).streams;
}

/** Todos los fotogramas de `file`, en crudo, en `pixFmt`. */
function raw(file: string, pixFmt: string): Buffer {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg ${file}: ${r.stderr}`);
  return r.stdout;
}

function size(file: string): [number, number] {
  const v = probe(file).find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error(`${file}: no picture`);
  return [v.width, v.height];
}

/** La fuente en 16 bits por muestra (little-endian), `ch` canales. Una de
 *  8 bits se lee a 8 bits y se ensancha aquí, v · 257 (0 → 0, 255 → 65535):
 *  es la única ampliación exacta, y NO es lo que hace swscale al pasar
 *  rgb24 a rgb48 (111 → 28416 en vez de 28527), así que pedirle a ffmpeg
 *  la conversión daría una referencia equivocada. */
function source16(file: string, ch: 3 | 4): Buffer {
  const v = probe(file).find((s) => s.codec_type === 'video');
  const deep = /48|64/.test(v?.pix_fmt ?? '');
  if (deep) return raw(file, ch === 3 ? 'rgb48le' : 'rgba64le');
  const b8 = raw(file, ch === 3 ? 'rgb24' : 'rgba');
  const out = Buffer.alloc(b8.length * 2);
  for (let i = 0; i < b8.length; i++) out.writeUInt16LE(b8[i] * 257, i * 2);
  return out;
}

/** La fuente `file` puesta en un lienzo w×h como la pone conform.rs: tal
 *  cual si mide lo mismo; si casi, centrada (esquina = trunc((W − w) / 2))
 *  con relleno blanco. `ch` canales de 16 bits (3 u 4). */
function placed(file: string, w: number, h: number, ch: 3 | 4): Buffer {
  const [sw, sh] = size(file);
  const src = source16(file, ch);
  if (sw === w && sh === h) return src;
  const dx = Math.trunc((w - sw) / 2);
  const dy = Math.trunc((h - sh) / 2);
  const out = Buffer.alloc(w * h * ch * 2, 0xff);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= sh) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= sw) continue;
      src.copy(out, (y * w + x) * ch * 2, (sy * sw + sx) * ch * 2, (sy * sw + sx + 1) * ch * 2);
    }
  }
  return out;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export async function verifyLossless(dir: string, sequence: string[]): Promise<LosslessResult> {
  const checks: Record<string, boolean> = {};
  const outputs: Record<string, string> = {};
  const log: string[] = ['--- lossless, checked with the local ffmpeg'];
  const check = (name: string, ok: boolean, what: string): void => {
    checks[name] = ok;
    log.push(`${ok ? '✓' : '✗'} ${what}`);
  };
  const mov = join(dir, 'lossless.mov');
  if (!sequence.length || !existsSync(mov)) {
    check('lossless_files_present', false, 'the page left no lossless export to check');
    return { ok: false, checks, outputs, log };
  }
  try {
    const streams = probe(mov);
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    check(
      'lossless_mov_png_16bit',
      v?.codec_name === 'png' && v.width === 320 && v.height === 180 && v.pix_fmt === 'rgb48be',
      `MOV video: ${v?.codec_name} ${v?.width}×${v?.height} ${v?.pix_fmt} (want png 320×180 rgb48be)`,
    );
    check(
      'lossless_mov_pcm_stereo',
      a?.codec_name === 'pcm_s16le' &&
        a.channels === 2 &&
        a.sample_rate === '44100' &&
        Math.abs(Number(a.duration) - 2.5) < 0.01,
      `MOV sound: ${a?.codec_name} ${a?.channels} ch ${a?.sample_rate} Hz ${a?.duration} s (want pcm_s16le 2 ch 44100 Hz 2.5 s)`,
    );
    const W = 320;
    const H = 180;
    const frameBytes = W * H * 3 * 2;
    const got = raw(mov, 'rgb48le');
    check(
      'lossless_mov_frame_count',
      got.length === frameBytes * sequence.length,
      `MOV frames: ${got.length / frameBytes} (want ${sequence.length})`,
    );
    let exact = true;
    for (const [i, src] of sequence.entries()) {
      const want = placed(join(dir, src), W, H, 3);
      const frame = got.subarray(i * frameBytes, (i + 1) * frameBytes);
      if (!want.equals(frame)) {
        exact = false;
        log.push(`  frame ${i + 1} (${src}) differs from its source`);
      }
      outputs[`lossless/frame_${i + 1}.rgb48`] = sha(Buffer.from(frame));
    }
    check(
      'lossless_mov_bit_exact',
      exact,
      'every MOV frame equals its source, sample by sample at 16 bits (the 8-bit one widened, the 322×179 one centred)',
    );

    // el ZIP: los mismos fotogramas, un PNG por posición, y el sonido en WAV
    const zipDir = join(dir, 'zip');
    await rm(zipDir, { recursive: true, force: true });
    await mkdir(zipDir, { recursive: true });
    const unzip = spawnSync('unzip', ['-q', '-o', join(dir, 'lossless.zip'), '-d', zipDir]);
    const names = unzip.status === 0 ? (await readdir(zipDir)).sort() : [];
    const pngs = names.filter((n) => n.endsWith('.png'));
    const wantNames = sequence.map((_s, i) => `seq_${String(i + 1).padStart(6, '0')}.png`);
    check(
      'lossless_zip_names',
      unzip.status === 0 && pngs.join() === wantNames.join() && names.includes('seq.wav'),
      `ZIP entries: ${names.join(', ') || '(unreadable)'}`,
    );
    let zipExact = pngs.length === sequence.length;
    for (const [i, n] of pngs.entries()) {
      if (
        !raw(join(zipDir, n), 'rgb48le').equals(got.subarray(i * frameBytes, (i + 1) * frameBytes))
      )
        zipExact = false;
    }
    check(
      'lossless_zip_equals_mov',
      zipExact,
      'every PNG in the ZIP decodes to the same frame as the MOV',
    );
    const wav = names.includes('seq.wav') ? probe(join(zipDir, 'seq.wav'))[0] : undefined;
    check(
      'lossless_zip_wav',
      wav?.codec_name === 'pcm_s16le' &&
        wav.channels === 2 &&
        Math.abs(Number(wav.duration) - 2.5) < 0.01,
      `ZIP sound: ${wav?.codec_name} ${wav?.channels} ch ${wav?.duration} s`,
    );

    // con alfa: RGBA de 16 bits, el fotograma opaco con A = 65535 y el
    // transparente con su alfa intacto
    const alphaMov = join(dir, 'alpha.mov');
    const av = probe(alphaMov).find((s) => s.codec_type === 'video');
    const ga = raw(alphaMov, 'rgba64le');
    const fb = W * H * 4 * 2;
    const a0 = placed(join(dir, 'src_f16.png'), W, H, 4);
    const a1 = placed(join(dir, 'src_alpha.png'), W, H, 4);
    check(
      'lossless_alpha_exact',
      av?.pix_fmt === 'rgba64be' &&
        ga.length === 2 * fb &&
        a0.equals(ga.subarray(0, fb)) &&
        a1.equals(ga.subarray(fb)),
      `alpha MOV: ${av?.pix_fmt}, both frames equal their sources with their alpha`,
    );
  } catch (e) {
    check(
      'lossless_decodable',
      false,
      `ffmpeg could not check the export: ${e instanceof Error ? e.message : e}`,
    );
  }
  return { ok: Object.values(checks).every(Boolean), checks, outputs, log };
}

/** Lo que la página cuenta de sus MP4 (e2e.ts, `compressed`). */
export interface CompressedFacts {
  oddW?: number;
  oddH?: number;
  edgeW?: number;
  edgeH?: number;
  fixedMbps?: number;
  fixedSeconds?: number;
}

/** PSNR (dB) de cada fotograma de `a` frente al de `b`, en RGB de 8 bits. */
function psnr(a: string, b: string): number[] {
  const r = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      a,
      '-i',
      b,
      '-lavfi',
      '[0:v]format=rgb24[x];[1:v]format=rgb24[y];[x][y]psnr=stats_file=-',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg psnr: ${r.stderr}`);
  return [...r.stdout.matchAll(/psnr_avg:([\d.]+|inf)/g)].map((m) =>
    m[1] === 'inf' ? Number.POSITIVE_INFINITY : Number(m[1]),
  );
}

/** PSNR (dB) entre dos planos de luminancia de 8 bits del mismo tamaño. */
function psnrY(a: Buffer, b: Buffer): number {
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    se += d * d;
  }
  const mse = se / Math.max(1, a.length);
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

const mean = (v: number[]): number => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);

/**
 * Los MP4 comprimidos, decodificados por el ffmpeg de la máquina. No se
 * piden bytes exactos (el codificador es del navegador y pierde a
 * propósito), sino lo que un MP4 bueno tiene que cumplir: códec que todo
 * reproduce, tamaño par, los fotogramas en su orden y parecidos a los del
 * MOV sin pérdida (PSNR), el sonido, el píxel añadido en blanco y el
 * bitrate fijo que se pidió.
 */
export async function verifyCompressed(
  dir: string,
  facts: CompressedFacts | null,
  sequence: string[],
): Promise<LosslessResult> {
  const checks: Record<string, boolean> = {};
  const log: string[] = ['--- compressed MP4, checked with the local ffmpeg'];
  const check = (name: string, ok: boolean, what: string): void => {
    checks[name] = ok;
    log.push(`${ok ? '✓' : '✗'} ${what}`);
  };
  const mp4 = join(dir, 'compressed.mp4');
  const odd = join(dir, 'odd.mp4');
  const fixed = join(dir, 'fixed.mp4');
  const edge = join(dir, 'edge.mp4');
  const edgeSrc = join(dir, 'edge_src.png');
  if (
    ![mp4, odd, fixed, edge, edgeSrc].every(existsSync) ||
    !facts?.fixedMbps ||
    !facts.edgeW ||
    !facts.edgeH
  ) {
    check('compressed_files_present', false, 'the page left no compressed MP4 to check');
    return { ok: false, checks, outputs: {}, log };
  }
  const CODECS = ['h264', 'hevc', 'vp9', 'av1'];
  try {
    const streams = probe(mp4);
    const v = streams.find((s) => s.codec_type === 'video');
    const a = streams.find((s) => s.codec_type === 'audio');
    check(
      'mp4_video',
      !!v && CODECS.includes(v.codec_name) && v.width === 320 && v.height === 180,
      `MP4 video: ${v?.codec_name} ${v?.width}×${v?.height} (want h264/hevc/vp9/av1 320×180)`,
    );
    check(
      'mp4_sound',
      !!a && ['aac', 'opus'].includes(a.codec_name) && a.channels === 2,
      `MP4 sound: ${a?.codec_name} ${a?.channels} ch (want aac or opus, 2 ch)`,
    );
    // el ORDEN: la secuencia difícil es ruido de color píxel a píxel (para
    // que el sin pérdida no acierte de casualidad), que un 4:2:0 no puede
    // guardar; así que aquí no se pide calidad, sino que cada fotograma del
    // MP4 se parezca más a su fuente que a las otras, en luminancia
    const lossless = join(dir, 'lossless.mov');
    if (existsSync(lossless) && sequence.length) {
      const W = 320;
      const H = 180;
      const px = W * H;
      const got = raw(mp4, 'gray');
      const ref = raw(lossless, 'gray');
      const firstOf = new Map<string, number>();
      for (const [i, src] of sequence.entries()) if (!firstOf.has(src)) firstOf.set(src, i);
      let inOrder = got.length === px * sequence.length;
      for (const [i, src] of sequence.entries()) {
        if (!inOrder) break;
        const frame = got.subarray(i * px, (i + 1) * px);
        let best = '';
        let bestDb = -1;
        for (const [name, j] of firstOf) {
          const db = psnrY(frame, ref.subarray(j * px, (j + 1) * px));
          if (db > bestDb) {
            bestDb = db;
            best = name;
          }
        }
        if (best !== src) {
          inOrder = false;
          log.push(`  MP4 frame ${i + 1} looks like ${best}, want ${src}`);
        }
      }
      check(
        'mp4_frames_in_order',
        inOrder,
        `MP4 frames: ${got.length / px} in the timeline order, each closest to its own source (want ${sequence.length})`,
      );
    } else {
      check('mp4_frames_in_order', false, 'no lossless MOV to compare the MP4 against');
    }

    // la CALIDAD, sobre una secuencia realista (formas en movimiento con
    // grano): cada preset contra la referencia sin pérdida de las mismas
    // fuentes. Tienen que escalonarse, y High verse bien
    const busyRef = join(dir, 'busy.mov');
    const db: Record<string, number> = {};
    for (const q of ['best', 'high', 'compact']) {
      const f = join(dir, `busy_${q}.mp4`);
      db[q] = existsSync(f) && existsSync(busyRef) ? mean(psnr(f, busyRef)) : 0;
    }
    // los colores: la media de cada canal del MP4 tiene que ser la del
    // original. Un rango o una matriz mal declarados (Safari declaraba rango
    // completo sobre datos de rango limitado) lo desplazan todo decenas de
    // niveles; la compresión, no
    if (existsSync(busyRef) && existsSync(join(dir, 'busy_best.mp4'))) {
      const a = raw(join(dir, 'busy_best.mp4'), 'rgb24');
      const b = raw(busyRef, 'rgb24');
      const n = Math.min(a.length, b.length);
      const d = [0, 0, 0];
      for (let i = 0; i < n; i++) d[i % 3] += a[i] - b[i];
      const shift = d.map((v) => v / (n / 3));
      check(
        'mp4_colours_true',
        shift.every((v) => Math.abs(v) <= 3),
        `MP4 colours vs lossless: mean shift R ${shift[0].toFixed(1)} G ${shift[1].toFixed(1)} B ${shift[2].toFixed(1)} (want each within ±3)`,
      );
    }
    check(
      'mp4_presets_quality',
      db.best > db.high && db.high > db.compact && db.high >= 30,
      `MP4 presets vs lossless: Best ${db.best.toFixed(1)} dB > High ${db.high.toFixed(1)} dB > Compact ${db.compact.toFixed(1)} dB (want that order, High ≥ 30 dB)`,
    );

    // los recortes de 16 bits del escaneo, al tamaño que admite el codificador
    const ov = probe(odd).find((s) => s.codec_type === 'video');
    const ow = facts.oddW ?? 0;
    const oh = facts.oddH ?? 0;
    check(
      'mp4_scan_crops_size',
      ov?.width === Math.ceil(ow / 4) * 4 && ov.height === oh + (oh & 1),
      `MP4 of ${ow}×${oh} crops: ${ov?.width}×${ov?.height} (want ${Math.ceil(ow / 4) * 4}×${oh + (oh & 1)})`,
    );

    // un tamaño que obliga a rellenar (ancho 4k + 2, alto impar): el MP4 lo
    // lleva a múltiplo de 4 por par sin remuestrear, lo que falta en blanco,
    // y el dibujo en su sitio. En Chrome un ancho 4k + 2 corría la imagen un
    // píxel: las rayas de 2 px de la fuente lo delatan
    {
      const sw = facts.edgeW;
      const sh = facts.edgeH;
      const ew = Math.ceil(sw / 4) * 4;
      const eh = sh + (sh & 1);
      const ev = probe(edge).find((s) => s.codec_type === 'video');
      check(
        'mp4_padded_size',
        ev?.width === ew && ev.height === eh,
        `MP4 of ${sw}×${sh}: ${ev?.width}×${ev?.height} (want ${ew}×${eh})`,
      );
      // en luminancia: el color del borde añadido lo puede compartir (4:2:0)
      // con su vecino del dibujo, el brillo no
      const got = raw(edge, 'gray').subarray(0, ew * eh);
      const src = raw(edgeSrc, 'gray');
      const pad: number[] = [];
      for (let y = 0; y < eh; y++)
        for (let x = 0; x < ew; x++) if (x >= sw || y >= sh) pad.push(got[y * ew + x]);
      const m = mean(pad);
      check(
        'mp4_padding_white',
        m >= 220,
        `MP4 white edge: luma ${m.toFixed(0)} of 255 (want white, ≥ 220)`,
      );
      // el dibujo contra su fuente, en su sitio y corrido un píxel: en su
      // sitio tiene que parecerse mucho más
      const region = (shift: number): number => {
        const a: number[] = [];
        const b: number[] = [];
        for (let y = 0; y < sh; y++)
          for (let x = 1; x < sw - 1; x++) {
            a.push(got[y * ew + x]);
            b.push(src[y * sw + x - shift]);
          }
        return psnrY(Buffer.from(a), Buffer.from(b));
      };
      const aligned = region(0);
      const shifted = region(1);
      check(
        'mp4_not_shifted',
        aligned >= 30 && aligned > shifted + 6,
        `MP4 drawing in place: ${aligned.toFixed(1)} dB aligned, ${shifted.toFixed(1)} dB one pixel over (want ≥ 30 and well above)`,
      );
    }

    // el bitrate fijo, medido sobre el archivo
    const secs = facts.fixedSeconds ?? 3;
    const { size } = await stat(fixed);
    const mbps = (size * 8) / secs / 1e6;
    check(
      'mp4_fixed_bitrate',
      mbps >= facts.fixedMbps * 0.6 && mbps <= facts.fixedMbps * 1.4,
      `MP4 at a fixed ${facts.fixedMbps} Mbps: ${mbps.toFixed(2)} Mbps over ${secs} s (want ±40 %)`,
    );
  } catch (e) {
    check('compressed_decodes', false, `ffmpeg could not check the MP4: ${String(e)}`);
  }
  return { ok: Object.values(checks).every(Boolean), checks, outputs: {}, log };
}
