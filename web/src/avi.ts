// Decodificador de respaldo (ffmpeg.wasm) para lo que WebCodecs no cubre:
// contenedores que mediabunny no abre (AVI, MPG/MPEG, WMV, FLV, 3GP) y códecs
// que el navegador no decodifica (MOV de cámara: HEVC 10 bits, ProRes,
// DNxHD…). Se carga bajo demanda (unos 32 MB) y se descarga de la memoria al
// terminar la extracción.

import type { LogEvent } from '@ffmpeg/ffmpeg';
import { FFFSType, FFmpeg } from '@ffmpeg/ffmpeg';
import type { DeepFrame, DeepSpec } from './commands.ts';
import { isMobile } from './device.ts';
import { BadRangeError } from './errors.ts';
import { FrameQueue } from './frames.ts';
import { loadFlag, saveFlag } from './store.ts';
import type { Bytes } from './types.ts';
import type { ExtractOptions, ExtractResult, ProbeResult } from './video.ts';
import { FFMPEG_PHONE_THREADS, ffmpegBatchFrames } from './video.ts';

// video.ts monta sus PNG por WORKERFS con la misma instancia: el enum sale de
// aquí para que el módulo de ffmpeg siga cargándose bajo demanda.
export { FFFSType };

let ffPromise: Promise<FFmpeg> | null = null;

/** ffmpeg con hilos (@ffmpeg/core-mt) cuando el navegador aísla el origen
 *  (cabeceras COOP/COEP, ver public/_headers): decodificar HEVC 4K por
 *  software en un hilo son minutos; con los núcleos de la máquina, bastante
 *  menos. Sin aislamiento no hay SharedArrayBuffer y se usa el núcleo de un
 *  hilo de siempre. Si el multihilo falla al cargar, también. */
function multiThreadAvailable(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated
  );
}
let mtFailed = false;

/** 'multi' o 'single': lo que usará (o usa) la próxima sesión. */
export function ffmpegThreads(): 'multi' | 'single' {
  return multiThreadAvailable() && !mtFailed ? 'multi' : 'single';
}

/** Hilos que se piden a ffmpeg con el núcleo multihilo: los de la máquina,
 *  con un tope; más no ayuda a un decodificador. En un teléfono, dos: cada
 *  hilo guarda sus propios fotogramas en la memoria de ffmpeg (ver
 *  FFMPEG_PHONE_THREADS en video.ts). */
function threadCount(): number {
  if (isMobile()) return FFMPEG_PHONE_THREADS;
  return Math.max(2, Math.min(8, navigator.hardwareConcurrency || 2));
}

/** El argumento `-threads` de cada exec: explícito con el núcleo multihilo
 *  (el mismo número que superó la prueba), nada con el de un hilo. */
export function threadArgs(): string[] {
  return ffmpegThreads() === 'multi' ? ['-threads', String(threadCount())] : [];
}

/** Tiempo máximo para la prueba: 6 fotogramas de 16×16 son milisegundos;
 *  si no ha vuelto en esto, está atascado. */
const PROBE_MS = 8000;

/** Un MP4 H.264 de 6 fotogramas de 64×64 (testsrc), para probar el
 *  decodificador con hilos sin depender de ningún codificador. H.264 y no
 *  MPEG-4: el decodificador MPEG-4 de ffmpeg 5.1 con hilos falla en un
 *  fotograma diminuto ("scratch buffers could not be allocated"), y eso
 *  descartaba el multihilo en Firefox, donde sí funciona. */
const PROBE_MP4_B64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAM7bW9vdgAAAGxtdmhkAAAAAAAAAAAA' +
  'AAAAAAAD6AAAAlgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA' +
  'AABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAmV0cmFrAAAAXHRraGQAAAADAAAA' +
  'AAAAAAAAAAABAAAAAAAAAlgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA' +
  'AAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAJYAAAAAAABAAAA' +
  'AAHdbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAGABVxAAAAAAALWhkbHIAAAAAAAAAAHZp' +
  'ZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABiG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAA' +
  'ACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAUhzdGJsAAAAuHN0c2QAAAAAAAAA' +
  'AQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2' +
  'Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwAraEJsBEAAA' +
  'AwAQAAADAUDxImoBAAVozgJcgAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAK4CAAAAAAAA' +
  'ABhzdHRzAAAAAAAAAAEAAAAGAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAA' +
  'AQAAAAEAAAAGAAAAAQAAACxzdHN6AAAAAAAAAAAAAAAGAAAFJAAAAvsAAAF6AAABMgAAAToAAAEI' +
  'AAAAFHN0Y28AAAAAAAAAAQAAA2sAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABt' +
  'ZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEy' +
  'LjEwMgAAAAhmcmVlAAANFW1kYXQAAAJUBgX//1DcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUg' +
  'MTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAw' +
  'My0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2Fi' +
  'YWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGFuYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBzeT0x' +
  'IHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJl' +
  'bGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFf' +
  'cXBfb2Zmc2V0PTAgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9' +
  'MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5l' +
  'ZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEwIHNj' +
  'ZW5lY3V0PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MzUuMCBxY29tcD0w' +
  'LjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAALIZYiE' +
  'OgxgAeiIGdEONgsbfvXv4Au6Q3MeuADytes1YKT+ugBaqY3MevDiASkQAA+AxgTG8Njj+GgBHkUw' +
  '1ZghAkUgkZgDGAEBBWUxgBADzdqKX8ACv2adUEEogJhpYf/hoBgAgEACAAIA4goUlmANXwIBtpxZ' +
  'q/2UXUC++NNDhjAdAbSlAEAAEBZ+BwTjyw4Jx5fnCZMm5/8JABBQABADCAFgNpATGlgG+UxBtnn7' +
  '9ANzFMICbPPhjAEJewlsU1+I0IGVHwAyNFQS+/1/+ARMcRvgfAYlqMtkyMOg5XjPXCE/rrwwIpyC' +
  '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';

function probeClip(): Uint8Array {
  const bin = atob(PROBE_MP4_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ¿Funciona de verdad el multihilo aquí? Chrome carga el núcleo y corre
 *  `-version`, pero se queda colgado para siempre en cuanto un
 *  decodificador usa más de dos hilos o un codificador usa dos (medido
 *  el 2026-09-06, con y sin ventana); Firefox corre con diez sin problema.
 *  Ninguna lista de navegadores sería fiable, así que se prueba: el clip
 *  diminuto se decodifica con los hilos que se van a usar, con tiempo
 *  límite, y la salida se lee de verdad (un exec que aborta al instante
 *  "termina" sin producir nada). Si no vuelve o no produce, el núcleo de un
 *  hilo de siempre. */
async function probeThreads(ff: FFmpeg): Promise<boolean> {
  let log = '';
  const onLog = ({ message }: LogEvent): void => {
    log += `${message}\n`;
  };
  ff.on('log', onLog);
  const work = (async () => {
    await ff.writeFile('probe.mp4', probeClip());
    await ff.exec([
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      String(threadCount()),
      '-i',
      'probe.mp4',
      '-c:v',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-f',
      'image2',
      'p_%03d.raw',
    ]);
    // con que salga el primero y tenga el tamaño justo basta: lo que se
    // vigila es que el decodificador con hilos vuelva y produzca
    const first = await ff.readFile('p_001.raw');
    if (typeof first === 'string' || first.length !== 64 * 64 * 4)
      throw new Error('no decoded output');
  })();
  work.catch(() => {}); // si se termina la instancia, esta promesa rechaza después
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error('stalled')), PROBE_MS);
  });
  try {
    await Promise.race([work, timeout]);
    return true;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(
      `[ffmpeg] thread probe: ${why}${log.trim() ? ` · ${log.trim().slice(-300)}` : ''}`,
    );
    return false;
  } finally {
    clearTimeout(timer);
    ff.off('log', onLog);
  }
}

// Un asset que falta NO responde 404: wrangler.jsonc trae
// not_found_handling: "single-page-application", así que el servidor
// devuelve index.html con 200. Mirar solo r.ok no puede detectarlo jamás y el
// fallo salía como "Unexpected token '<'" de JSON.parse, o como un módulo que
// no instancia. Se comprueba también el content-type y se nombra la causa.
function coreMissing(res: Response, what: string): Error {
  return new Error(
    `The video converter module is missing on the server: /ffmpeg/${what} came back as ` +
      `${res.headers.get('content-type') || 'an unknown type'} (HTTP ${res.status}). ` +
      'Generate web/public/ffmpeg/ with "npm run build" or "npm run test:e2e"; "npm run dev" does not.',
  );
}

// El .wasm de 32 MB se rearma en un Blob cuya URL se guarda para TODA la
// página: release() termina la instancia en cuanto se vacía la cola, de modo
// que loadCore() vuelve a correr en cada sesión y antes dejaba abandonado un
// Blob de 32 MB por sesión. Revocarla tras el load tampoco valdría, porque la
// sesión siguiente necesita rearmar el mismo módulo: se crea una vez y se
// reutiliza (y de paso las sesiones posteriores arrancan sin volver a bajarlo).
const wasmURLPromises = new Map<string, Promise<string>>();

function coreWasmURL(base: string, manifest: CoreManifest): Promise<string> {
  // un fallo no se cachea: si el módulo aparece luego, el siguiente intento
  // vuelve a probar en vez de quedarse con la promesa rechazada
  let p = wasmURLPromises.get(base);
  if (!p) {
    p = assembleCore(base, manifest).catch((e: unknown) => {
      wasmURLPromises.delete(base);
      throw e;
    });
    wasmURLPromises.set(base, p);
  }
  return p;
}

interface CoreManifest {
  parts?: number;
  bytes?: number;
  /** Directorio con hash donde están las piezas (`/ffmpeg/st-<hash>`). */
  path?: string;
}

/** El manifiesto de un núcleo: cuántas partes y en qué directorio. */
async function coreManifest(variant: 'mt' | 'st'): Promise<CoreManifest> {
  const res = await fetch(`${location.origin}/ffmpeg/${variant}/manifest.json`);
  if (!res.ok || !/\bjson\b/i.test(res.headers.get('content-type') || ''))
    throw coreMissing(res, `${variant}/manifest.json`);
  return (await res.json()) as CoreManifest;
}

async function assembleCore(base: string, manifest: CoreManifest): Promise<string> {
  const nParts = manifest.parts ?? 0;
  if (!(nParts > 0))
    throw new Error(
      'The video converter manifest lists no parts; rebuild web/public/ffmpeg/ with "npm run build".',
    );
  const parts = await Promise.all(
    Array.from({ length: nParts }, (_, i) =>
      fetch(`${base}/ffmpeg-core.wasm.${i}`).then((r) => {
        // el mismo fallback SPA: una parte que falte llegaría como HTML y el
        // módulo moriría al instanciar sin decir por qué
        if (!r.ok || /text\/html/i.test(r.headers.get('content-type') || ''))
          throw coreMissing(r, `ffmpeg-core.wasm.${i}`);
        return r.arrayBuffer();
      }),
    ),
  );
  return URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }));
}

async function loadVariant(variant: 'mt' | 'st'): Promise<FFmpeg> {
  const manifest = await coreManifest(variant);
  const base = `${location.origin}${manifest.path ?? `/ffmpeg/${variant}`}`;
  const wasmURL = await coreWasmURL(base, manifest);
  const ff = new FFmpeg();
  await ff.load({
    coreURL: `${base}/ffmpeg-core.js`,
    wasmURL,
    ...(variant === 'mt' ? { workerURL: `${base}/ffmpeg-core.worker.js` } : {}),
  });
  return ff;
}

let mtProbe: Promise<boolean> | null = null;

/** La prueba vale para este navegador y este núcleo: se recuerda entre
 *  sesiones, que en Chrome son 8 s de espera y 32 MB de descarga cada vez
 *  para acabar en el núcleo de un hilo. Cambiar de versión del núcleo o de
 *  navegador la repite. */
const MT_CORE_ID = 'core-mt-0.12.10';
function probeFlagName(): string {
  return `ffmpeg-mt:${MT_CORE_ID}:${navigator.userAgent}`;
}

/** Con tiempo límite: una promesa que no vuelve (un pool de hilos que nunca
 *  arranca) dejaría colgada toda sesión de ffmpeg, y Stop no podría salir. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} took more than ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** La prueba corre en una instancia DESECHABLE: la que la pasa se termina
 *  y la sesión real carga otra limpia. Reutilizar la de la prueba dejaba
 *  el módulo roto (el siguiente exec abortaba sin decir nada). Una vez por
 *  página. */
function multiThreadWorks(): Promise<boolean> {
  if (!mtProbe) {
    mtProbe = (async () => {
      const remembered = loadFlag(probeFlagName());
      if (remembered === 'ok' || remembered === 'stall') return remembered === 'ok';
      let ff: FFmpeg | null = null;
      try {
        ff = await withTimeout(loadVariant('mt'), PROBE_MS * 3, 'loading the multithreaded core');
        const ok = await probeThreads(ff);
        if (!ok) {
          console.warn(
            '[ffmpeg] the multithreaded core stalls or fails in this browser; using the single-threaded one',
          );
        }
        saveFlag(probeFlagName(), ok ? 'ok' : 'stall');
        return ok;
      } catch (e) {
        // un worker bloqueado, un módulo que falta…: el de un hilo sigue valiendo
        console.warn(
          '[ffmpeg] multithreaded core failed to load, using the single-threaded one:',
          e,
        );
        return false;
      } finally {
        try {
          ff?.terminate();
        } catch {
          /* ya terminada */
        }
      }
    })();
  }
  return mtProbe;
}

/** Tope para traer el núcleo (32 MB en trozos) e instanciarlo. Generoso: en
 *  una conexión lenta son minutos de descarga legítima. Pero con tope: un
 *  `fetch` que no vuelve —una red que se cae a media descarga, un trozo que
 *  el service worker sirve a medias— dejaba la exportación esperando para
 *  siempre con la barra quieta, sin error y sin nada que hacer salvo
 *  recargar. */
const CORE_LOAD_MS = 300e3;

async function loadCore(): Promise<FFmpeg> {
  if (ffmpegThreads() === 'multi' && (await multiThreadWorks())) {
    try {
      const ff = await withTimeout(
        loadVariant('mt'),
        CORE_LOAD_MS,
        'loading the multithreaded video converter',
      );
      console.info(`[ffmpeg] multithreaded core, ${threadCount()} threads`);
      return ff;
    } catch (e) {
      console.warn(
        '[ffmpeg] the multithreaded core did not load, using the single-threaded one:',
        e,
      );
    }
  }
  mtFailed = true;
  const ff = await withTimeout(loadVariant('st'), CORE_LOAD_MS, 'loading the video converter');
  console.info('[ffmpeg] single-threaded core');
  return ff;
}

function getFF(): Promise<FFmpeg> {
  // una carga fallida NO se queda cacheada: la siguiente exportación vuelve
  // a intentarlo, que con una red intermitente es lo único que hace falta
  if (!ffPromise) {
    ffPromise = loadCore().catch((e: unknown) => {
      ffPromise = null;
      throw e;
    });
  }
  return ffPromise;
}

/** Cierra la instancia y libera su memoria WASM. */
async function release(): Promise<void> {
  const p = ffPromise;
  ffPromise = null;
  try {
    (await p)?.terminate();
  } catch {
    /* ya cerrada */
  }
}

/** Parar lo que ffmpeg esté haciendo AHORA: terminar la instancia es la
 *  única forma, porque `exec` bloquea su worker y no se interrumpe. La
 *  llamada en curso se rechaza, y quien la esperaba lo reconoce por su
 *  AbortSignal; la siguiente sesión arranca otra instancia limpia. Lo usan
 *  la extracción (aquí abajo) y las exportaciones MOV (video.ts). */
export function abortFF(): Promise<void> {
  return release();
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

/**
 * Un `exec` que no puede quedarse colgado para siempre. ffmpeg corre dentro
 * de un worker y en WebAssembly: si el módulo se atasca —el núcleo
 * multihilo lo hace con según qué códec y navegador, ver la prueba de
 * arriba—, `exec` no vuelve NUNCA. No hay error, no hay nada: la barra de
 * progreso se queda quieta y la exportación parece eterna, que es
 * exactamente lo que no puede pasar.
 *
 * Aquí se vigila que ffmpeg dé señales de vida (progreso o líneas de log) y,
 * si calla más de `stallMs`, se termina la instancia y se lanza un error que
 * la interfaz puede contar. Cancelar sigue funcionando igual: quien llama
 * termina la instancia por su cuenta y el `exec` rechaza.
 */
export function execWatched(
  ff: FFmpeg,
  args: string[],
  stallMs: number,
  what: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const alive = (): void => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(stalled, stallMs);
    };
    const onLog = (): void => alive();
    const onProgress = (): void => alive();
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ff.off('log', onLog);
      ff.off('progress', onProgress);
      fn();
    };
    function stalled(): void {
      finish(() => {
        // la instancia atascada no se recupera: terminarla libera su memoria
        // y hace rechazar al exec que nunca iba a volver
        void abortFF();
        reject(
          new Error(
            `${what} stopped responding: ${(stallMs / 1000).toFixed(0)} s without a sign of life from the in-browser converter. Try again, and if it happens every time, use a lower resolution or split the range.`,
          ),
        );
      });
    }
    ff.on('log', onLog);
    ff.on('progress', onProgress);
    alive();
    ff.exec(args).then(
      () => finish(resolve),
      (e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
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
  try {
    await ff.unmount(MOUNT);
  } catch {
    /* sin montar */
  }
  try {
    await ff.deleteDir(MOUNT);
  } catch {
    /* ya no está */
  }
}

/** Lo que se saca del log de ffmpeg: ProbeResult sin la marca `fallback`,
 *  que la pone probeFallback al devolverlo. */
type ProbeInfo = Omit<ProbeResult, 'fallback' | 'deepNeedsFallback'> & {
  pix: PixInfo | null;
  rotation: number;
};

/** El `pix_fmt` de la pista de video según el log de ffmpeg, con su
 *  profundidad (`yuv420p10le` → 10, el `yuv422p10le` del ProRes → 10,
 *  `rgb48le` → 16, `yuv420p` → 8), su rango y su matriz, que van entre
 *  paréntesis: `yuv420p10le(tv, bt709)`, `yuv420p10le(pc, bt709/bt709/arib-std-b67)`. */
interface PixInfo {
  fmt: string;
  depth: number;
  full: boolean;
  /** El log dice el rango (pc o tv). */
  rangeKnown: boolean;
  matrix: 'bt601' | 'bt709' | 'bt2020' | null;
}

function pixInfo(log: string): PixInfo | null {
  const line = /Stream #[^\n]*?Video: ([^\n]*)/.exec(log)?.[1];
  if (!line) return null;
  const re = /(?:^|, )([a-z][a-z0-9_]*)(?:\(([^)]*)\))?(?=,|$)/g;
  for (const m of line.matchAll(re)) {
    const fmt = m[1];
    if (!/^(yuva?|yuvj|gbra?p|gray|ya|rgba?|bgra?|nv\d|p0|p2|xyz)/.test(fmt)) continue;
    const bits = /(\d{2})(?:le|be)$/.exec(fmt);
    const depth = bits ? Math.min(16, +bits[1]) : 8; // rgb48, rgba64: 16 por canal
    const tags = (m[2] ?? '').split(/,\s*/);
    const csp = tags.find((t) => /^(bt|smpte|fcc)/.test(t))?.split('/')[0] ?? '';
    const matrix =
      csp === 'bt709'
        ? 'bt709'
        : csp === 'bt470bg' || csp === 'smpte170m'
          ? 'bt601'
          : csp.startsWith('bt2020')
            ? 'bt2020'
            : null;
    const full = tags.includes('pc') || fmt.startsWith('yuvj');
    return { fmt, depth, full, rangeKnown: full || tags.includes('tv'), matrix };
  }
  return null;
}

/** El formato de WebCodecs de los planos YUV de 10 o 12 bits que ffmpeg puede
 *  sacar tal cual, para que los convierta el núcleo como los de WebCodecs. */
function planarFormat(fmt: string): { format: string; sx: number; sy: number } | null {
  const m = /^yuva?(420|422|444)p(10|12)le$/.exec(fmt);
  if (!m) return null;
  const [sx, sy] = m[1] === '420' ? [2, 2] : m[1] === '422' ? [2, 1] : [1, 1];
  return { format: `I${m[1]}P${m[2]}`, sx, sy };
}

function parseProbeLog(log: string): ProbeInfo {
  const d = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(log);
  const duration = d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0;
  const dims = /,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(log);
  const f = /(\d+(?:\.\d+)?)\s*fps/.exec(log);
  return {
    duration,
    width: dims ? +dims[1] : 0,
    height: dims ? +dims[2] : 0,
    fps: f ? parseFloat(f[1]) : 0,
    depth: pixInfo(log)?.depth ?? null,
    pix: pixInfo(log),
    rotation: displayRotation(log),
  };
}

/** Giro de los metadatos, en grados en el sentido de las agujas del reloj.
 *  ffmpeg da el ángulo en sentido contrario ("Display Matrix: rotation of
 *  90.00 degrees" es un móvil girado 90° a la izquierda). */
function displayRotation(log: string): number {
  const m = /display ?matrix: rotation of (-?[\d.]+) degrees/i.exec(log);
  if (!m) return 0;
  return (((Math.round(-Number(m[1]) / 90) * 90) % 360) + 360) % 360;
}

async function probeLoaded(ff: FFmpeg, path: string): Promise<ProbeInfo> {
  let log = '';
  const onLog = ({ message }: LogEvent): void => {
    log += `${message}\n`;
  };
  ff.on('log', onLog);
  try {
    await ff.exec(['-hide_banner', '-i', path, '-frames:v', '0', '-f', 'null', 'out']);
  } catch {
    /* ffmpeg sale con error al no producir salida; el log ya está */
  }
  ff.off('log', onLog);
  const p = parseProbeLog(log);
  if (!p.duration || !p.width) {
    // lo que dijo ffmpeg, que es lo único que explica un archivo que no abre
    const tail = log.trim().split('\n').filter(Boolean).slice(-3).join(' · ');
    console.warn('[ffmpeg] probe log:', log.trim().slice(-2000));
    throw new Error(
      `The file could not be decoded (unsupported or damaged video).${tail ? ` ffmpeg: ${tail}` : ''}`,
    );
  }
  return p;
}

/** Sondeo: duración, dimensiones y fps. Mismo formato que probeVideo. */
export function probeFallback(file: File): Promise<ProbeResult> {
  return withFF(async (ff) => {
    const path = await mountInput(ff, file);
    try {
      const { pix: _pix, rotation: _rot, ...info } = await probeLoaded(ff, path);
      return { ...info, fallback: true };
    } finally {
      await unmountInput(ff);
    }
  });
}

/** Un fotograma crudo de ffmpeg como DeepFrame: sus planos YUV, o rgb48le. */
function deepFrame(
  data: Bytes,
  w: number,
  h: number,
  planar: ReturnType<typeof planarFormat>,
  pix: PixInfo | null,
  rotation: number,
): DeepFrame {
  if (!planar)
    return {
      data,
      spec: {
        ...{ format: 'RGB48LE', w, h, planes: [{ offset: 0, stride: w * 6 }] },
        ...{ matrix: 'bt709', fullRange: true, rotation: 0 }, // ya convertido
      },
    };
  const cw = Math.ceil(w / planar.sx);
  const ch = Math.ceil(h / planar.sy);
  return {
    data,
    spec: {
      format: planar.format,
      w,
      h,
      planes: [
        { offset: 0, stride: w * 2 },
        { offset: w * h * 2, stride: cw * 2 },
        { offset: w * h * 2 + cw * ch * 2, stride: cw * 2 },
      ],
      // sin etiqueta, la convención: BT.709 en HD, BT.601 por debajo
      matrix: pix?.matrix ?? (h > 576 ? 'bt709' : 'bt601'),
      fullRange: pix?.full ?? false,
      rotation, // sin -noautorotate lo enderezaría ffmpeg (ver la extracción)
    },
  };
}

/** Tamaño real de la salida, del log de ffmpeg. Hace falta porque ffmpeg
 *  endereza solo los clips con rotación en los metadatos (un móvil en
 *  vertical): el flujo dice 1920×1080 y los fotogramas salen de 1080×1920,
 *  y un fotograma crudo no lleva cabecera que lo diga. */
function parseOutputSize(message: string): [number, number] | null {
  const m = /Video: rawvideo[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(message);
  return m ? [+m[1], +m[2]] : null;
}

/**
 * Extrae fotogramas por tandas (la memoria de ffmpeg solo retiene una tanda
 * a la vez). ffmpeg entrega RGBA crudo y el PNG lo hacen los workers del
 * pool (frames.ts), como en el camino de WebCodecs: el codificador PNG de
 * ffmpeg.wasm tardaba ~600 ms por fotograma 4K, uno detrás de otro, y el
 * hilo principal volvía a decodificar cada PNG solo para sacar la miniatura.
 * Misma interfaz que extractFrames de video.ts.
 */
export function extractFramesFallback(
  file: File,
  opts: ExtractOptions = {},
  /** Matriz y rango según mediabunny, si abrió el contenedor: valen cuando
   *  el log de ffmpeg no los dice. */
  hint: { matrix: DeepSpec['matrix'] | null; fullRange: boolean | null } | null = null,
): Promise<ExtractResult> {
  return withFF(async (ff) => {
    // Parar = terminar la instancia: exec bloquea el worker de ffmpeg y no
    // hay otra forma de interrumpirlo. La llamada pendiente se rechaza, y el
    // bucle de abajo reconoce la parada por `signal.aborted`. release()
    // deja ffPromise a null, así que la siguiente sesión arranca otra.
    const onAbort = (): void => {
      void release();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const path = await mountInput(ff, file);
    try {
      const probe = await probeLoaded(ff, path);
      const start = Math.max(0, opts.start ?? 0);
      const end = Math.min(probe.duration, opts.end ?? probe.duration);
      // duplica a propósito el assertRange de extractFrames (video.ts): la
      // duración solo se conoce aquí, y sin esto un rango vacío o invertido
      // salía del bucle con count 0 y la interfaz lo daba por bueno en verde
      if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
        const n = (v: number): string =>
          Number.isFinite(v) ? `${v.toFixed(2)} s` : 'not a number';
        // extractFrames lo relanza en vez del error del contenedor
        throw new BadRangeError(
          `Invalid time range: start (${n(start)}) must come before end (${n(end)}).` +
            ` This video lasts ${probe.duration.toFixed(2)} s.`,
        );
      }
      const fps = opts.fps || probe.fps || 12;
      const dt = 1 / fps;
      const est = Math.max(1, Math.round((end - start) * fps));
      // más de 8 bits en la fuente (HEVC de 10 bits, ProRes): los planos
      // YUV tal cual, que convierte el núcleo con la matriz y el rango del
      // flujo, como los de WebCodecs (el rgb48le de swscale sale un 0,4 %
      // oscuro: el blanco de 10 bits, 940, le da 65283 y no 65535). Otros
      // formatos profundos (RGB, P010…): rgb48le. Si no, RGBA de 8 bits.
      const deep = !opts.fast8 && (probe.depth ?? 8) > 8;
      const planar = deep && probe.pix ? planarFormat(probe.pix.fmt) : null;
      const outFmt = !deep ? 'rgba' : planar ? probe.pix?.fmt.replace('yuva', 'yuv') : 'rgb48le';
      const bpp = deep ? 6 : 4;
      const pix: PixInfo | null = probe.pix && {
        ...probe.pix,
        matrix: probe.pix.matrix ?? hint?.matrix ?? null,
        full: probe.pix.rangeKnown ? probe.pix.full : !!hint?.fullRange,
      };
      if (planar)
        console.info(
          `[ffmpeg] ${file.name}: ${probe.pix?.fmt}, matrix ${pix?.matrix ?? 'untagged'} (ffmpeg says ${probe.pix?.matrix ?? 'nothing'}), ${pix?.full ? 'full' : 'limited'} range`,
        );
      const BATCH = ffmpegBatchFrames(probe.width, probe.height, bpp);
      // PNG siempre, aunque `opts.lazy` lo pida: volver a decodificar por
      // aquí cuesta minutos, así que el fotograma se guarda (phase1 lo
      // manda a la caché de disco)
      const queue = new FrameQueue(opts, est, true);
      let outSize: [number, number] | null = null;
      const onLog = ({ message }: LogEvent): void => {
        outSize ??= parseOutputSize(message);
      };
      ff.on('log', onLog);
      let cancelled = false;
      try {
        let t = start;
        while (t < end - 1e-9) {
          if (opts.signal?.aborted) {
            cancelled = true;
            break;
          }
          const want = Math.min(BATCH, Math.max(1, Math.round((end - t) * fps)));
          await ff.exec([
            '-hide_banner',
            ...threadArgs(),
            // info, no error: la línea "Output … rawvideo … WxH" es la que
            // dice el tamaño real de los fotogramas (ver parseOutputSize)
            '-loglevel',
            'info',
            '-nostats',
            // planos YUV: sin el giro de ffmpeg, que traspone la croma y con
            // ella su posición; el núcleo gira después de convertir
            ...(planar ? ['-noautorotate'] : []),
            '-ss',
            t.toFixed(4),
            '-i',
            path,
            // round=up: el fotograma en el instante o justo antes, como los
            // muestrea WebCodecs (video.ts); el redondeo por defecto tomaba
            // el último de cada intervalo, hasta medio intervalo después
            '-vf',
            `fps=${fps}:round=up`,
            '-frames:v',
            String(want),
            // sin comprimir: RGBA de 8 bits, que el worker vuelca en el
            // lienzo tal cual, o RGB de 16 bits de una fuente más profunda.
            // La matriz y el rango los toma swscale del propio flujo
            '-c:v',
            'rawvideo',
            '-pix_fmt',
            outFmt ?? 'rgb48le',
            '-f',
            'image2',
            'f_%03d.raw',
          ]);
          const [w, h] = outSize ?? [probe.width, probe.height];
          let got = 0;
          for (let i = 1; i <= want; i++) {
            const name = `f_${String(i).padStart(3, '0')}.raw`;
            let data: Uint8Array | string;
            try {
              data = await ff.readFile(name);
            } catch {
              break;
            }
            await ff.deleteFile(name);
            if (typeof data === 'string')
              throw new Error('The video decoder returned text instead of image bytes.');
            got++;
            // readFile copia el fotograma fuera de ffmpeg: ArrayBuffer
            // propio, que se transfiere al worker sin otra copia
            const bytes = data as Bytes;
            await queue.push(
              !deep ? { rgba: bytes, w, h } : deepFrame(bytes, w, h, planar, pix, probe.rotation),
              t + (i - 1) * dt,
            );
          }
          if (!got) break; // fin del archivo antes de lo estimado
          t += got * dt;
        }
      } catch (e) {
        // la instancia terminada por onAbort rechaza el exec o el readFile
        // en curso: no es un fallo, es la parada
        if (!opts.signal?.aborted) throw e;
        cancelled = true;
      } finally {
        ff.off('log', onLog);
      }
      // lo que ya estaba en los workers se entrega igual, en orden
      await queue.finish();
      return { count: queue.count, fps, duration: probe.duration, origen: file.name, cancelled };
    } catch (e) {
      // parada durante el sondeo (probeLoaded traga el exec rechazado y
      // dice "could not be decoded"): tampoco es un fallo
      if (!opts.signal?.aborted) throw e;
      return { count: 0, fps: opts.fps || 12, duration: 0, origen: file.name, cancelled: true };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      // withFF libera la instancia (~350 MB) al no quedar sesiones en cola
      await unmountInput(ff);
    }
  });
}
