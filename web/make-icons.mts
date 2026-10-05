// Genera todos los íconos en PNG a partir del favicon SVG de index.html, que
// es la única fuente del dibujo. Antes se hacían a mano y se quedaron con un
// diseño viejo mientras el favicon cambiaba: WhatsApp, la app instalada y la
// pantalla de inicio de iOS mostraban otro ícono que la pestaña.
//
//   node make-icons.mts           (Chrome, o CHROME_PATH) y versionar lo que escribe
//   node make-icons.mts --check   (CI) falla si el favicon cambió y nadie regeneró
//
// Cada URL de ícono en index.html y en el manifiesto lleva `?v=` con el hash
// del SVG: los que muestran vistas previas, el service worker y las apps
// instaladas guardan una imagen por su URL, así que la URL cambia cuando
// cambia el dibujo. El script reescribe esos `?v=`; --check comprueba que
// todos coinciden con el SVG actual, sin Chrome, y es lo que corre CI.
//
// Variantes:
//   any       el SVG tal cual, esquinas redondeadas y fondo transparente
//   apple     cuadrado lleno sin redondear: iOS pone sus propias esquinas
//   maskable  cuadrado lleno, con el dibujo reducido hasta caber en la zona
//             segura (círculo del 80 %) que recortan Android y Chrome; la
//             escala sale de medir el dibujo, no de una constante
//   og        1200×630 opaco para las vistas previas de enlaces
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';
import { CHROME_ARGS, chromePath } from './e2e-browsers.mts';

const HTML = new URL('./index.html', import.meta.url);
const MANIFEST = new URL('./public/manifest.webmanifest', import.meta.url);
const html = await readFile(HTML, 'utf8');
const manifest = await readFile(MANIFEST, 'utf8');
const href = /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)">/.exec(
  html,
)?.[1];
if (!href) throw new Error('No <link rel="icon" type="image/svg+xml" href="data:…"> in index.html');
const svg = decodeURIComponent(href);
const version = createHash('sha256').update(svg).digest('hex').slice(0, 8);
const ICON_REF = /(\/icons\/[\w-]+\.png)\?v=\w*/g;

if (process.argv.includes('--check')) {
  const refs = [...`${html}\n${manifest}`.matchAll(ICON_REF)];
  const stale = refs.filter((m) => !m[0].endsWith(`?v=${version}`));
  if (refs.length === 0 || stale.length > 0) {
    console.error(
      `The favicon in index.html is v=${version}, but these icon URLs are not:\n` +
        `${stale.map((m) => `  ${m[0]}`).join('\n')}\nRun: cd web && node make-icons.mts`,
    );
    process.exit(1);
  }
  console.log(`${refs.length} icon URLs match the favicon (v=${version})`);
  process.exit(0);
}

// El fondo es el primer <rect> que cubre todo el lienzo (con rx); lo que
// haya antes (<defs>, <style>) y los atributos del <svg> se conservan
const bg = /<rect width='32' height='32' rx='[\d.]+' fill='([^']+)'\/>/.exec(svg);
if (!bg) throw new Error(`Unexpected favicon shape (no full-size background rect): ${svg}`);
const square = `<rect width='32' height='32' fill='${bg[1]}'/>`;
const end = svg.lastIndexOf('</svg>');
const apple = svg.replace(bg[0], square);
const maskable = (scale: number) =>
  `${svg.slice(0, end).replace(bg[0], `${square}<g transform='translate(16 16) scale(${scale}) translate(-16 -16)'>`)}</g></svg>`;
/** Radio de la zona segura en 32 (el 40 % del lado), con un poco de margen. */
const SAFE_RADIUS = 12.5;

async function render(page: Page, markup: string, w: number, h = w): Promise<Buffer> {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  const src = `data:image/svg+xml,${encodeURIComponent(markup)}`;
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style><img src="${src}" width="${w}" height="${h}">`,
  );
  // `complete` también es true si la imagen no se pudo decodificar
  const ok = await page.evaluate(async () => {
    const img = document.images[0];
    await img.decode().catch(() => {});
    return img.naturalWidth > 0;
  });
  if (!ok) throw new Error(`The SVG did not decode: ${markup.slice(0, 200)}`);
  return Buffer.from(await page.screenshot({ omitBackground: true, type: 'png' }));
}

/** La escala que deja todo el dibujo (lo que no es el fondo) dentro del
 *  círculo de la zona segura, medida por el navegador. */
async function maskableScale(page: Page): Promise<number> {
  await page.setContent(maskable(1).replace('<svg ', "<svg width='32' height='32' "));
  const far = await page.evaluate(() => {
    const g = document.querySelector('svg > g') as SVGGElement;
    const b = g.getBBox();
    const xs = [b.x, b.x + b.width];
    const ys = [b.y, b.y + b.height];
    return Math.max(...xs.flatMap((x) => ys.map((y) => Math.hypot(x - 16, y - 16))));
  });
  return Math.min(1, Math.floor((SAFE_RADIUS / far) * 1000) / 1000);
}

const chrome = chromePath();
if (!chrome) throw new Error('Chrome not found: set CHROME_PATH');
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: CHROME_ARGS,
});
const files = new Map<string, Buffer>();
try {
  const page = await browser.newPage();
  const scale = await maskableScale(page);
  const inner = svg.slice(svg.indexOf('>') + 1, end);
  const og = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 630'><rect width='1200' height='630' fill='${bg[1]}'/><svg x='415' y='130' width='370' height='370' viewBox='0 0 32 32'>${inner}</svg></svg>`;
  files.set('public/icons/icon-192.png', await render(page, svg, 192));
  files.set('public/icons/icon-512.png', await render(page, svg, 512));
  files.set('public/icons/icon-maskable-512.png', await render(page, maskable(scale), 512));
  files.set('public/icons/apple-touch-icon.png', await render(page, apple, 180));
  files.set('public/icons/og-image.png', await render(page, og, 1200, 630));
  console.log(`maskable scale ${scale}`);
} finally {
  await browser.close();
}
// Todo renderizado antes de escribir nada: un fallo a medias no deja una
// mezcla de íconos nuevos y viejos
for (const [file, png] of files) {
  await writeFile(fileURLToPath(new URL(file, import.meta.url)), png);
  console.log(file);
}
await writeFile(HTML, html.replace(ICON_REF, `$1?v=${version}`));
await writeFile(MANIFEST, manifest.replace(ICON_REF, `$1?v=${version}`));
console.log(`icon URLs now carry ?v=${version}`);
