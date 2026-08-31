// Decodificador de respaldo (ffmpeg.wasm) para lo que WebCodecs no cubre:
// contenedores que mediabunny no abre (AVI, MPG/MPEG, WMV, FLV, 3GP) y códecs
// que el navegador no decodifica (MOV de cámara: HEVC 10 bits, ProRes,
// DNxHD…). Se carga bajo demanda (unos 32 MB) y se descarga de la memoria al
// terminar la extracción.

import { FFmpeg } from '@ffmpeg/ffmpeg';

let ffPromise = null;

// Un asset que falta NO responde 404: wrangler.jsonc trae
// not_found_handling: "single-page-application", así que el servidor
// devuelve index.html con 200. Mirar solo r.ok no puede detectarlo jamás y el
// fallo salía como "Unexpected token '<'" de JSON.parse, o como un módulo que
// no instancia. Se comprueba también el content-type y se nombra la causa.
function coreMissing(res, what) {
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
let wasmURLPromise = null;

function coreWasmURL(base) {
  // un fallo no se cachea: si el módulo aparece luego, el siguiente intento
  // vuelve a probar en vez de quedarse con la promesa rechazada
  if (!wasmURLPromise) wasmURLPromise = assembleCore(base).catch((e) => { wasmURLPromise = null; throw e; });
  return wasmURLPromise;
}

async function assembleCore(base) {
  const res = await fetch(`${base}/manifest.json`);
  if (!res.ok || !/\bjson\b/i.test(res.headers.get('content-type') || '')) throw coreMissing(res, 'manifest.json');
  const manifest = await res.json();
  if (!(manifest.parts > 0)) throw new Error('The video converter manifest lists no parts; rebuild web/public/ffmpeg/ with "npm run build".');
  const parts = await Promise.all(
    Array.from({ length: manifest.parts }, (_, i) =>
      fetch(`${base}/ffmpeg-core.wasm.${i}`).then((r) => {
        // el mismo fallback SPA: una parte que falte llegaría como HTML y el
        // módulo moriría al instanciar sin decir por qué
        if (!r.ok || /text\/html/i.test(r.headers.get('content-type') || '')) throw coreMissing(r, `ffmpeg-core.wasm.${i}`);
        return r.arrayBuffer();
      })),
  );
  return URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }));
}

async function loadCore() {
  const base = `${location.origin}/ffmpeg`;
  const wasmURL = await coreWasmURL(base);
  const ff = new FFmpeg();
  await ff.load({ coreURL: `${base}/ffmpeg-core.js`, wasmURL });
  return ff;
}

function getFF() {
  if (!ffPromise) ffPromise = loadCore();
  return ffPromise;
}

/** Cierra la instancia y libera su memoria WASM. */
async function release() {
  const p = ffPromise;
  ffPromise = null;
  try { (await p)?.terminate(); } catch { /* ya cerrada */ }
}

// La instancia es ÚNICA y se comparte entre la extracción y la exportación
// MOV (video.js). Dos sesiones a la vez se pisarían: terminate() de una
// rechaza los exec de la otra, los callbacks de progreso son globales por
// instancia y el FS es un solo espacio de nombres. withFF serializa cada
// sesión (montar → exec → leer) y libera la instancia cuando no queda
// ninguna en cola.
let ffQueue = Promise.resolve();
let ffPending = 0;

export function withFF(fn) {
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

async function mountInput(ff, file) {
  await ff.createDir(MOUNT);
  await ff.mount('WORKERFS', { blobs: [{ name: 'in', data: file }] }, MOUNT);
  return `${MOUNT}/in`;
}

async function unmountInput(ff) {
  try { await ff.unmount(MOUNT); } catch { /* sin montar */ }
  try { await ff.deleteDir(MOUNT); } catch { /* ya no está */ }
}

function parseProbeLog(log) {
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

async function probeLoaded(ff, path) {
  let log = '';
  const onLog = ({ message }) => { log += message + '\n'; };
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
export function probeFallback(file) {
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
 * tanda a la vez). Misma interfaz que extractFrames de video.js.
 */
export function extractFramesFallback(file, opts = {}) {
  return withFF(async (ff) => {
  const path = await mountInput(ff, file);
  try {
    const probe = await probeLoaded(ff, path);
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.min(probe.duration, opts.end ?? probe.duration);
    // duplica a propósito el assertRange de extractFrames (video.js): la
    // duración solo se conoce aquí, y sin esto un rango vacío o invertido
    // salía del bucle con count 0 y la interfaz lo daba por bueno en verde
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) {
      const n = (v) => (Number.isFinite(v) ? `${v.toFixed(2)} s` : 'not a number');
      const e = new Error(`Invalid time range: start (${n(start)}) must come before end (${n(end)}).`
        + ` This video lasts ${probe.duration.toFixed(2)} s.`);
      e.badRange = true; // extractFrames lo relanza en vez del error del contenedor
      throw e;
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
        let data;
        try { data = await ff.readFile(name); } catch { break; }
        await ff.deleteFile(name);
        got++;
        const blob = new Blob([data], { type: 'image/png' });
        const bmp = await createImageBitmap(blob);
        const tw = 256;
        const th = Math.max(1, Math.round((bmp.height / bmp.width) * tw));
        const thumb = new OffscreenCanvas(tw, th);
        thumb.getContext('2d').drawImage(bmp, 0, 0, tw, th);
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
