// Browser end-to-end test runner: serves web/dist itself and drives the
// e2e.html page (full pipeline: sheets → scan → calibration → cyanotype →
// video) in headless Chrome. Used locally (`npm run test:e2e`) and in CI.
//
// Node runs this file directly (type stripping, Node 22.18+ / 24): only
// erasable TypeScript syntax is allowed here, which tsconfig.node.json
// enforces with `erasableSyntaxOnly`.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));

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
// MOV con ProRes: contenedor legible por mediabunny pero códec que WebCodecs
// no decodifica, como los MOV HEVC 10 bits de las cámaras. Ejercita el
// desvío por canDecode() hacia ffmpeg.wasm.
const mov = join(DIST, 'e2e_sample_prores.mov');
if (!existsSync(mov)) {
  spawnSync(
    'ffmpeg',
    ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=2', '-c:v', 'prores', '-y', mov],
    { stdio: 'ignore' },
  );
}
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
};

// La CSP se lee de web/public/_headers, el mismo archivo que Cloudflare
// aplica al sitio publicado. Se sirve también aquí para que una política que
// rompa la aplicación falle en este test y no en producción, que es donde una
// CSP mal puesta se descubre tarde y sin señal: el navegador bloquea en
// silencio y la página aparece simplemente vacía.
const HEADERS_FILE = await readFile(new URL('./public/_headers', import.meta.url), 'utf8');
const CSP = HEADERS_FILE.match(/^[ \t]+Content-Security-Policy:[ \t]*(.+)$/m)?.[1]?.trim();
if (!CSP) throw new Error('No Content-Security-Policy in web/public/_headers');
// Y el resto de cabeceras del bloque `/*` (COOP/COEP para el ffmpeg con
// hilos): el test corre bajo las mismas que el sitio, así que una que
// rompa la aplicación falla aquí y no en producción.
const SITE_HEADERS: Record<string, string> = {};
for (const line of HEADERS_FILE.split('\n')) {
  const m = /^[ \t]+([A-Za-z-]+):[ \t]*(.+)$/.exec(line);
  if (m && !/^Cache-Control$/i.test(m[1])) SITE_HEADERS[m[1]] = m[2];
}

const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (path === '/') path = '/index.html';
  const file = join(DIST, path);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      ...SITE_HEADERS,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const address = server.address();
if (!address || typeof address === 'string')
  throw new Error('The test server did not bind a TCP port.');
const port = address.port;

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter((p): p is string => !!p);
const executablePath = chromeCandidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Chromium binary found. Set CHROME_PATH.');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath,
  // `true` es el modo headless "nuevo" (el antiguo `'new'` ya no existe en
  // puppeteer 25; su valor por defecto es este mismo)
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
// Una violación de CSP no lanza: el navegador bloquea el recurso, avisa por
// consola y la página sigue a medias. Si no se recogen aquí, una política mal
// puesta pasa el test y rompe el sitio publicado.
const cspViolations: string[] = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[E2E]')) console.log(t);
  if (/Content Security Policy|Refused to (load|execute|connect|create)/i.test(t)) {
    cspViolations.push(t);
  }
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e instanceof Error ? e.message : String(e)));
await page.goto(`http://127.0.0.1:${port}/e2e.html`);
try {
  // como texto: corre en el navegador, y este archivo se comprueba sin la
  // biblioteca DOM
  await page.waitForFunction("document.title.startsWith('E2E-')", { timeout: 180000 });
} catch {
  console.log('Timed out waiting for the E2E page to finish.');
}
const title = await page.title();
const log = await page.$eval('#log', (el) => el.textContent).catch(() => '(no log)');
console.log('---\nRESULT:', title);
console.log(log);
if (cspViolations.length) {
  console.log(`\nCSP: ${cspViolations.length} violation(s) against web/public/_headers:`);
  for (const v of new Set(cspViolations)) console.log(`  ${v}`);
}
await browser.close();
server.close();
process.exit(title === 'E2E-OK' && cspViolations.length === 0 ? 0 : 1);
