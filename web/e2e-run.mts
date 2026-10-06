// Browser end-to-end test runner: serves web/dist itself and drives the
// e2e.html page (full pipeline: sheets → scan → calibration → cyanotype →
// video → lossless export) in Chrome, Zen/Firefox or Safari, then checks the
// lossless files with the machine's own ffmpeg (e2e-verify.mts). Used
// locally (`npm run test:e2e [-- --browser=zen|safari]`) and in CI (Chrome).
//
// Node runs this file directly (type stripping, Node 22.18+ / 24): only
// erasable TypeScript syntax is allowed here, which tsconfig.node.json
// enforces with `erasableSyntaxOnly`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserFromArgs, HEADERS_FILE, launch, serveDist } from './e2e-browsers.mts';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));
// El informe de la corrida: se reescribe en cada una y no va al repositorio
const ARTIFACT_DIR = fileURLToPath(new URL('../artifacts/e2e/', import.meta.url));

// Sample video for the WebCodecs extract/encode test. Generated with ffmpeg
// when available (local dev and the ubuntu CI runner both have it); the page
// skips the video section gracefully if the file is absent.
const sample = join(DIST, 'e2e_sample.mp4');
if (!existsSync(sample)) {
  const gen = spawnSync(
    'ffmpeg',
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=12:duration=3',
      '-pix_fmt',
      'yuv420p',
      '-y',
      sample,
    ],
    { stdio: 'ignore' },
  );
  console.log(
    gen.status === 0
      ? 'Generated e2e_sample.mp4 for the WebCodecs test.'
      : 'ffmpeg not available: the video section will be skipped.',
  );
}
// MP4 CON AUDIO para la prueba del sonido del original: un tono que salta de
// 440 Hz a 880 Hz en t = 1.5 s. La prueba corta el tramo [0.5, 2.5) s y
// exige 440 Hz en la primera mitad y 880 Hz en la segunda, lo que verifica
// a la vez el recorte y que el audio arranque en cero junto al primer
// fotograma. Un tono y no ruido: la frecuencia se mide contando cruces por
// cero, sin depender del códec ni de la resolución del muestreo.
const withAudio = join(DIST, 'e2e_sample_audio.mp4');
if (!existsSync(withAudio)) {
  spawnSync(
    'ffmpeg',
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=12:duration=3',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='sin(2*PI*t*(440+440*gte(t,1.5)))':s=48000:d=3",
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      withAudio,
    ],
    { stdio: 'ignore' },
  );
}
// Variantes de SONIDO para la batería de combinaciones de la exportación:
// estéreo a 44.1 kHz (otra frecuencia y otro número de canales que la
// muestra de arriba, que es mono a 48 kHz) y 5.1, que hay que reducir a dos
// canales porque un MOV de edición con 'sowt' no lleva más.
for (const [name, ch, rate] of [
  ['e2e_sample_audio_stereo.mp4', 2, 44100],
  ['e2e_sample_audio_51.mp4', 6, 48000],
] as const) {
  const file = join(DIST, name);
  if (existsSync(file)) continue;
  spawnSync(
    'ffmpeg',
    [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=12:duration=3',
      '-f',
      'lavfi',
      '-i',
      ch === 2
        ? `aevalsrc='sin(2*PI*t*(440+440*gte(t,1.5)))':s=${rate}:d=3:c=stereo`
        : // 5.1 con el tono SÓLO en el canal central, que es donde va el
          // diálogo: si la mezcla a estéreo se quedara con el frontal
          // izquierdo y el derecho, el resultado sería silencio y la prueba
          // lo vería
          `aevalsrc='0|0|sin(2*PI*t*(440+440*gte(t,1.5)))|0|0|0':s=${rate}:d=3:c=5.1`,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-y',
      file,
    ],
    { stdio: 'ignore' },
  );
}
// AVI con códec MPEG-4 ASP: WebCodecs no lo decodifica, así que ejercita el
// camino de respaldo con ffmpeg.wasm.
const avi = join(DIST, 'e2e_sample.avi');
if (!existsSync(avi)) {
  spawnSync(
    'ffmpeg',
    ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=2', '-c:v', 'mpeg4', '-y', avi],
    { stdio: 'ignore' },
  );
}
// Video de 10 bits con contenido de 10 bits de verdad: una rampa de luma de
// unos 800 niveles que se desplaza (cada fotograma distinto), croma neutra
// en la mitad de arriba y de color en la de abajo. Sin pérdida, para que los
// códigos que lee la página sean exactamente los de la fuente. Tres
// variantes: VP9 perfil 2 en WebM (BT.709; WebCodecs entrega sus planos por
// software en Chrome), el mismo en MP4 con matriz BT.601 y girado 90° por
// metadatos (un móvil en vertical), y HEVC Main 10 (en Chrome solo por
// hardware y sin los 10 bits: obliga a ir por ffmpeg.wasm).
const RAMP =
  "format=yuv420p10le,geq=lum='64+mod(X*876/W+T*200\\,876)':cb='if(lt(Y\\,H/2)\\,512\\,512+(X-W/2)*3)':cr='if(lt(Y\\,H/2)\\,512\\,512+(Y-3*H/4)*6)'";
const rampSrc = ['-f', 'lavfi', '-i', 'nullsrc=s=320x180:r=10:d=1', '-vf', RAMP];
// bitexact: sin el UID aleatorio ni la fecha que Matroska escribe en cada
// archivo, así el SHA-256 de la muestra se repite de una corrida a otra
const tags = (m: string): string[] => [
  ...['-color_primaries', m, '-color_trc', m, '-colorspace', m, '-color_range', 'tv'],
  ...['-fflags', '+bitexact'],
];
const deepSamples: [string, string[]][] = [
  [
    'e2e_sample_deep.webm',
    [...rampSrc, '-c:v', 'libvpx-vp9', '-profile:v', '2', '-lossless', '1', ...tags('bt709')],
  ],
  [
    'e2e_sample_hevc10.mp4',
    [
      ...rampSrc,
      ...['-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1'],
      ...['-x265-params', 'lossless=1:log-level=error', ...tags('bt709')],
    ],
  ],
];
for (const [name, args] of deepSamples) {
  const file = join(DIST, name);
  if (!existsSync(file)) spawnSync('ffmpeg', [...args, '-y', file], { stdio: 'ignore' });
}
// MOV con ProRes 422 (10 bits, 4:2:2): contenedor legible por mediabunny
// pero códec que WebCodecs no decodifica en ningún navegador. Ejercita el
// desvío por canDecode() hacia ffmpeg.wasm, con la misma rampa de 10 bits.
const mov = join(DIST, 'e2e_sample_prores.mov');
if (!existsSync(mov)) {
  spawnSync(
    'ffmpeg',
    [...rampSrc, '-c:v', 'prores_ks', '-profile:v', '2', ...tags('bt709'), '-y', mov],
    { stdio: 'ignore' },
  );
}
const rot = join(DIST, 'e2e_sample_deep_rot.mp4');
if (!existsSync(rot)) {
  const pre = join(DIST, 'rot_pre.mp4');
  spawnSync(
    'ffmpeg',
    [
      ...rampSrc,
      ...['-c:v', 'libvpx-vp9', '-profile:v', '2', '-lossless', '1', ...tags('smpte170m')],
      ...['-y', pre],
    ],
    { stdio: 'ignore' },
  );
  spawnSync('ffmpeg', ['-display_rotation:v:0', '90', '-i', pre, '-c', 'copy', '-y', rot], {
    stdio: 'ignore',
  });
  await rm(pre, { force: true });
}
const which = browserFromArgs();
const { port, close: closeServer } = await serveDist(DIST);
const driver = await launch(which);
console.log(`Browser: ${driver.version}`);
await driver.open(`http://127.0.0.1:${port}/e2e.html`);
let title = '';
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  title = await driver.title().catch(() => '');
  if (title.startsWith('E2E-')) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!title.startsWith('E2E-')) console.log('Timed out waiting for the E2E page to finish.');
const log = await driver
  .run<string>("return document.getElementById('log')?.textContent ?? '(no log)';")
  .catch(() => '(no log)');
console.log('---\nRESULT:', title);
console.log(log);
const report = (await driver.run('return globalThis.e2eReport ?? null;').catch(() => null)) as {
  steps: string[];
  outputs: Record<string, string>;
  lossless: { sequence: string[] };
  compressed?: import('./e2e-verify.mts').CompressedFacts;
  deepVideo?: import('./e2e-verify.mts').DeepFact[];
  csp: string[];
} | null;
// los archivos que la página deja para verificar por fuera, en base64
const files = (await driver
  .run<Record<string, string>>(
    `const out = {};
     for (const [name, blob] of Object.entries(globalThis.e2eFiles ?? {})) {
       out[name] = await new Promise((res, rej) => {
         const r = new FileReader();
         r.onload = () => res(String(r.result).split(',')[1] ?? '');
         r.onerror = () => rej(r.error);
         r.readAsDataURL(blob);
       });
     }
     return out;`,
  )
  .catch(() => ({}))) as Record<string, string>;
await driver.close();
closeServer();

// Una violación de CSP no lanza: el navegador bloquea el recurso y la página
// sigue a medias. La página las escucha ella misma (securitypolicyviolation,
// en los tres navegadores) y Chrome además las dice por consola.
const cspViolations = [...new Set([...(report?.csp ?? []), ...driver.cspConsole])];
if (cspViolations.length) {
  console.log(`\nCSP: ${cspViolations.length} violation(s) against web/public/_headers:`);
  for (const v of cspViolations) console.log(`  ${v}`);
}

// ── lo que salió, verificado por fuera ─────────────────────────────────
const RUN_DIR = join(ARTIFACT_DIR, which);
await mkdir(RUN_DIR, { recursive: true });
for (const [name, b64] of Object.entries(files))
  await writeFile(join(RUN_DIR, name), Buffer.from(b64, 'base64'));
const { verifyCompressed, verifyDeep, verifyLossless } = await import('./e2e-verify.mts');
const lossless = await verifyLossless(RUN_DIR, report?.lossless.sequence ?? []);
for (const line of lossless.log) console.log(line);
const lossy = await verifyCompressed(
  RUN_DIR,
  report?.compressed ?? null,
  report?.lossless.sequence ?? [],
);
for (const line of lossy.log) console.log(line);
const deep = await verifyDeep(RUN_DIR, DIST, report?.deepVideo ?? []);
for (const line of deep.log) console.log(line);
const passed =
  title === 'E2E-OK' && cspViolations.length === 0 && lossless.ok && lossy.ok && deep.ok;

// Informe verificable: entradas (muestras generadas, núcleo WASM, cabeceras
// del sitio) y salidas por SHA-256, más cada paso comprobado. No lleva
// tiempos ni fechas: con las mismas entradas, el mismo navegador y el mismo
// ffmpeg, dos corridas escriben el mismo archivo byte a byte.
const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const inputs: Record<string, string> = {};
for (const f of (await readdir(DIST)).filter((n) => n.startsWith('e2e_sample')).sort())
  inputs[`samples/${f}`] = sha256(await readFile(join(DIST, f)));
for (const f of (await readdir(join(DIST, 'assets'))).filter((n) => n.endsWith('.wasm')).sort())
  inputs[`wasm/${f.replace(/-[^-.]+\.wasm$/, '.wasm')}`] = sha256(
    await readFile(join(DIST, 'assets', f)),
  );
inputs['public/_headers'] = sha256(HEADERS_FILE);
const ffmpeg =
  spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout?.split('\n')[0] ?? null;
const outputs = { ...(report?.outputs ?? {}), ...lossless.outputs, ...deep.outputs };
const artifact = {
  suite: 'browser-pipeline',
  browser: which,
  result: title,
  passed,
  checks: {
    page_reached_E2E_OK: title === 'E2E-OK',
    no_csp_violations: cspViolations.length === 0,
    ...lossless.checks,
    ...lossy.checks,
    ...deep.checks,
  },
  environment: { browser: driver.version, ffmpeg, node: process.version },
  inputs,
  outputs: Object.fromEntries(Object.entries(outputs).sort(([a], [b]) => (a < b ? -1 : 1))),
  steps: report?.steps ?? [],
  csp_violations: cspViolations,
};
const json = `${JSON.stringify(artifact, null, 2)}\n`;
const name = `browser-pipeline.${which}.json`;
await writeFile(join(ARTIFACT_DIR, name), json);
await writeFile(join(ARTIFACT_DIR, `${name}.sha256`), `${sha256(json)}  ${name}\n`);
console.log(`\nArtifact: artifacts/e2e/${name} (sha256 ${sha256(json)})`);
process.exit(passed ? 0 : 1);
