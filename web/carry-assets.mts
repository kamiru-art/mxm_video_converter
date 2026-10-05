// Antes de publicar, copia a dist/ los archivos con hash de las versiones
// ya publicadas, para que una pestaña abierta antes del despliegue los
// siga encontrando.
//
// Cloudflare sustituye el conjunto entero de archivos en cada despliegue. Una
// pestaña cargada con la versión anterior conserva su main-<hash>.js y pide
// lo demás cuando le hace falta: pngmov-<hash>.js al guardar el MOV,
// avi-<hash>.js con un AVI, un worker-<hash>.js nuevo cuando el pool repone
// uno. Si ese archivo ya no existe, el sitio contesta el index.html (SPA
// fallback) y la pestaña falla a mitad de un proyecto: "Failed to fetch
// dynamically imported module". Pasó el 2026-10-05, entre un despliegue
// local y el de CI con hashes distintos.
//
// Qué se copia: lo que referencia la versión publicada ahora (siguiendo
// index.html → main → chunks, y los manifiestos de ffmpeg), más lo que
// /asset-history.json dice que se retiró hace menos de KEEP_DAYS. El
// historial nuevo se escribe en dist/ y se publica con el resto.
//
//   node carry-assets.mts https://mxmstudio.work dist
//
// No falla el despliegue si el sitio no responde (primer despliegue, otro
// dominio): avisa y sigue, porque sin esto el sitio funciona igual para
// quien recarga.
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const KEEP_DAYS = 14;
const [site, dist] = process.argv.slice(2);
if (!site || !dist) throw new Error('usage: node carry-assets.mts <site url> <dist dir>');
const HASHED = /(?<![A-Za-z0-9_])([A-Za-z0-9_]+-[A-Za-z0-9_-]{8}\.(?:js|wasm|css))/g;
const now = new Date();

type History = { files: Record<string, string> }; // ruta → fecha en que se retiró

async function get(path: string): Promise<Response | null> {
  const res = await fetch(new URL(path, site)).catch(() => null);
  if (!res?.ok) return null;
  // el SPA fallback contesta 200 con el index.html a lo que no existe
  if (path !== '/' && /^text\/html/i.test(res.headers.get('content-type') ?? '')) return null;
  return res;
}

/** Los archivos de la versión publicada ahora, siguiendo las referencias. */
async function liveFiles(): Promise<Set<string>> {
  const found = new Set<string>();
  const queue = ['/'];
  const seen = new Set<string>();
  while (queue.length) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await get(path);
    if (!res) continue;
    if (path !== '/') found.add(path.slice(1));
    if (/\.(js|css|html)$|^\/$/.test(path)) {
      for (const m of (await res.text()).matchAll(HASHED)) queue.push(`/assets/${m[1]}`);
    }
  }
  for (const variant of ['st', 'mt']) {
    const res = await get(`/ffmpeg/${variant}/manifest.json`);
    if (!res) continue;
    const m = (await res.json()) as { parts: number; path: string };
    const base = m.path.replace(/^\//, '');
    found.add(`${base}/ffmpeg-core.js`);
    for (let i = 0; i < m.parts; i++) found.add(`${base}/ffmpeg-core.wasm.${i}`);
    if (variant === 'mt') found.add(`${base}/ffmpeg-core.worker.js`);
  }
  return found;
}

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

const own = new Set(await walk(dist));
const oldHistory = ((await (await get('/asset-history.json'))?.json().catch(() => null)) ?? {
  files: {},
}) as History;
const live = await liveFiles();
if (live.size === 0) {
  console.warn(
    `::warning::${site} did not answer: nothing carried over from the published version`,
  );
}

const history: History = { files: {} };
const wanted = new Map<string, string>();
for (const f of live) wanted.set(f, oldHistory.files[f] ?? now.toISOString());
for (const [f, retired] of Object.entries(oldHistory.files)) {
  if (!wanted.has(f) && now.getTime() - Date.parse(retired) < KEEP_DAYS * 86400e3) {
    wanted.set(f, retired);
  }
}

let carried = 0;
let missing = 0;
for (const [f, retired] of wanted) {
  // solo lo que no se reconstruye con otro contenido bajo el mismo nombre:
  // archivos con hash y las piezas de ffmpeg en directorios con hash
  if (!/^assets\/|^ffmpeg\/(st|mt)-[0-9a-f]{12}\//.test(f)) continue;
  if (own.has(f)) continue; // la build nueva lo trae: no se retira
  const res = await get(`/${f}`);
  if (!res) {
    missing++;
    continue;
  }
  const target = join(dist, f);
  await mkdir(dirname(target), { recursive: true });
  if (!existsSync(target)) await writeFile(target, Buffer.from(await res.arrayBuffer()));
  history.files[f] = retired;
  carried++;
}
await writeFile(join(dist, 'asset-history.json'), `${JSON.stringify(history, null, 2)}\n`);
console.log(
  `carried ${carried} file(s) from earlier versions (kept ${KEEP_DAYS} days)${missing ? `, ${missing} no longer available` : ''}`,
);
