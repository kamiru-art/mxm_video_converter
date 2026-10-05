/// <reference lib="dom" />
// (lib dom: los callbacks de page.evaluate corren en la página, no en Node)
// Prueba de punta a punta de la MUDANZA de mxm.sebastianlopez.me a
// mxmstudio.work, contra los dos sitios publicados (no hay forma honesta de
// probarla en local: el corazón del asunto es que son dos orígenes reales,
// con su localStorage, su service worker y su DNS). En Chrome:
//
//   ① alguien ya usó el dominio nuevo (un preset "A", un flag) y además tiene
//     datos en el viejo (otra "A", "B", un perfil de impresora, ajustes,
//     flags, la RAM, y cachés de la app vieja) → entra por un enlace viejo
//     a #scans y llega a mxmstudio.work/#scans con todo sumado, ganando lo
//     del dominio nuevo, y el dominio viejo sin cachés ni service worker
//   ② borra "B" en el dominio nuevo y vuelve por el enlace viejo: "B" no
//     resucita
//   ③ mxm.sebastianlopez.me/?export no redirige y entrega el almacén viejo,
//     byte a byte, como archivo
//   ④ un almacén demasiado grande para una URL (1,2 MB) tampoco redirige:
//     ofrece el archivo
//   ⑤ un fragmento #mxm-migrate= corrupto avisa y no deja nada a medias
//   ⑥ www.mxmstudio.work redirige al apex con ruta, query y fragmento
//
// Para escribir en el localStorage del dominio viejo, que ya sólo sirve la
// página de mudanza, la prueba intercepta UNA URL inexistente
// (/__e2e-seed) y contesta una página en blanco: lo que corre en ella es del
// origen viejo de verdad.
//
//   node e2e-migration.mts
//
// Artefacto: artifacts/e2e/migration.chrome.json con cada comprobación y el
// SHA-256 de los archivos de la mudanza tal como se sirven. Sin relojes.
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

const OLD = 'https://mxm.sebastianlopez.me';
const NEW = 'https://mxmstudio.work';
const WWW = 'https://www.mxmstudio.work';
const SEED = `${OLD}/__e2e-seed`;
const STORE_KEY = 'mxm-studio-v1';
const ARTIFACT_DIR = fileURLToPath(new URL('../artifacts/e2e/', import.meta.url));

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

/** Navega y espera a que la cadena de redirecciones (HTTP y location.replace)
 *  termine en `host`. */
async function landOn(page: Page, url: string, host: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (h) => location.host === h && document.readyState !== 'loading',
    {
      timeout: 20_000,
    },
    host,
  );
  return page.url();
}

async function appReady(page: Page): Promise<void> {
  await page.waitForSelector('.view.active', { timeout: 20_000 });
}

const readStore = (page: Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), STORE_KEY);

async function seedOld(page: Page, store: string | null, ram: string | null): Promise<void> {
  await page.goto(SEED);
  await page.evaluate(
    async (k, s, r) => {
      localStorage.clear();
      if (s !== null) localStorage.setItem(k, s);
      if (r !== null) localStorage.setItem('mxm_ram_gb', r);
      // lo que dejaba la app vieja: su caché del documento
      const c = await caches.open('mxm-v2-shell');
      await c.put('/', new Response('old shell'));
    },
    STORE_KEY,
    store,
    ram,
  );
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

  // ① alguien con datos en los dos lados
  const ctx = await browser.createBrowserContext();
  const page = await newPage(ctx);
  await page.goto(`${NEW}/#sheets`);
  await appReady(page);
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

  const landed = await landOn(page, `${OLD}/#scans`, 'mxmstudio.work');
  await appReady(page);
  check('old link lands on the new address with its route', landed === `${NEW}/#scans`, landed);
  const active = await page.evaluate(() => document.querySelector('.view.active')?.id);
  check('the route opens its phase', active === 'view-scans', String(active));
  const merged = await readStore(page);
  const want = {
    presets: { A: { side: 'new' }, B: oldStore.presets.B },
    impresora: oldStore.impresora,
    ajustes: oldStore.ajustes,
    flags: { mt: 'new', other: '1' },
  };
  check(
    'stores merged, the new address wins a clash',
    JSON.stringify(sortKeys(merged)) === JSON.stringify(sortKeys(want)),
    JSON.stringify(merged),
  );
  const extra = await page.evaluate(() => [
    localStorage.getItem('mxm_ram_gb'),
    localStorage.getItem('mxm-migrated-from'),
  ]);
  check(
    'RAM setting and the one-time mark',
    extra[0] === '24' && extra[1] === OLD,
    JSON.stringify(extra),
  );
  const errToasts = await page.evaluate(() =>
    [...document.querySelectorAll('#toasts .err')].map((t) => t.textContent),
  );
  check('no error toast', errToasts.length === 0, JSON.stringify(errToasts));

  await page.goto(SEED);
  const oldLeft = await page.evaluate(async () => ({
    caches: await caches.keys(),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));
  check(
    'old address left without caches or service worker',
    oldLeft.caches.length === 0 && oldLeft.workers === 0,
    JSON.stringify(oldLeft),
  );

  // ② un preset borrado aquí no vuelve por el enlace viejo
  await page.goto(`${NEW}/`);
  await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    delete s.presets.B;
    localStorage.setItem(k, JSON.stringify(s));
  }, STORE_KEY);
  const again = await landOn(page, `${OLD}/`, 'mxmstudio.work');
  await appReady(page);
  const afterDelete = await readStore(page);
  check(
    'second visit through the old link imports nothing',
    /^https:\/\/mxmstudio\.work\/(#sheets)?$/.test(again) &&
      !('B' in afterDelete.presets) &&
      afterDelete.presets.A.side === 'new',
    `${again} presets=${Object.keys(afterDelete.presets).join(',')}`,
  );

  // ③ ?export: el almacén viejo como archivo, sin redirigir
  await page.goto(`${OLD}/?export`);
  await page.waitForSelector('#manual:not([hidden])', { timeout: 10_000 });
  const exported = await page.evaluate(async () => {
    const a = document.getElementById('export') as HTMLAnchorElement;
    return { host: location.host, file: a.download, body: await (await fetch(a.href)).text() };
  });
  check(
    '?export offers the old store byte for byte',
    exported.host === 'mxm.sebastianlopez.me' && exported.body === JSON.stringify(oldStore),
    `${exported.file}, ${exported.body.length} chars`,
  );
  await ctx.close();

  // ④ demasiado grande para una URL
  const big = await browser.createBrowserContext();
  const bigPage = await newPage(big);
  const huge = JSON.stringify({ presets: { big: { blob: 'x'.repeat(1_200_000) } } });
  await seedOld(bigPage, huge, null);
  await bigPage.goto(`${OLD}/`);
  await bigPage.waitForSelector('#manual:not([hidden])', { timeout: 10_000 });
  const bigState = await bigPage.evaluate(async () => ({
    host: location.host,
    size: (
      await (await fetch((document.getElementById('export') as HTMLAnchorElement).href)).text()
    ).length,
  }));
  check(
    'a store too big for a URL is offered as a file instead',
    bigState.host === 'mxm.sebastianlopez.me' && bigState.size === huge.length,
    JSON.stringify(bigState),
  );
  await big.close();

  // ⑤ fragmento corrupto
  const bad = await browser.createBrowserContext();
  const badPage = await newPage(bad);
  await badPage.goto(`${NEW}/#mxm-migrate=@@not-base64@@`);
  await appReady(badPage);
  const badState = await badPage.evaluate(() => ({
    hash: location.hash,
    mark: localStorage.getItem('mxm-migrated-from'),
    toast: document.querySelector('#toasts .err')?.textContent ?? '',
  }));
  check(
    'a corrupt payload warns, cleans the URL and marks nothing',
    badState.hash === '' && badState.mark === null && badState.toast.includes('/?export'),
    JSON.stringify(badState),
  );
  await bad.close();

  // ⑥ www
  const w = await browser.createBrowserContext();
  const wPage = await newPage(w);
  const fromWww = await landOn(wPage, `${WWW}/?q=1#help`, 'mxmstudio.work');
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
