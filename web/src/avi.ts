// Decodificador de respaldo (ffmpeg.wasm) para lo que WebCodecs no cubre:
// contenedores que mediabunny no abre (AVI, MPG/MPEG, WMV, FLV, 3GP) y códecs
// que el navegador no decodifica (MOV de cámara: HEVC 10 bits, ProRes,
// DNxHD…). Se carga bajo demanda (unos 32 MB) y se descarga de la memoria al
// terminar la extracción.

import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import type { LogEvent } from '@ffmpeg/ffmpeg';
import { BadRangeError } from './errors.ts';
import type { ExtractOptions, ExtractResult, ProbeResult } from './video.ts';
import { context2d } from './ui.ts';

// video.ts monta sus PNG por WORKERFS con la misma instancia: el enum sale de
// aquí para que el módulo de ffmpeg siga cargándose bajo demanda.
export { FFFSType };

let ffPromise: Promise<FFmpeg> | null = null;

// Un asset que falta NO responde 404: wrangler.jsonc trae
// not_found_handling: "single-page-application", así que el servidor
// devuelve index.html con 200. Mirar solo r.ok no puede detectarlo jamás y el
// fallo salía como "Unexpected token '<'" de JSON.parse, o como un módulo que
// no instancia. Se comprueba también el content-type y se nombra la causa.
function coreMissing(res: Response, what: string): Error {
  return new Error(
    `The video converter module is missing on the server: /ffmpeg/${what} came back as `
    + `${res.headers.get('content-type') || 'an unknown type'} (HTTP ${res.status}). `
    + 'Generate web/public/ffmpeg/ with "npm run build" or "npm run test:e2e"; "npm run dev" does not.');
}

// El .wasm de 32 MB se rearma en un Blob cuya URL se guarda para TODA la
// página: release() termina la instancia en cuanto se vacía la cola, de modo
// que loadCore() vuelve a correr en cada sesión y antes dejaba abandonado un
// Blob de 32 MB por sesión. Revocarla tras el load tampoco valdría, porque la
// sesión siguiente necesita rearmar el mismo módulo: se crea una vez y se
// reutiliza (y de paso las sesiones posteriores arrancan sin volver a bajarlo).
let wasmURLPromise: Promise<string> | null = null;

function coreWasmURL(base: string): Promise<string> {
  // un fallo no se cachea: si el módulo aparece luego, el siguiente intento
  // vuelve a probar en vez de quedarse con la promesa rechazada
  if (!wasmURLPromise) wasmURLPromise = assembleCore(base).catch((e: unknown) => { wasmURLPromise = null; throw e; });
  return wasmURLPromise;
}

interface CoreManifest {
  parts?: number;
  bytes?: number;
}

async function assembleCore(base: string): Promise<string> {
  const res = await fetch(`${base}/manifest.json`);
  if (!res.ok || !/\bjson\b/i.test(res.headers.get('content-type') || '')) throw coreMissing(res, 'manifest.json');
  const manifest = (await res.json()) as CoreManifest;
  const nParts = manifest.parts ?? 0;
  if (!(nParts > 0)) throw new Error('The video converter manifest lists no parts; rebuild web/public/ffmpeg/ with "npm run build".');
  const parts = await Promise.all(
    Array.from({ length: nParts }, (_, i) =>
      fetch(`${base}/ffmpeg-core.wasm.${i}`).then((r) => {
        // el mismo fallback SPA: una parte que falte llegaría como HTML y el
        // módulo moriría al instanciar sin decir por qué
        if (!r.ok || /text\/html/i.test(r.headers.get('content-type') || '')) throw coreMissing(r, `ffmpeg-core.wasm.${i}`);
        return r.arrayBuffer();
      })),
  );
  return URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }));
}

async function loadCore(): Promise<FFmpeg> {
  const base = `${location.origin}/ffmpeg`;
  const wasmURL = await coreWasmURL(base);
  const ff = new FFmpeg();
  await ff.load({ coreURL: `${base}/ffmpeg-core.js`, wasmURL });
  return ff;
}

function getFF(): Promise<FFmpeg> {
  if (!ffPromise) ffPromise = loadCore();
  return ffPromise;
}

/** Cierra la instancia y libera su memoria WASM. */
async function release(): Promise<void> {
  const p = ffPromise;
  ffPromise = null;
  try { (await p)?.terminate(); } catch { /* ya cerrada */ }
}

// La instancia es ÚNICA y se comparte entre la extracción y la exportación
// MOV (video.ts). Dos sesiones a la vez se pisarían: terminate() de una
// rechaza los exec de la otra, los callbacks de progreso son globales por
// instancia y el FS es un solo espacio de nombres. withFF serializa cada
// sesión (montar → exec → leer) y libera la instancia cuando no queda
// ninguna en cola.
let ffQueue: Promise<unknown> = Promise.resolve();
let ffPending = 0;

export function withFF<T>(fn: (ff: FFmpeg) => Promise<T>): Promise<T> {
  ffPending++;
  const run = ffQueue.then(async () => {
    try {
      return await fn(await getFF());
    } finally {
      if (--ffPending === 0) await release();
    }
  });
  ffQueue = run.catch(() => {});
  return run;
}

// El archivo de entrada se monta como WORKERFS: ffmpeg lee del Blob bajo
// demanda, sin copiarlo a la memoria WASM (los clips de cámara pesan
// gigabytes y writeFile los copiaría enteros).
const MOUNT = '/input';

async function mountInput(ff: FFmpeg, file: File): Promise<string> {
  await ff.createDir(MOUNT);
  await ff.mount(FFFSType.WORKERFS, { blobs: [{ name: 'in', data: file }] }, MOUNT);
  return `${MOUNT}/in`;
}

async function unmountInput(ff: FFmpeg): Promise<void> {
  try { await ff.unmount(MOUNT); } catch { /* sin montar */ }
  try { await ff.deleteDir(MOUNT); } catch { /* ya no está */ }
}

/** Lo que se saca del log de ffmpeg: ProbeResult sin la marca `fallback`,
 *  que la pone probeFallback al devolverlo. */
type ProbeInfo = Omit<ProbeResult, 'fallback'>;

function parseProbeLog(log: string): ProbeInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(log);
  const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;
  const dims = /,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(log);
  const f = /(\d+(?:\.\d+)?)\s*fps/.exec(log);
  return {
    duration,
    width: dims ? +dims[1] : 0,
    height: dims ? +dims[2] : 0,
    fps: f ? parseFloat(f[1]) : 0,
  };
}

async function probeLoaded(ff: FFmpeg, path: string): Promise<ProbeInfo> {
  let log = '';
  const onLog = ({ message }: LogEvent): void => { log += `${message}\n`; };
  ff.on('log', onLog);
  try {
    await ff.exec(['-hide_banner', '-i', path, '-frames:v', '0', '-f', 'null', 'out']);
  } catch { /* ffmpeg sale con error al no producir salida; el log ya está */ }
  ff.off('log', onLog);
  const p = parseProbeLog(log);
  if (!p.duration || !p.width) {
    throw new Error('The file could not be decoded (unsupported or damaged video).');
  }
  return p;
}

/** Sondeo: duración, dimensiones y fps. Mismo formato que probeVideo. */
export function probeFallback(file: File): Promise<ProbeResult> {
  return withFF(async (ff) => {
    const path = await mountInput(ff, file);
    try {
      return { ...(await probeLoaded(ff, path)), fallback: true };
    } finally {
      await unmountInput(ff);
    }
  });
}

/**
 * Extrae fotogramas como PNG por tandas (la memoria WASM solo retiene una
 * tanda a la vez). Misma interfaz que extractFrames de video.ts.
 */
export function extractFramesFallback(file: File, opts: ExtractOptions = {}): Promise<ExtractResult> {
  return withFF(async (ff) => {
  const path = await mountInput(ff, file);
  try {
    const probe = await probeLoaded(ff, path);
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.min(probe.duration, opts.end ?? probe.duration);
    // duplica a propósito el assertRange de extractFrames (video.ts): la
    // duración solo se conoce aquí, y sin esto un rango vacío o invertido
    // salía del bucle con count 0 y la interfaz lo daba por bueno en verde
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
      const n = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)} s` : 'not a number');
      // extractFrames lo relanza en vez del error del contenedor
      throw new BadRangeError(`Invalid time range: start (${n(start)}) must come before end (${n(end)}).`
        + ` This video lasts ${probe.duration.toFixed(2)} s.`);
    }
    const fps = opts.fps || probe.fps || 12;
    const dt = 1 / fps;
    const est = Math.max(1, Math.round((end - start) * fps));
    // los PNG de cada tanda viven en la memoria WASM: tandas cortas en 4K/6K
    const BATCH = Math.max(4, Math.min(24, Math.floor(500e6 / Math.max(1, probe.width * probe.height * 4))));
    let count = 0;
    let t = start;
    while (t < end - 1e-9) {
      if (opts.cancelled?.()) break;
      const want = Math.min(BATCH, Math.max(1, Math.round((end - t) * fps)));
      await ff.exec([
        '-hide_banner', '-loglevel', 'error',
        '-ss', t.toFixed(4), '-i', path,
        '-vf', `fps=${fps}`, '-frames:v', String(want),
        // rgb24: el resto del pipeline es de 8 bits; PNG de 16 bits solo
        // duplicaría la memoria (fuentes de 10 bits incluidas)
        '-pix_fmt', 'rgb24',
        '-f', 'image2', 'f_%03d.png',
      ]);
      let got = 0;
      for (let i = 1; i <= want; i++) {
        const name = `f_${String(i).padStart(3, '0')}.png`;
        let data: Uint8Array | string;
        try { data = await ff.readFile(name); } catch { break; }
        await ff.deleteFile(name);
        if (typeof data === 'string') throw new Error('The video decoder returned text instead of image bytes.');
        got++;
        // readFile copia el PNG fuera de la memoria WASM: ArrayBuffer propio
        const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/png' });
        const bmp = await createImageBitmap(blob);
        const tw = 256;
        const th = Math.max(1, Math.round((bmp.height / bmp.width) * tw));
        const thumb = new OffscreenCanvas(tw, th);
        context2d(thumb).drawImage(bmp, 0, 0, tw, th);
        const { width: w, height: h } = bmp;
        bmp.close();
        await opts.onFrame?.(blob, thumb, t + (i - 1) * dt, count, w, h);
        count++;
        opts.onProgress?.(count, est);
        if (opts.cancelled?.()) break;
      }
      if (!got) break; // fin del archivo antes de lo estimado
      t += got * dt;
    }
    return { count, fps, duration: probe.duration, origen: file.name };
  } finally {
    // withFF libera la instancia (~350 MB) al no quedar sesiones en cola
    await unmountInput(ff);
  }
  });
}
