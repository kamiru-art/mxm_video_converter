/// <reference lib="dom" />
// (lib dom: los callbacks de page.evaluate corren en la página, no en Node)
//
// Prueba de punta a punta de la MUDANZA de mxm.sebastianlopez.me a
// mxmstudio.work, contra los dos sitios publicados (no hay forma honesta de
// probarla en local: el corazón del asunto es que son dos orígenes reales,
// con su localStorage, su service worker y su DNS). En Chrome:
//
//   ① alguien ya usó el dominio nuevo (un preset "A", un flag) y además tiene
//     en el viejo la app instalada (su service worker de verdad, con sus
//     cachés) y datos (otra "A", "B", un perfil de impresora, ajustes,
//     flags, la RAM) → entra por un enlace viejo a #scans y llega a
//     mxmstudio.work/#scans con todo sumado, ganando lo del dominio nuevo y
//     sin los flags; y el service worker viejo se da de baja y se lleva sus
//     cachés en cuanto no queda pestaña de la app vieja
//   ② borra "B" en el dominio nuevo y vuelve por el enlace viejo: "B" no
//     resucita
//   ③ mxm.sebastianlopez.me/?export no redirige y entrega el almacén viejo,
//     byte a byte, como archivo
//   ④ otro navegador abre antes un enlace de mudanza AJENO: no le impide
//     importar después los suyos
//   ⑤ un almacén demasiado grande para una URL (1,2 MB) no redirige: ofrece
//     el archivo, y el enlace grande de la página lleva a la URL limpia
//   ⑥ un fragmento #mxm-migrate= corrupto avisa con un aviso que no se va
//     solo y no marca nada
//   ⑦ www.mxmstudio.work redirige al apex con ruta, query y fragmento
//
// Dos intercepciones, ninguna sobre lo que se prueba: /__e2e-seed (una URL
// que no existe) contesta una página en blanco para escribir en el
// localStorage del origen viejo, y mientras se "instala la app vieja" /sw.js
// del origen viejo contesta el service worker de la app (dist/sw.js, el de
// esta build), que es lo que un usuario tenía registrado allí.
//
//   npm run build && npm run test:migration
//
// Artefacto: artifacts/e2e/migration.chrome.json con cada comprobación y el
// SHA-256 de los archivos de la mudanza tal como se sirven. Sin relojes.
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, CDPSession, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

const OLD = 'https://mxm.sebastianlopez.me';
const NEW = 'https://mxmstudio.work';
const WWW = 'https://www.mxmstudio.work';
const SEED = `${OLD}/__e2e-seed`;
const STORE_KEY = 'mxm-studio-v1';
const ARTIFACT_DIR = fileURLToPath(new URL('../artifacts/e2e/', import.meta.url));
const APP_SW = await readFile(new URL('./dist/sw.js', import.meta.url), 'utf8').catch(() => '');
if (!APP_SW.includes('mxm-v2')) throw new Error('dist/sw.js missing: run `npm run build` first');

const checks: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${step}: ${detail}`);
}

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p): p is string => !!p && existsSync(p));
if (!chrome) throw new Error('Chrome not found: set CHROME_PATH');

async function newPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url() === SEED) {
      void req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><p>seed' });
    } else {
      void req.continue();
    }
  });
  return page;
}

/** Espera a que main.ts haya corrido en mxmstudio.work: show() deja siempre
 *  la ruta como `#<fase>`, y eso ocurre después de runMigration(). El HTML
 *  estático ya trae una vista activa, así que eso no sirve de señal. */
async function appReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => location.host === 'mxmstudio.work' && /^#[a-z]+$/.test(location.hash),
    { timeout: 30_000 },
  );
}

/** Navega por la cadena de redirecciones (HTTP y location.replace) hasta que
 *  la app del dominio nuevo arranca. */
async function landOnApp(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await appReady(page);
  return page.url();
}

const readStore = (page: Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), STORE_KEY);

async function seedOld(page: Page, store: string | null, ram: string | null): Promise<void> {
  await page.goto(SEED);
  await page.evaluate(
    (k, s, r) => {
      localStorage.clear();
      if (s !== null) localStorage.setItem(k, s);
      if (r !== null) localStorage.setItem('mxm_ram_gb', r);
    },
    STORE_KEY,
    store,
    ram,
  );
}

type RegUpdate = {
  registrations: { registrationId: string; scopeURL: string; isDeleted: boolean }[];
};

/** Las inscripciones de service worker vivas de un origen, vistas por CDP
 *  desde una página de OTRO origen: abrir una del origen viejo la haría
 *  cliente del service worker y le impediría activarse. */
async function liveRegistrations(cdp: CDPSession, origin: string): Promise<number> {
  const regs = new Map<string, boolean>();
  const onUpdate = (e: RegUpdate) => {
    for (const r of e.registrations) {
      if (r.scopeURL.startsWith(origin)) regs.set(r.registrationId, r.isDeleted);
    }
  };
  cdp.on('ServiceWorker.workerRegistrationUpdated', onUpdate);
  await cdp.send('ServiceWorker.enable');
  await new Promise((r) => setTimeout(r, 500));
  await cdp.send('ServiceWorker.disable');
  cdp.off('ServiceWorker.workerRegistrationUpdated', onUpdate);
  return [...regs.values()].filter((deleted) => !deleted).length;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let browser: Browser | null = null;
let failed: unknown = null;
const served: Record<string, string> = {};
try {
  for (const [name, url] of Object.entries({
    'old/index.html': `${OLD}/`,
    'old/moved.js': `${OLD}/moved.js`,
    'old/sw.js': `${OLD}/sw.js`,
  })) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    served[name] = sha(Buffer.from(await res.arrayBuffer()));
  }

  browser = await puppeteer.launch({ executablePath: chrome, headless: true });

  // /sw.js del origen viejo: el de la app mientras se "instala", el real después
  let serveAppSw = false;
  const fetchCdp = await browser.target().createCDPSession();
  await fetchCdp.send('Fetch.enable', { patterns: [{ urlPattern: `${OLD}/sw.js*` }] });
  fetchCdp.on('Fetch.requestPaused', (e: { requestId: string }) => {
    void (
      serveAppSw
        ? fetchCdp.send('Fetch.fulfillRequest', {
            requestId: e.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }],
            body: Buffer.from(APP_SW).toString('base64'),
          })
        : fetchCdp.send('Fetch.continueRequest', { requestId: e.requestId })
    ).catch(() => {});
  });

  // ① alguien con datos en los dos lados y la app vieja instalada
  const ctx = await browser.createBrowserContext();
  const page = await newPage(ctx);
  await landOnApp(page, `${NEW}/#sheets`);
  await page.evaluate((k) => {
    localStorage.clear();
    localStorage.setItem(
      k,
      JSON.stringify({ presets: { A: { side: 'new' } }, flags: { mt: 'new' } }),
    );
  }, STORE_KEY);
  const oldStore = {
    presets: { A: { side: 'old' }, B: { side: 'old', ñ: 'acentos ✓' } },
    impresora: { Epson: { dpi: 1440 } },
    ajustes: { cols: 4 },
    flags: { mt: 'old', other: '1' },
  };
  await seedOld(page, JSON.stringify(oldStore), '24');
  serveAppSw = true;
  const installed = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    // lo que la app dejaba guardado: sus scripts, aquí uno de muestra
    await (await caches.open('mxm-v2-assets')).put('/assets/x.js', new Response('//'));
    return { active: !!reg.active, caches: (await caches.keys()).sort() };
  });
  serveAppSw = false;
  check(
    'the old app is installed on the old address',
    installed.active && installed.caches.includes('mxm-v2-assets'),
    JSON.stringify(installed),
  );

  const landed = await landOnApp(page, `${OLD}/#scans`);
  check('old link lands on the new address with its route', landed === `${NEW}/#scans`, landed);
  const active = await page.evaluate(() => document.querySelector('.view.active')?.id);
  check('the route opens its phase', active === 'view-scans', String(active));
  const merged = await readStore(page);
  const want = {
    presets: { A: { side: 'new' }, B: oldStore.presets.B },
    impresora: oldStore.impresora,
    ajustes: oldStore.ajustes,
    flags: { mt: 'new' },
  };
  check(
    'stores merged, the new address wins a clash, flags stay behind',
    JSON.stringify(sortKeys(merged)) === JSON.stringify(sortKeys(want)),
    JSON.stringify(merged),
  );
  const extra = await page.evaluate(() => [
    localStorage.getItem('mxm_ram_gb'),
    JSON.parse(localStorage.getItem('mxm-migrated-ids') ?? '[]').length,
  ]);
  check(
    'RAM setting and one imported id',
    extra[0] === '24' && extra[1] === 1,
    JSON.stringify(extra),
  );
  const errToasts = await page.evaluate(() =>
    [...document.querySelectorAll('#toasts .err')].map((t) => t.textContent),
  );
  check('no error toast', errToasts.length === 0, JSON.stringify(errToasts));

  const cdp = await page.createCDPSession();
  let live = await liveRegistrations(cdp, OLD);
  for (let i = 0; i < 20 && live > 0; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    live = await liveRegistrations(cdp, OLD);
  }
  await page.goto(SEED);
  const oldLeft = await page.evaluate(async () => ({
    caches: await caches.keys(),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  check(
    'the old service worker unregistered itself and took its caches',
    live === 0 && oldLeft.caches.length === 0 && oldLeft.workers === 0,
    JSON.stringify({ live, ...oldLeft }),
  );

  // ② un preset borrado aquí no vuelve por el enlace viejo
  await landOnApp(page, `${NEW}/`);
  await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    delete s.presets.B;
    localStorage.setItem(k, JSON.stringify(s));
  }, STORE_KEY);
  const again = await landOnApp(page, `${OLD}/`);
  const afterDelete = await readStore(page);
  check(
    'second visit through the old link imports nothing',
    again === `${NEW}/#sheets` &&
      !('B' in afterDelete.presets) &&
      afterDelete.presets.A.side === 'new',
    `${again} presets=${Object.keys(afterDelete.presets).join(',')}`,
  );

  // ③ ?export: el almacén viejo como archivo, sin redirigir
  await page.goto(`${OLD}/?export`);
  await page.waitForSelector('#manual:not([hidden])', { timeout: 10_000 });
  const exported = await page.evaluate(async () => {
    const a = document.getElementById('export') as HTMLAnchorElement;
    return {
      host: location.host,
      file: a.download,
      body: await (await fetch(a.href)).text(),
      go: (document.getElementById('go') as HTMLAnchorElement).href,
    };
  });
  check(
    '?export offers the old store byte for byte',
    exported.host === 'mxm.sebastianlopez.me' && exported.body === JSON.stringify(oldStore),
    `${exported.file}, ${exported.body.length} chars`,
  );
  await ctx.close();

  // ④ un enlace de mudanza ajeno (el grande de la página de mudanza de ese
  // navegador, copiado) no bloquea el propio
  const foreignLink = exported.go;
  const other = await browser.createBrowserContext();
  const otherPage = await newPage(other);
  await landOnApp(otherPage, foreignLink);
  await seedOld(otherPage, JSON.stringify({ presets: { Mine: { side: 'own' } } }), null);
  await landOnApp(otherPage, `${OLD}/`);
  const otherStore = await readStore(otherPage);
  check(
    'a foreign migration link does not block the own one',
    foreignLink.includes('#mxm-migrate=') &&
      'B' in otherStore.presets &&
      otherStore.presets.Mine?.side === 'own',
    `presets=${Object.keys(otherStore.presets).sort().join(',')}`,
  );
  await other.close();

  // ⑤ demasiado grande para una URL
  const big = await browser.createBrowserContext();
  const bigPage = await newPage(big);
  const huge = JSON.stringify({ presets: { big: { blob: 'x'.repeat(1_200_000) } } });
  await seedOld(bigPage, huge, null);
  await bigPage.goto(`${OLD}/#calibration`);
  await bigPage.waitForSelector('#manual:not([hidden])', { timeout: 10_000 });
  const bigState = await bigPage.evaluate(async () => {
    const a = document.getElementById('export') as HTMLAnchorElement;
    return {
      host: location.host,
      go: (document.getElementById('go') as HTMLAnchorElement).href,
      size: (await (await fetch(a.href)).text()).length,
    };
  });
  check(
    'a store too big for a URL is offered as a file, the link stays plain',
    bigState.host === 'mxm.sebastianlopez.me' &&
      bigState.size === huge.length &&
      bigState.go === `${NEW}/#calibration`,
    JSON.stringify(bigState),
  );
  await big.close();

  // ⑥ fragmento corrupto
  const bad = await browser.createBrowserContext();
  const badPage = await newPage(bad);
  await landOnApp(badPage, `${NEW}/#mxm-migrate=@@not-base64@@`);
  await new Promise((r) => setTimeout(r, 10_000)); // más de lo que dura un aviso normal
  const badState = await badPage.evaluate(() => ({
    hash: location.hash,
    ids: localStorage.getItem('mxm-migrated-ids'),
    toast: document.querySelector('#toasts .err')?.textContent ?? '',
  }));
  check(
    'a corrupt payload warns until dismissed, cleans the URL and marks nothing',
    badState.hash === '#sheets' && badState.ids === null && badState.toast.includes('/?export'),
    JSON.stringify(badState),
  );
  await bad.close();

  // ⑦ www
  const w = await browser.createBrowserContext();
  const wPage = await newPage(w);
  const fromWww = await landOnApp(wPage, `${WWW}/?q=1#help`);
  check('www redirects to the apex', fromWww === `${NEW}/?q=1#help`, fromWww);
  await w.close();
} catch (e) {
  failed = e;
  console.error(e);
} finally {
  await browser?.close();
}

function sortKeys(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.fromEntries(
    Object.keys(v as object)
      .sort()
      .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
  );
}

const ok = !failed && checks.length > 0 && checks.every((c) => c.ok);
await mkdir(ARTIFACT_DIR, { recursive: true });
const json = `${JSON.stringify(
  {
    ok,
    error: failed ? String(failed) : null,
    sites: { old: OLD, new: NEW, www: WWW },
    served,
    checks,
  },
  null,
  2,
)}\n`;
const file = 'migration.chrome.json';
await writeFile(join(ARTIFACT_DIR, file), json);
await writeFile(join(ARTIFACT_DIR, `${file}.sha256`), `${sha(json)}  ${file}\n`);
console.log(`\nArtifact: artifacts/e2e/${file} (sha256 ${sha(json)})`);
process.exit(ok ? 0 : 1);
