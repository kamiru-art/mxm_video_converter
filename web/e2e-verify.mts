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
import { mkdir, readdir, rm } from 'node:fs/promises';
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
