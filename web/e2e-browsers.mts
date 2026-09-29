// Lo que comparten las dos pruebas de punta a punta (e2e-run.mts, el
// pipeline por dentro; e2e-ui.mts, la interfaz a clics): el servidor de
// web/dist con las MISMAS cabeceras que el sitio publicado, y los tres
// navegadores detrás de una sola interfaz. Chrome y Zen (o cualquier
// Firefox) por puppeteer; Safari por safaridriver, que habla WebDriver
// clásico por HTTP (hay que haber activado una vez "Allow Remote
// Automation" en los ajustes de desarrollador de Safari).
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

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
export const HEADERS_FILE = await readFile(new URL('./public/_headers', import.meta.url), 'utf8');
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

/** Sirve `dist` en un puerto libre de 127.0.0.1, con las cabeceras de
 *  public/_headers en cada respuesta. */
export async function serveDist(dist: string): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const file = join(dist, path);
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
  return { port: address.port, close: () => server.close() };
}

// ── navegadores ─────────────────────────────────────────────────────────
//
// `npm run test:e2e` corre en Chrome (y así en CI). Con `-- --browser=zen`
// corre en Zen (o cualquier Firefox: ZEN_PATH / FIREFOX_PATH) por WebDriver
// BiDi, y con `-- --browser=safari` en Safari por safaridriver (hay que
// haber activado "Allow Remote Automation" una vez en el menú Develop).
// Cada navegador escribe su propio informe.

export type BrowserName = 'chrome' | 'zen' | 'safari';

/** El navegador que pide la línea de órdenes (`--browser=zen|safari`). */
export function browserFromArgs(): BrowserName {
  const arg = process.argv.find((a) => a.startsWith('--browser='))?.split('=')[1];
  return arg === 'zen' || arg === 'firefox' ? 'zen' : arg === 'safari' ? 'safari' : 'chrome';
}

/** Tamaño de ventana; `mobile` además activa el táctil y la densidad de un
 *  teléfono donde el navegador lo permite (Chrome). */
export interface Viewport {
  width: number;
  height: number;
  mobile?: boolean;
}

/** Lo mínimo que las pruebas necesitan de un navegador. */
export interface Driver {
  version: string;
  open(url: string): Promise<void>;
  title(): Promise<string>;
  /** Evalúa `body` (el cuerpo de una función async) y devuelve su JSON. */
  run<T>(body: string): Promise<T>;
  /** Captura de la ventana, en PNG. */
  screenshot(): Promise<Buffer>;
  /** Mensajes de consola que avisan de la CSP (sólo donde se pueden oír). */
  cspConsole: string[];
  /** Errores de JavaScript sin capturar (sólo donde se pueden oír). */
  pageErrors: string[];
  close(): Promise<void>;
}

function firstExisting(paths: (string | undefined)[]): string | undefined {
  return paths.filter((p): p is string => !!p).find((p) => existsSync(p));
}

async function puppeteerDriver(kind: 'chrome' | 'zen', viewport?: Viewport): Promise<Driver> {
  const executablePath =
    kind === 'chrome'
      ? firstExisting([
          process.env.CHROME_PATH,
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
        ])
      : firstExisting([
          process.env.ZEN_PATH,
          process.env.FIREFOX_PATH,
          '/Applications/Zen.app/Contents/MacOS/zen',
          '/Applications/Firefox.app/Contents/MacOS/firefox',
          '/usr/bin/firefox',
        ]);
  if (!executablePath) {
    console.error(
      kind === 'chrome'
        ? 'No Chrome/Chromium binary found. Set CHROME_PATH.'
        : 'No Zen/Firefox binary found. Set ZEN_PATH.',
    );
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    executablePath,
    browser: kind === 'chrome' ? 'chrome' : 'firefox',
    // `true` es el modo headless "nuevo" (el antiguo `'new'` ya no existe en
    // puppeteer 25; su valor por defecto es este mismo)
    headless: true,
    args: kind === 'chrome' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });
  const page = await browser.newPage();
  if (viewport)
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      // Firefox por BiDi no emula un teléfono: sólo el tamaño
      ...(viewport.mobile && kind === 'chrome'
        ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
        : {}),
    });
  const cspConsole: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[E2E]')) console.log(t);
    if (/Content Security Policy|Refused to (load|execute|connect|create)/i.test(t))
      cspConsole.push(t);
  });
  page.on('pageerror', (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    pageErrors.push(msg);
    console.log('PAGEERROR:', msg);
  });
  return {
    version: await browser.version(),
    cspConsole,
    pageErrors,
    screenshot: async () => Buffer.from(await page.screenshot({ type: 'png' })),
    async open(url) {
      await page.goto(url);
    },
    title: () => page.title(),
    run: <T,>(body: string) => page.evaluate(`(async () => { ${body} })()`) as Promise<T>,
    close: () => browser.close(),
  };
}

/** Safari por WebDriver clásico: safaridriver en un puerto libre y HTTP. */
async function safariDriver(viewport?: Viewport): Promise<Driver> {
  const port = 4444 + Math.floor(Math.random() * 1000);
  const proc = spawn('safaridriver', ['-p', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await r.json()) as { value: unknown };
    if (!r.ok) throw new Error(`safaridriver ${path}: ${JSON.stringify(j.value)}`);
    return j.value;
  };
  let session = '';
  let version = 'Safari';
  for (let i = 0; i < 50 && !session; i++) {
    try {
      const v = (await call('POST', '/session', {
        capabilities: { alwaysMatch: { browserName: 'safari' } },
      })) as { sessionId: string; capabilities: { browserVersion: string } };
      session = v.sessionId;
      version = `Safari ${v.capabilities.browserVersion}`;
    } catch (e) {
      if (i === 49) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const s = `/session/${session}`;
  await call('POST', `${s}/timeouts`, { script: 600000, pageLoad: 60000 });
  if (viewport)
    await call('POST', `${s}/window/rect`, { width: viewport.width, height: viewport.height });
  return {
    version,
    cspConsole: [],
    pageErrors: [],
    screenshot: async () => Buffer.from(String(await call('GET', `${s}/screenshot`)), 'base64'),
    async open(url) {
      await call('POST', `${s}/url`, { url });
    },
    title: async () => String(await call('GET', `${s}/title`)),
    run: async <T,>(body: string) =>
      (await call('POST', `${s}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          (async () => { ${body} })().then((v) => done(v), (e) => done({ __error: String(e) }));`,
        args: [],
      })) as T,
    async close() {
      await call('DELETE', s).catch(() => {});
      proc.kill();
    },
  };
}

/** Abre `which` (con `viewport`, si se da). */
export function launch(which: BrowserName, viewport?: Viewport): Promise<Driver> {
  return which === 'safari' ? safariDriver(viewport) : puppeteerDriver(which, viewport);
}
