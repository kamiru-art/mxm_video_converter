// Copia los dos núcleos de ffmpeg.wasm desde node_modules a public/ffmpeg:
// `st/` (@ffmpeg/core, un hilo) y `mt/` (@ffmpeg/core-mt, con hilos; hace
// falta SharedArrayBuffer, es decir, las cabeceras COOP/COEP de _headers).
// avi.ts elige uno u otro al cargar. Cada .wasm de 32 MB se trocea en partes
// de 20 MB porque Cloudflare limita cada asset estático a 25 MB; el
// navegador las rearma en un Blob antes de instanciar el módulo.
//
// Las piezas van en un directorio con el hash de su contenido
// (`st-<hash>/`), que no cambia nunca: el service worker las guarda para
// siempre y no puede juntar partes de dos versiones. `st/manifest.json` dice
// qué directorio toca; es lo único que se pide a la red cada vez.
//
// Node ejecuta este archivo tal cual (borrado de tipos, Node 22.18+ / 24).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DST = fileURLToPath(new URL('./public/ffmpeg', import.meta.url));
const PART = 20 * 1024 * 1024;

rmSync(DST, { recursive: true, force: true });
for (const [pkg, dir] of [
  ['core', 'st'],
  ['core-mt', 'mt'],
] as const) {
  const src = fileURLToPath(new URL(`./node_modules/@ffmpeg/${pkg}/dist/esm`, import.meta.url));
  const js = readFileSync(join(src, 'ffmpeg-core.js'));
  const workerPath = join(src, 'ffmpeg-core.worker.js');
  const worker = existsSync(workerPath) ? readFileSync(workerPath) : null;
  const wasm = readFileSync(join(src, 'ffmpeg-core.wasm'));
  const hash = createHash('sha256')
    .update(js)
    .update(worker ?? '')
    .update(wasm)
    .digest('hex')
    .slice(0, 12);
  const versioned = `${dir}-${hash}`;
  const out = join(DST, versioned);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ffmpeg-core.js'), js);
  if (worker) writeFileSync(join(out, 'ffmpeg-core.worker.js'), worker);
  let parts = 0;
  for (let off = 0; off < wasm.length; off += PART) {
    writeFileSync(join(out, `ffmpeg-core.wasm.${parts}`), wasm.subarray(off, off + PART));
    parts++;
  }
  mkdirSync(join(DST, dir), { recursive: true });
  writeFileSync(
    join(DST, dir, 'manifest.json'),
    JSON.stringify({ parts, bytes: wasm.length, path: `/ffmpeg/${versioned}` }),
  );
  console.log(`ffmpeg ${dir} core ready: ${parts} part(s), ${(wasm.length / 1e6).toFixed(1)} MB`);
}
