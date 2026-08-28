// Decodificador de respaldo (ffmpeg.wasm) para lo que WebCodecs no cubre:
// contenedores que mediabunny no abre (AVI, MPG/MPEG, WMV, FLV, 3GP) y códecs
// que el navegador no decodifica (MOV de cámara: HEVC 10 bits, ProRes,
// DNxHD…). Se carga bajo demanda (unos 32 MB) y se descarga de la memoria al
// terminar la extracción.

import { FFmpeg } from '@ffmpeg/ffmpeg';

let ffPromise = null;

async function loadCore() {
  const base = `${location.origin}/ffmpeg`;
  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  const parts = await Promise.all(
    Array.from({ length: manifest.parts }, (_, i) =>
      fetch(`${base}/ffmpeg-core.wasm.${i}`).then((r) => {
        if (!r.ok) throw new Error('The video converter module is missing on the server.');
        return r.arrayBuffer();
      })),
  );
  const wasmURL = URL.createObjectURL(new Blob(parts, { type: 'application/wasm' }));
  const ff = new FFmpeg();
  await ff.load({ coreURL: `${base}/ffmpeg-core.js`, wasmURL });
  return ff;
}

// La exportación lossless (video.js) reutiliza esta instancia como muxer.
export function getFF() {
  if (!ffPromise) ffPromise = loadCore();
  return ffPromise;
}

/** Cierra la instancia y libera su memoria WASM. */
export async function release() {
  const p = ffPromise;
  ffPromise = null;
  try { (await p)?.terminate(); } catch { /* ya cerrada */ }
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
export async function probeFallback(file) {
  const ff = await getFF();
  const path = await mountInput(ff, file);
  try {
    return { ...(await probeLoaded(ff, path)), fallback: true };
  } finally {
    await unmountInput(ff);
  }
}

/**
 * Extrae fotogramas como PNG por tandas (la memoria WASM solo retiene una
 * tanda a la vez). Misma interfaz que extractFrames de video.js.
 */
export async function extractFramesFallback(file, opts = {}) {
  const ff = await getFF();
  const path = await mountInput(ff, file);
  try {
    const probe = await probeLoaded(ff, path);
    const start = Math.max(0, opts.start ?? 0);
    const end = Math.min(probe.duration, opts.end ?? probe.duration);
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
    await unmountInput(ff);
    // liberar los ~350 MB que retiene la instancia del módulo
    await release();
  }
}
