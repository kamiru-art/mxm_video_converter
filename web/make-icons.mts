// Genera todos los íconos en PNG (y el .ico) a partir del favicon SVG de
// index.html, que es la única fuente del dibujo. Antes se hacían a mano y se
// quedaron con un diseño viejo mientras el favicon cambiaba: WhatsApp, la
// app instalada y la pantalla de inicio de iOS mostraban otro ícono que la
// pestaña. Si cambia el favicon:
//
//   node make-icons.mts        (Chrome, o CHROME_PATH)
//
// y se versionan los archivos que escribe. Tres variantes:
//   any       el SVG tal cual, esquinas redondeadas y fondo transparente
//   apple     cuadrado lleno sin redondear: iOS pone sus propias esquinas
//   maskable  cuadrado lleno, con el dibujo reducido para que quepa en la
//             zona segura (círculo del 80 %) que recortan Android y Chrome
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const href = /<link rel="icon" href="data:image\/svg\+xml,([^"]+)">/.exec(html)?.[1];
if (!href) throw new Error('No SVG favicon in index.html');
const svg = decodeURIComponent(href);
// El fondo es el primer <rect> (con rx); el dibujo, todo lo demás
const bg = /<rect width='32' height='32' rx='[\d.]+' fill='([^']+)'\/>/.exec(svg);
if (!bg) throw new Error(`Unexpected favicon shape: ${svg}`);
const glyph = svg.slice(svg.indexOf(bg[0]) + bg[0].length, svg.lastIndexOf('</svg>'));
const open = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>";
const variants = {
  any: svg,
  apple: `${open}<rect width='32' height='32' fill='${bg[1]}'/>${glyph}</svg>`,
  // 0,85 lleva las esquinas del dibujo (a 14,1 del centro) a 12,0: dentro
  // del radio de la zona segura, 12,8 en 32
  maskable: `${open}<rect width='32' height='32' fill='${bg[1]}'/><g transform='translate(16 16) scale(0.85) translate(-16 -16)'>${glyph}</g></svg>`,
};
type Variant = keyof typeof variants;

const OUT: { file: string; size: number; variant: Variant }[] = [
  { file: 'public/icons/icon-192.png', size: 192, variant: 'any' },
  { file: 'public/icons/icon-512.png', size: 512, variant: 'any' },
  { file: 'public/icons/icon-maskable-512.png', size: 512, variant: 'maskable' },
  { file: 'public/icons/apple-touch-icon.png', size: 180, variant: 'apple' },
  { file: '../assets/icon.png', size: 1024, variant: 'any' },
];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p): p is string => !!p && existsSync(p));
if (!chrome) throw new Error('Chrome not found: set CHROME_PATH');

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
async function render(variant: Variant, size: number): Promise<Buffer> {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  const src = `data:image/svg+xml,${encodeURIComponent(variants[variant])}`;
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}</style><img src="${src}" width="${size}" height="${size}">`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  const png = Buffer.from(await page.screenshot({ omitBackground: true, type: 'png' }));
  await page.close();
  return png;
}

try {
  for (const { file, size, variant } of OUT) {
    await writeFile(fileURLToPath(new URL(file, import.meta.url)), await render(variant, size));
    console.log(`${file}  ${size}×${size}  ${variant}`);
  }
  // .ico con PNG dentro (válido desde Windows Vista): cabecera, un
  // directorio de 16 bytes por tamaño, y las imágenes seguidas
  const pngs = await Promise.all(ICO_SIZES.map((s) => render('any', s)));
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((png, i) => {
    const s = ICO_SIZES[i];
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); // planos
    head.writeUInt16LE(32, e + 6); // bits por píxel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  await writeFile(
    fileURLToPath(new URL('../assets/icon.ico', import.meta.url)),
    Buffer.concat([head, ...pngs]),
  );
  console.log(`../assets/icon.ico  ${ICO_SIZES.join(', ')}`);
} finally {
  await browser.close();
}
