// Copia el núcleo de ffmpeg.wasm (decodificador de AVI y otros formatos que
// WebCodecs no cubre) desde node_modules a public/ffmpeg. El .wasm de 32 MB
// se trocea en partes de 20 MB porque Cloudflare limita cada asset estático a
// 25 MB; el navegador las rearma en un Blob antes de instanciar el módulo.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('./node_modules/@ffmpeg/core/dist/esm', import.meta.url).pathname;
const DST = new URL('./public/ffmpeg', import.meta.url).pathname;
const PART = 20 * 1024 * 1024;

mkdirSync(DST, { recursive: true });
copyFileSync(join(SRC, 'ffmpeg-core.js'), join(DST, 'ffmpeg-core.js'));
const wasm = readFileSync(join(SRC, 'ffmpeg-core.wasm'));
let parts = 0;
for (let off = 0; off < wasm.length; off += PART) {
  writeFileSync(join(DST, `ffmpeg-core.wasm.${parts}`), wasm.subarray(off, off + PART));
  parts++;
}
writeFileSync(join(DST, 'manifest.json'), JSON.stringify({ parts, bytes: wasm.length }));
console.log(`ffmpeg core ready: ${parts} part(s), ${(wasm.length / 1e6).toFixed(1)} MB`);
