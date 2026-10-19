// Prueba de punta a punta de la INTERFAZ, a clics, sobre el index.html real
// (la otra, e2e-run.mts, prueba el pipeline por dentro). En un navegador y a
// un tamaño de ventana, hace lo que haría alguien que entra por primera vez:
//
//   ① el ejemplo de seis fotogramas → Generate sheets (el ZIP se descarga)
//   ② simular los escaneos de esas hojas → procesarlos
//   ③ guardar el video sin pérdida (MOV y ZIP de PNG) → verlo en la vista
//      previa de la página, que es como se ve en un teléfono
//
// En cada pantalla comprueba que nada se sale por la derecha (scroll
// horizontal: el fallo típico en un teléfono) y guarda una captura. El MOV
// descargado sale de la página y lo verifica el ffprobe de la máquina.
//
//   npm run test:ui                         Chrome, escritorio y móvil
//   npm run test:ui -- --browser=zen        Zen (o Firefox)
//   npm run test:ui -- --browser=safari     Safari
//
// Artefacto: artifacts/e2e/ui.<navegador>.json con cada comprobación, y las
// capturas en artifacts/e2e/ui/<navegador>-<ventana>/.
//
// Node lo ejecuta tal cual (type stripping): sólo sintaxis borrable.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Driver, Viewport } from './e2e-browsers.mts';
import { browserFromArgs, launch, serveDist } from './e2e-browsers.mts';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));
const ARTIFACT_DIR = fileURLToPath(new URL('../artifacts/e2e/', import.meta.url));
const which = browserFromArgs();
const VIEWPORTS: Record<string, Viewport> = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844, mobile: true },
};

/** Instrumentos de la prueba, dentro de la página: los clics por texto,
 *  las esperas con tope, los avisos (toasts) oídos al aparecer, y las
 *  descargas interceptadas en vez de abrir el diálogo del navegador. */
const INSTRUMENT = `
  if (window.__ui) return true;
  const toasts = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes)
      if (n.nodeType === 1) toasts.push(n.className + ': ' + n.textContent);
  }).observe(document.getElementById('toasts'), { childList: true });
  const downloads = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.hasAttribute('download')) return click.call(this);
    const name = this.getAttribute('download');
    fetch(this.href).then((r) => r.blob()).then((blob) => downloads.push({ name, blob }));
  };
  window.confirm = () => true;
  window.__ui = {
    toasts,
    downloads,
    button(re) {
      return [...document.querySelectorAll('button')].find(
        (b) => re.test(b.textContent) && b.offsetParent !== null,
      );
    },
    async until(fn, ms, what) {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('timed out: ' + what + ' | toasts: ' + toasts.join(' / '));
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    overflow() {
      return document.documentElement.scrollWidth - window.innerWidth;
    },
  };
  return true;
`;

/** Un paso: el cuerpo corre en la página, con `ui` a mano. */
function step(body: string): string {
  return `const ui = window.__ui; ${body}`;
}

/** Abre la aplicación en `view` y espera a que se monte. */
async function openApp(driver: Driver, port: number, view: string): Promise<void> {
  await driver.open(`http://127.0.0.1:${port}/#${view}`);
  await driver.run(`
    const t0 = Date.now();
    while (!document.querySelector('#view-${view} .paper')) {
      if (Date.now() - t0 > 30000) throw new Error('the page did not mount');
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;`);
  await driver.run(INSTRUMENT);
}

/** El botón de la fase ② que baja los recortes y el informe: devuelve el
 *  ZIP en base64, o el aviso de error si la página no pudo armarlo. */
const PROCESSED_ZIP = step(`
    const before = ui.downloads.length;
    const errs = ui.toasts.length;
    ui.button(/Download frames \\+ report/).click();
    const r = await ui.until(() => {
      const err = ui.toasts.slice(errs).find((t) => /Could not build the ZIP/.test(t));
      if (err) return { error: err };
      const d = ui.downloads.slice(before).find((x) => x.name === 'processed_frames.zip');
      return d && { blob: d.blob };
    }, 120000, 'the processed frames ZIP');
    if (r.error) return { error: r.error };
    const b64 = await new Promise((res, rej) => {
      const f = new FileReader();
      f.onload = () => res(String(f.result).split(',')[1] ?? '');
      f.onerror = () => rej(f.error);
      f.readAsDataURL(r.blob);
    });
    return { b64 };`);

/** Las carpetas de pestañas del disco privado (null si no hay). */
const TAB_FOLDERS = `
  try {
    const t = await (await navigator.storage.getDirectory()).getDirectoryHandle('tabs');
    const out = [];
    for await (const [name] of t.entries()) out.push(name);
    return out;
  } catch { return null; }`;

/** Espera a que termine el barrido de la página recién abierta (main.ts
 *  marca <html data-storage-swept>), sin plazos fijos. */
const UNTIL_SWEPT = `
  const t0 = Date.now();
  while (document.documentElement.dataset.storageSwept !== '1') {
    if (Date.now() - t0 > 30000) throw new Error('the storage sweep did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }`;

/** Lo que hay dentro de la carpeta de la pestaña `id`, recursivo ([] si ya
 *  no existe). */
const FOLDER_OF = (id: string): string => `
  const walk = async (d, pre) => { const o = []; for await (const [n, h] of d.entries()) { o.push(pre + n + (h.kind === 'directory' ? '/' : '')); if (h.kind === 'directory') o.push(...await walk(h, pre + n + '/')); } return o; };
  try {
    const t = await (await navigator.storage.getDirectory()).getDirectoryHandle('tabs');
    return await walk(await t.getDirectoryHandle(${JSON.stringify(id)}), '');
  } catch { return []; }`;

/** Lo que trae un ZIP de recortes, leído con el `unzip` de la máquina (que
 *  además comprueba el CRC de cada entrada): el SHA-256 y el tamaño de cada
 *  PNG de frames/, y el informe. */
interface ProcessedZip {
  crcOk: boolean;
  frames: Record<string, { sha256: string; width: number; height: number }>;
  extracted: number;
}

async function readProcessedZip(b64: string): Promise<ProcessedZip> {
  const dir = await mkdtemp(join(tmpdir(), 'mxm-zip-'));
  try {
    const zip = join(dir, 'p.zip');
    await writeFile(zip, Buffer.from(b64, 'base64'));
    const crcOk = spawnSync('unzip', ['-tq', zip]).status === 0;
    spawnSync('unzip', ['-q', '-o', zip, '-d', join(dir, 'x')]);
    const frames: ProcessedZip['frames'] = {};
    const names = await readdir(join(dir, 'x', 'frames')).catch(() => [] as string[]);
    for (const n of names.sort()) {
      const png = await readFile(join(dir, 'x', 'frames', n));
      // IHDR: ancho y alto, big-endian, justo después de la firma
      frames[n] = {
        sha256: createHash('sha256').update(png).digest('hex'),
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
      };
    }
    const informe = JSON.parse(
      await readFile(join(dir, 'x', 'informe.json'), 'utf8').catch(() => '{}'),
    ) as { frames_extraidos?: number };
    return { crcOk, frames, extracted: informe.frames_extraidos ?? -1 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Los archivos de un ZIP en base64: ruta dentro del ZIP → bytes (unzip de
 *  la máquina). */
async function unzipAll(b64: string): Promise<Map<string, Buffer>> {
  const dir = await mkdtemp(join(tmpdir(), 'mxm-zip-'));
  try {
    const zip = join(dir, 'z.zip');
    await writeFile(zip, Buffer.from(b64, 'base64'));
    spawnSync('unzip', ['-q', '-o', zip, '-d', join(dir, 'x')]);
    const out = new Map<string, Buffer>();
    const names = await readdir(join(dir, 'x'), { recursive: true }).catch(() => [] as string[]);
    for (const n of names.sort()) {
      const f = join(dir, 'x', n);
      if ((await stat(f)).isFile()) out.set(n, await readFile(f));
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** El sonido de la prueba de los huecos: un WAV de 16 bits estéreo a 44,1 kHz
 *  de ruido pseudoaleatorio, que no se repite en ningún desplazamiento, así
 *  que una muestra corrida de sitio no puede coincidir por casualidad. */
const GAP_RATE = 44100;
function noiseWav(seconds: number): Buffer {
  const n = Math.round(seconds * GAP_RATE);
  const data = Buffer.alloc(n * 4);
  let x = 0x2545f491;
  for (let i = 0; i < n * 2; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    data.writeInt16LE(((x >>> 8) % 40000) - 20000, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(GAP_RATE, 24);
  h.writeUInt32LE(GAP_RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Las muestras (estéreo entrelazado) del bloque 'data' de un WAV. */
function wavSamples(wav: Buffer | undefined): Int16Array | null {
  if (wav?.toString('latin1', 0, 4) !== 'RIFF') return null;
  let o = 12;
  while (o + 8 <= wav.length) {
    const id = wav.toString('latin1', o, o + 4);
    const size = wav.readUInt32LE(o + 4);
    if (id === 'data') {
      const d = wav.subarray(o + 8, o + 8 + size);
      return new Int16Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

async function runFlow(
  driver: Driver,
  port: number,
  shots: string,
  tabs: boolean,
): Promise<{ checks: Check[]; mov: Buffer | null; mp4: Buffer | null }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
  };
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(shots, `${name}.png`), await driver.screenshot());
  };
  /** Pantalla: navega, espera a que se monte, mide y captura. */
  const screen = async (view: string): Promise<void> => {
    await driver.run(
      step(
        `location.hash = '#${view}'; await new Promise((r) => setTimeout(r, 600)); return true;`,
      ),
    );
    const over = await driver.run<number>(step('return ui.overflow();'));
    check(`${view}: no sideways scroll`, over <= 0, `${over} px wider than the window`);
    await shot(view);
  };

  await openApp(driver, port, 'sheets');
  const width = await driver.run<number>('return window.innerWidth;');
  check('window', true, `${width} px wide`);
  await screen('sheets');

  // ① el ejemplo y sus hojas
  const sheets = await driver.run<string>(
    step(`
    ui.button(/example/).click();
    await ui.until(() => ui.toasts.some((t) => /example frames ready/.test(t)), 60000, 'the example');
    ui.button(/Generate sheets/).click();
    const zip = await ui.until(() => ui.downloads.find((d) => /\\.zip$/.test(d.name)), 180000, 'the sheets ZIP');
    return zip.name + ' ' + zip.blob.size + ' bytes';`),
  );
  check('sheets generated and downloaded', /\.zip \d+ bytes$/.test(sheets), sheets);
  await shot('sheets-done');

  // ② escaneos simulados y procesados
  await screen('scans');
  const scans = await driver.run<string>(
    step(`
    ui.button(/Simulate them/).click();
    await ui.until(() => ui.toasts.some((t) => /Processing finished/.test(t)), 240000, 'processing the scans');
    return ui.toasts.filter((t) => /simulated scan|Processing finished/.test(t)).join(' / ');`),
  );
  check('scans simulated and processed', /Processing finished/.test(scans), scans);
  await shot('scans-done');

  // ②b las miniaturas del informe son pequeñas (el núcleo las hace aparte):
  // con los recortes enteros detrás, cientos de MB, Safari se congelaba al
  // desplazar el informe. Un clic sigue abriendo el recorte a tamaño real.
  const thumbs = await driver.run<{
    n: number;
    maxSide: number;
    blank: number;
    full: number;
    closed: boolean;
  }>(
    step(`
    const imgs = [...document.querySelectorAll('#view-scans .report-thumbs img')];
    await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
    const maxSide = Math.max(0, ...imgs.map((i) => Math.max(i.naturalWidth, i.naturalHeight)));
    const blank = imgs.filter((i) => !i.naturalWidth).length;
    const frame = [...document.querySelectorAll('#view-scans .report-thumbs .thumb')]
      .find((t) => t.querySelector('.tag')?.textContent !== 'alignment');
    frame.click();
    const big = await ui.until(() => {
      const i = document.querySelector('.lightbox img');
      return i?.complete && i.naturalWidth ? i : null;
    }, 15000, 'the full-size frame');
    const full = big.naturalWidth;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await ui.until(() => !document.querySelector('.lightbox'), 5000, 'the lightbox closing');
    return { n: imgs.length, maxSide, blank, full, closed: true };`),
  );
  check(
    'report thumbnails are small and the click opens the full frame',
    thumbs.n > 0 &&
      thumbs.blank === 0 &&
      thumbs.maxSide > 0 &&
      thumbs.maxSide <= 240 &&
      thumbs.full > 240 &&
      thumbs.closed,
    `${thumbs.n} thumbnails, largest side ${thumbs.maxSide} px, ${thumbs.blank} without pixels; full frame ${thumbs.full} px wide`,
  );

  // ②a sólo con el agente de un teléfono (Chrome emula Android): un escaneo
  // demasiado pesado para un teléfono pregunta antes, y un "no" no borra
  // nada. "Reprocess" vaciaba el informe ANTES de preguntar. El escaneo es
  // sólo una cabecera PNG de 10000×14000 a 16 bits.
  if (!tabs) {
    const phone = await driver.run<{ skipped?: string; asked?: number; toasts?: string }>(
      step(`
      const uad = navigator.userAgentData;
      if (!(uad?.mobile || /Android|iPhone|iPad/.test(navigator.userAgent)))
        return { skipped: 'no phone user agent in this browser' };
      const asked = [];
      window.confirm = (m) => { asked.push(m); return false; };
      try {
        const png = new Uint8Array(64);
        png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
        new DataView(png.buffer).setUint32(16, 10000);
        new DataView(png.buffer).setUint32(20, 14000);
        png[24] = 16;
        png[25] = 2;
        const input = document.querySelector('#view-scans input[type=file][accept^=".tif"]');
        const dt = new DataTransfer();
        dt.items.add(new File([png], 'too-heavy.png', { type: 'image/png' }));
        input.files = dt.files;
        const n = ui.toasts.length;
        input.dispatchEvent(new Event('change'));
        await ui.until(() => ui.toasts.slice(n).some((t) => /Not processed/.test(t)), 30000, 'the question on a new scan');
        ui.button(/Reprocess the/).click();
        await ui.until(() => ui.toasts.slice(n).some((t) => /Not reprocessed/.test(t)), 30000, 'the question on Reprocess');
        return { asked: asked.length, toasts: ui.toasts.slice(n).join(' / ') };
      } finally {
        window.confirm = () => true;
      }`),
    );
    if (phone.skipped) {
      check('phone: heavy scan asks first', true, `skipped: ${phone.skipped}`);
    } else {
      const zip = await driver.run<{ b64?: string; error?: string }>(PROCESSED_ZIP);
      const kept = zip.b64 ? await readProcessedZip(zip.b64) : null;
      const n = Object.keys(kept?.frames ?? {}).length;
      check(
        'phone: heavy scan asks first, and a "no" keeps the report',
        phone.asked === 2 && n === 6,
        zip.error ?? `${phone.asked} question(s), ${n} frames still in the report: ${phone.toasts}`,
      );
    }
  }

  // ②b la aplicación abierta en OTRA pestaña a la vez, que es como alguien
  // trabaja (una para cada proyecto, o la misma recargada): el disco privado
  // del navegador es del origen, y abrir la fase ② en otra pestaña, procesar
  // ahí y vaciar su informe borraba los recortes de ésta. Su ZIP fallaba con
  // "NotFoundError: A requested file or directory could not be found…"
  // (Opera, Chrome), "The object cannot be found here." (Safari) o
  // "AbortError" (Firefox). La otra pestaña hace su propio proyecto con otro
  // margen, se cierra, se abre una tercera (que barre lo que dejó la cerrada),
  // y esta pestaña tiene que seguir bajando EXACTAMENTE los mismos recortes.
  if (tabs) {
    const first = await driver.run<{ b64?: string; error?: string }>(PROCESSED_ZIP);
    const zipA1 = first.b64 ? await readProcessedZip(first.b64) : null;
    const nA = Object.keys(zipA1?.frames ?? {}).length;
    check(
      'tab A: frames ZIP before another tab opens',
      !!zipA1 && zipA1.crcOk && nA === 6 && zipA1.extracted === 6,
      first.error ??
        `${nA} frames, CRC ${zipA1?.crcOk ? 'ok' : 'BAD'}, report says ${zipA1?.extracted}`,
    );
    // las carpetas de pestañas que hay en el disco privado ahora: la que
    // aparezca después es la de la pestaña B
    const before = await driver.run<string[] | null>(TAB_FOLDERS);
    const tabB = await driver.newTab();
    await openApp(tabB, port, 'sheets');
    const b = await tabB.run<string>(
      step(`
      ui.button(/example/).click();
      await ui.until(() => ui.toasts.some((t) => /example frames ready/.test(t)), 60000, 'the example in tab B');
      ui.button(/Generate sheets/).click();
      await ui.until(() => ui.downloads.find((d) => /\\.zip$/.test(d.name)), 180000, 'the sheets ZIP in tab B');
      location.hash = '#scans';
      await ui.until(() => document.querySelector('#view-scans .paper'), 30000, 'phase 2 in tab B');
      const bleed = [...document.querySelectorAll('#view-scans label.field')].find((l) => /Bleed/.test(l.textContent)).querySelector('input');
      bleed.value = '4';
      bleed.dispatchEvent(new Event('input'));
      bleed.dispatchEvent(new Event('change'));
      ui.button(/Simulate them/).click();
      await ui.until(() => ui.toasts.some((t) => /Processing finished/.test(t)), 240000, 'processing in tab B');
      return 'processed';`),
    );
    const second = await tabB.run<{ b64?: string; error?: string }>(PROCESSED_ZIP);
    const zipB = second.b64 ? await readProcessedZip(second.b64) : null;
    const nB = Object.keys(zipB?.frames ?? {}).length;
    // otro margen, otros recortes: si las dos pestañas compartieran archivos,
    // aquí se vería
    const sameAsA = Object.entries(zipB?.frames ?? {}).filter(
      ([n, f]) => zipA1?.frames[n]?.sha256 === f.sha256,
    ).length;
    check(
      'tab B: its own project, 4 % bleed, its own frames',
      b === 'processed' && !!zipB && zipB.crcOk && nB === 6 && sameAsA === 0,
      second.error ?? `${nB} frames, ${sameAsA} identical to tab A's`,
    );
    // B vacía su informe (en la versión anterior eso borraba los recortes de
    // A) y procesa otra vez: se cierra con recortes en el disco
    const again = await tabB.run<string>(
      step(`
      const n = ui.toasts.length;
      ui.button(/Clear results/).click();
      await new Promise((r) => setTimeout(r, 500));
      (ui.button(/Simulate them/) ?? ui.button(/Reprocess the/)).click();
      await ui.until(() => ui.toasts.slice(n).some((t) => /Processing finished/.test(t)), 240000, 'processing again in tab B');
      return 'processed again';`),
    );
    const after = await driver.run<string[] | null>(TAB_FOLDERS);
    const idB = (after ?? []).find((f) => !(before ?? []).includes(f)) ?? '';
    await tabB.close();
    // sin disco privado (Safari antiguo, modo privado) todo va a memoria y
    // no hay carpetas que mirar; con él, tiene que haberlas
    const opfs = await driver.run<boolean>(
      `return !!navigator.storage?.getDirectory && typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype && !!navigator.locks;`,
    );
    // una página en la caché de atrás/adelante, simulada: una carpeta con
    // recortes y una señal de vida reciente, sin candado (Safari 26 lo
    // suelta) y sin la marca de cierre que deja una pestaña que se cierra
    if (opfs)
      await driver.run(`
        const t = await (await navigator.storage.getDirectory()).getDirectoryHandle('tabs');
        const d = await t.getDirectoryHandle('cached-page', { create: true });
        const write = async (dir, name) => { const w = await (await dir.getFileHandle(name, { create: true })).createWritable(); await w.write(new Uint8Array([1])); await w.close(); };
        await write(await d.getDirectoryHandle('processed-0', { create: true }), '1-video_001.png');
        await write(d, 'alive');
        return true;`);
    // C se abre y barre: B se cerró (dejó su marca) y se vacía en el acto;
    // la página "en la caché" se queda
    const tabC = await driver.newTab();
    await openApp(tabC, port, 'scans');
    const afterC = {
      b: await tabC.run<string[]>(`${UNTIL_SWEPT} ${FOLDER_OF(idB)}`),
      cached: await tabC.run<string[]>(FOLDER_OF('cached-page')),
    };
    const outputs = (l: string[]): string => {
      const other = l.filter((f) => !f.startsWith('out/'));
      return other.length
        ? `left: ${other.join(', ')}`
        : `${l.filter((f) => f.startsWith('out/') && f !== 'out/').length} recent output(s) kept, nothing else`;
    };
    check(
      'a closed tab leaves no frames on disk',
      again === 'processed again' &&
        (opfs ? !!idB && afterC.b.every((f) => f.startsWith('out/')) : !idB),
      opfs
        ? `tab B's folder: ${outputs(afterC.b)}`
        : 'no private disk in this browser: frames stay in memory',
    );
    check(
      'a page that may be in the back/forward cache (recent sign of life, no lock) is kept',
      !opfs || afterC.cached.includes('processed-0/1-video_001.png'),
      opfs ? `${afterC.cached.length} entries kept` : 'no private disk in this browser',
    );
    // una hora más tarde (se borra su señal de vida): la siguiente pestaña
    // que se abre la vacía
    let cachedLater: string[] = [];
    if (opfs) {
      await tabC.run(
        `const t = await (await navigator.storage.getDirectory()).getDirectoryHandle('tabs'); await (await t.getDirectoryHandle('cached-page')).removeEntry('alive'); return true;`,
      );
      const tabD = await driver.newTab();
      await openApp(tabD, port, 'sheets');
      cachedLater = await tabD.run<string[]>(`${UNTIL_SWEPT} ${FOLDER_OF('cached-page')}`);
      await tabD.close();
    }
    check(
      'once its sign of life is an hour old, it is swept',
      !opfs || cachedLater.length === 0,
      opfs
        ? cachedLater.length
          ? `left: ${cachedLater.join(', ')}`
          : 'gone'
        : 'no private disk in this browser',
    );
    const third = await driver.run<{ b64?: string; error?: string }>(PROCESSED_ZIP);
    const zipA2 = third.b64 ? await readProcessedZip(third.b64) : null;
    const changed = Object.keys(zipA1?.frames ?? {}).filter(
      (n) => zipA2?.frames[n]?.sha256 !== zipA1?.frames[n]?.sha256,
    );
    check(
      'tab A: same frames ZIP after tabs B and C',
      !!zipA2 && zipA2.crcOk && changed.length === 0 && Object.keys(zipA2.frames).length === 6,
      third.error ??
        (changed.length ? `changed: ${changed.join(', ')}` : '6 frames, byte for byte the same'),
    );
    await writeFile(
      join(shots, 'tabs.json'),
      `${JSON.stringify({ tabA: zipA1?.frames, tabB: zipB?.frames, tabAAfter: zipA2?.frames }, null, 2)}\n`,
    );
    await tabC.close();
  }

  // ③ el video sin pérdida: MOV, ZIP de PNG, y la vista previa
  await screen('video');
  const plan = await driver.run<string>(
    step(`
    return await ui.until(() => {
      const t = [...document.querySelectorAll('#view-video .hint')].map((h) => h.textContent).find((x) => /^Lossless:/.test(x));
      return t;
    }, 60000, 'the output plan');`),
  );
  // los recortes de la fase ② salen todos del mismo tamaño: se copian tal cual
  check(
    'video plan: lossless, every drawing copied as it is',
    /every drawing is copied as it is/.test(plan),
    plan,
  );
  const mov = await driver.run<string>(
    step(`
    ui.button(/Save the video/).click();
    const d = await ui.until(() => ui.downloads.find((x) => /\\.mov$/.test(x.name)), 180000, 'the MOV');
    await ui.until(() => ui.toasts.some((t) => /Lossless MOV saved/.test(t)), 30000, 'the saved toast');
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] ?? '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(d.blob);
    });`),
  );
  const movBytes = Buffer.from(mov, 'base64');
  check('MOV saved', movBytes.length > 1000, `${movBytes.length} bytes`);
  const frames = await driver.run<string>(
    step(`
    const sel = [...document.querySelectorAll('#view-video select')].find((s) => [...s.options].some((o) => o.value === 'frames'));
    sel.value = 'frames';
    sel.dispatchEvent(new Event('change'));
    const before = ui.downloads.length;
    ui.button(/Save the video/).click();
    const d = await ui.until(() => ui.downloads.slice(before).find((x) => /\\.zip$/.test(x.name)), 180000, 'the frames ZIP');
    return d.name + ' ' + d.blob.size + ' bytes';`),
  );
  check('PNG frames ZIP saved', /\.zip \d+ bytes$/.test(frames), frames);
  // el MP4 comprimido: la calidad sólo aparece con MP4, el bitrate sólo con
  // "Fixed bitrate", y se guarda con el preset elegido
  const mp4 = await driver.run<{
    hiddenBefore: boolean;
    mbpsHiddenOnPreset: boolean;
    mbpsShownOnFixed: boolean;
    plan: string;
    b64: string;
    toast: string;
  }>(
    step(`
    const sels = [...document.querySelectorAll('#view-video select')];
    const kind = sels.find((s) => [...s.options].some((o) => o.value === 'mp4'));
    const quality = sels.find((s) => [...s.options].some((o) => o.value === 'compact'));
    const mbps = [...document.querySelectorAll('#view-video label.field')].find((l) => /Bitrate \\(Mbps\\)/.test(l.textContent));
    // lo que se VE en la página, no la propiedad: una regla de CSS puede
    // pisar el atributo hidden (lo hizo) y la propiedad seguiría diciendo true
    const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';
    const qf = quality.closest('label');
    const hiddenBefore = !shown(qf) && !shown(mbps);
    kind.value = 'mp4';
    kind.dispatchEvent(new Event('change'));
    const mbpsHiddenOnPreset = shown(qf) && !shown(mbps);
    quality.value = 'custom';
    quality.dispatchEvent(new Event('change'));
    const mbpsShownOnFixed = shown(mbps);
    quality.value = 'high';
    quality.dispatchEvent(new Event('change'));
    const plan = await ui.until(() => [...document.querySelectorAll('#view-video .hint')].map((h) => h.textContent).find((x) => /^Compressed MP4/.test(x)), 30000, 'the MP4 plan');
    const before = ui.downloads.length;
    ui.button(/Save the video/).click();
    const d = await ui.until(() => ui.downloads.length > before && ui.downloads.find((x) => /\\.mp4$/.test(x.name)), 180000, 'the MP4');
    const toast = await ui.until(() => ui.toasts.find((t) => /MP4 saved/.test(t)), 30000, 'the MP4 toast');
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] ?? '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(d.blob);
    });
    return { hiddenBefore, mbpsHiddenOnPreset, mbpsShownOnFixed, plan, b64, toast };`),
  );
  check(
    'MP4 options appear only when they apply',
    mp4.hiddenBefore && mp4.mbpsHiddenOnPreset && mp4.mbpsShownOnFixed,
    `quality hidden for lossless: ${mp4.hiddenBefore}; bitrate hidden on a preset: ${mp4.mbpsHiddenOnPreset}; bitrate shown on Fixed: ${mp4.mbpsShownOnFixed}`,
  );
  check('MP4 plan shown', /Compressed MP4/.test(mp4.plan), mp4.plan);
  check('MP4 saved', /MP4 saved/.test(mp4.toast), mp4.toast);
  await screen('video');
  const preview = await driver.run<string>(
    step(`
    const play = await ui.until(() => {
      const b = document.querySelector('#view-video .player button');
      return b && !b.disabled && b;
    }, 60000, 'the preview');
    play.click();
    await new Promise((r) => setTimeout(r, 1500));
    return document.querySelector('#view-video .player-info').textContent;`),
  );
  const at = Number(/^(\d+) \//.exec(preview)?.[1] ?? 0);
  check('preview plays in the page', at > 1, preview);
  await shot('video-done');

  // ③b fotogramas que faltan, como los deja Kami cuando duplica uno para
  // recortarlo y ponerlo encima de otro: el layout de las hojas con cinco
  // posiciones más sin dibujo (la primera, la última, y dos seguidas del
  // mismo duplicado), a 24 fps desde 0,25 s, y como sonido un WAV soltado
  // aquí. Se guarda el ZIP de PNG en los tres modos, y el sonido de cada uno
  // se compara muestra a muestra con el WAV de origen
  const sheetsZip = await driver.run<string>(
    step(`
    const d = ui.downloads.find((x) => /.zip$/.test(x.name));
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] ?? '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(d.blob);
    });`),
  );
  const sheetLayout = JSON.parse(
    [...(await unzipAll(sheetsZip))]
      .find(([n]) => n.endsWith('layout.json'))?.[1]
      .toString('utf8') ?? '{}',
  ) as { timeline?: { pos: number; etiqueta: string; rep: string }[]; video?: object };
  const drawn = [...(sheetLayout.timeline ?? [])].sort((a, b) => a.pos - b.pos);
  if (drawn.length !== 6)
    throw new Error(`the sheets' layout.json has ${drawn.length} timeline positions, not 6`);
  const gap = (etiqueta: string, rep = etiqueta) => ({ etiqueta, rep });
  // la posición i de la línea de tiempo: un dibujo de las hojas o un hueco
  const slots = [
    gap('dup_a'),
    drawn[0],
    gap('dup_b'),
    drawn[1],
    drawn[2],
    gap('dup_c1', 'dup_c'),
    gap('dup_c2', 'dup_c'),
    drawn[3],
    drawn[4],
    drawn[5],
    gap('dup_d'),
  ];
  const keep: [number, number][] = [
    [1, 2],
    [3, 5],
    [7, 10],
  ];
  const GAP_FPS = 24;
  const GAP_START = 0.25;
  const gapLayout = {
    ...sheetLayout,
    timeline: slots.map((t, i) => ({ pos: i + 1, etiqueta: t?.etiqueta, rep: t?.rep })),
    video: { ...sheetLayout.video, fps_extraccion: GAP_FPS, inicio_s: GAP_START },
  };
  const source = noiseWav(GAP_START + slots.length / GAP_FPS + 0.3);
  await writeFile(join(shots, 'gaps-source.wav'), source);
  const gaps = await driver.run<{
    shown: boolean;
    cutOffWhileHolding: boolean;
    plans: string[];
    asked: string[];
    zips: string[];
    mp4: string;
    preview: string;
  }>(
    step(`
    const b64 = (blob) => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] ?? '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
    const drop = (sel, file) => {
      const input = [...document.querySelectorAll('#view-video input[type=file]')].find((i) => i.accept.startsWith(sel));
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    };
    const asked = [];
    window.confirm = (m) => { asked.push(m); return true; };
    const wav = Uint8Array.from(atob(${JSON.stringify(source.toString('base64'))}), (c) => c.charCodeAt(0));
    drop('video/*,audio/*', new File([wav], 'edited-sound.wav', { type: 'audio/wav' }));
    drop('.json', new File([${JSON.stringify(JSON.stringify(gapLayout))}], 'layout.json', { type: 'application/json' }));
    const fps = [...document.querySelectorAll('#view-video input[type=number]')][0];
    await ui.until(() => fps.value === '${GAP_FPS}', 10000, 'the fps of the dropped layout');
    const gap = [...document.querySelectorAll('#view-video select')].find((s) => [...s.options].some((o) => o.value === 'hold'));
    // viene en saltar con su sonido
    const shown = gap.getClientRects().length > 0 && gap.value === 'cut';
    const pick = (v) => {
      gap.value = v;
      gap.dispatchEvent(new Event('change'));
    };
    const kind = [...document.querySelectorAll('#view-video select')].find((s) => [...s.options].some((o) => o.value === 'frames'));
    const planText = (n) => ui.until(() => [...document.querySelectorAll('#view-video .hint')].map((h) => h.textContent).find((x) => new RegExp('^Lossless: .*, ' + n + ' frames;').test(x)), 30000, 'the plan with ' + n + ' frames');
    const save = async (ext) => {
      const before = ui.downloads.length;
      ui.button(/Save the video/).click();
      const d = await ui.until(() => ui.downloads.slice(before).find((x) => x.name.endsWith(ext)), 180000, 'the ' + ext);
      await ui.until(() => !ui.button(/Save the video/).disabled, 30000, 'the export to finish');
      return await b64(d.blob);
    };
    kind.value = 'frames';
    kind.dispatchEvent(new Event('change'));
    pick('hold');
    const plans = [await planText(${slots.length})];
    const zips = [await save('.zip')];
    pick('cut');
    plans.push(await planText(6));
    zips.push(await save('.zip'));
    pick('keep');
    zips.push(await save('.zip'));
    pick('cut');
    kind.value = 'mp4';
    kind.dispatchEvent(new Event('change'));
    const mp4 = await save('.mp4');
    // la vista previa con los saltos: llega al final, con el sonido saltando
    ui.button(/^Preview$/).click();
    const play = await ui.until(() => {
      const b = document.querySelector('#view-video .player button');
      return b && !b.disabled && b;
    }, 60000, 'the preview with gaps');
    play.click();
    const preview = await ui.until(() => {
      const t = document.querySelector('#view-video .player-info').textContent;
      return play.textContent === 'Play' && /^6 \\/ 6/.test(t) && t;
    }, 15000, 'the preview to reach its last frame');
    window.confirm = () => true;
    return { shown, plans, asked, zips, mp4, preview };`),
  );
  check(
    'missing frames: the choice appears, on skipping with the sound',
    gaps.shown,
    `shown: ${gaps.shown}`,
  );
  check(
    'missing frames: the plan counts the held frames, then only the kept ones',
    gaps.plans.length === 2,
    gaps.plans.join(' | '),
  );
  check(
    'missing frames: each save asks first',
    gaps.asked.length === 4 && gaps.asked.every((q) => q === 'Frames missing: 5. Continue?'),
    gaps.asked.join(' | '),
  );
  const [held, cutZip, straightZip] = await Promise.all(gaps.zips.map(unzipAll));
  const pngSha = (z: Map<string, Buffer>): string[] =>
    [...z.entries()]
      .filter(([n]) => n.endsWith('.png'))
      .map(([, b]) => createHash('sha256').update(b).digest('hex').slice(0, 12));
  const heldSha = pngSha(held);
  const keptSha = pngSha(cutZip);
  // retenido: cada hueco repite el dibujo de antes; el primero, el primero
  const want = [1, 1, 1, 3, 4, 4, 4, 7, 8, 9, 9].map((i) => keptSha[[1, 3, 4, 7, 8, 9].indexOf(i)]);
  check(
    'holding: 11 frames, every gap shows the drawing before it',
    heldSha.length === 11 && new Set(keptSha).size === 6 && heldSha.join() === want.join(),
    `held ${heldSha.length}: ${heldSha.join(' ')}`,
  );
  check(
    'skipping: the 6 drawn frames, in order, in both sound modes',
    keptSha.length === 6 && pngSha(straightZip).join() === keptSha.join(),
    `kept: ${keptSha.join(' ')}`,
  );
  // el sonido: la posición p del tramo empieza en la muestra round(p · rate / fps)
  const src = wavSamples(source) ?? new Int16Array();
  const off = Math.round(GAP_START * GAP_RATE);
  const sampleAt = (p: number): number => Math.round((p * GAP_RATE) / GAP_FPS);
  const sameAs = (got: Int16Array | null, from: number, frames: number): string => {
    if (!got) return 'no WAV';
    if (got.length !== sampleAt(frames) * 2)
      return `${got.length / 2} samples, want ${sampleAt(frames)}`;
    for (let i = 0; i < got.length; i++)
      if (got[i] !== src[from * 2 + i]) return `differs at sample ${i >> 1}`;
    return 'same';
  };
  const wavOf = (z: Map<string, Buffer>) =>
    wavSamples([...z.entries()].find(([n]) => n.endsWith('.wav'))?.[1]);
  const heldSound = sameAs(wavOf(held), off, slots.length);
  check(
    'holding: the sound is the source from 0.25 s, sample for sample, for all 11 positions',
    heldSound === 'same',
    heldSound,
  );
  const straight = sameAs(wavOf(straightZip), off, 6);
  check(
    'skipping, sound straight through: the source from 0.25 s, uncut, as long as the 6 frames',
    straight === 'same',
    straight,
  );
  // cortado: fuera de cada empalme, cada muestra es la de su dibujo en el
  // original; dentro, queda entre la que seguía (la que se quita) y la nueva
  const cutSound = wavOf(cutZip);
  let cutDetail = cutSound ? '' : 'no WAV';
  const fades: number[] = [];
  if (cutSound) {
    if (cutSound.length !== sampleAt(6) * 2)
      cutDetail = `${cutSound.length / 2} samples, want ${sampleAt(6)}`;
    let k = 0;
    let prevEnd = -1;
    for (const [a, b] of keep) {
      const dst = sampleAt(k);
      const len = sampleAt(k + b - a) - dst;
      const from = off + sampleAt(a);
      let fade = 0;
      for (let i = 0; i < len && !cutDetail; i++) {
        for (let c = 0; c < 2; c++) {
          const got = cutSound[(dst + i) * 2 + c];
          const own = src[(from + i) * 2 + c];
          if (got === own) continue;
          const left = prevEnd >= 0 ? src[(prevEnd + i) * 2 + c] : own;
          if (
            prevEnd >= 0 &&
            i < GAP_RATE * 0.01 &&
            got >= Math.min(left, own) - 1 &&
            got <= Math.max(left, own) + 1
          )
            fade = i + 1;
          else
            cutDetail = `sample ${dst + i} (piece ${a}–${b}, ${i} in) is ${got}, its own is ${own}`;
        }
      }
      fades.push(fade);
      prevEnd = from + len;
      k += b - a;
    }
  }
  check(
    'skipping, sound cut: every drawing keeps its own sound, joined by a crossfade of ≤ 5 ms',
    !cutDetail &&
      fades[0] === 0 &&
      fades.slice(1).every((f) => f > 0 && f <= Math.round(GAP_RATE * 0.005)),
    cutDetail ||
      `${cutSound ? cutSound.length / 2 : 0} samples (${sampleAt(6)} wanted); crossfade at each join: ${fades.slice(1).join(', ')} samples`,
  );
  const mp4File = join(shots, 'gaps.mp4');
  await writeFile(mp4File, Buffer.from(gaps.mp4, 'base64'));
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,nb_read_frames',
      '-of',
      'json',
      mp4File,
    ],
    { encoding: 'utf8' },
  );
  const streams =
    (JSON.parse(probe.stdout || '{}') as { streams?: Record<string, string>[] }).streams ?? [];
  const vs = streams.find((x) => x.codec_type === 'video');
  // el AAC no guarda las muestras, pero se parece: su sonido, decodificado por
  // el ffmpeg de la máquina, tiene que parecerse al cortado y no al seguido
  // (los dos coinciden en el primer tramo; se compara desde el primer empalme)
  const dec = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      mp4File,
      '-map',
      '0:a:0',
      '-f',
      's16le',
      '-ac',
      '2',
      '-ar',
      String(GAP_RATE),
      '-',
    ],
    { maxBuffer: 1 << 26 },
  );
  const aac =
    dec.status === 0
      ? new Int16Array(
          dec.stdout.buffer.slice(dec.stdout.byteOffset, dec.stdout.byteOffset + dec.stdout.length),
        )
      : new Int16Array();
  /** La mejor correlación del canal 0 de `aac` con `ref` en [i0, i1), con el
   *  desfase que la da: el AAC empieza con su retardo de codificador (2112
   *  muestras con el de Chrome), que el ffmpeg de la máquina no quita. */
  const likeness = (
    ref: Int16Array | null | undefined,
    i0: number,
    i1: number,
  ): [number, number] => {
    let best: [number, number] = [-1, 0];
    if (!ref) return best;
    for (let lag = -512; lag <= 4096; lag++) {
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let i = i0; i < i1; i++) {
        const x = aac[(i + lag) * 2] ?? 0;
        const y = ref[i * 2] ?? 0;
        sab += x * y;
        saa += x * x;
        sbb += y * y;
      }
      const r = saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
      if (r > best[0]) best = [r, lag];
    }
    return best;
  };
  const i0 = sampleAt(1) + 200;
  const i1 = sampleAt(6) - 200;
  const [likeCut, lag] = likeness(cutSound, i0, i1);
  const [likeStraight] = likeness(wavOf(straightZip), i0, i1);
  const aacLen = aac.length / 2;
  check(
    'skipping, MP4: 6 frames, and its sound is the cut one, as long as they are',
    Number(vs?.nb_read_frames) === 6 &&
      likeCut > 0.5 &&
      likeCut - likeStraight > 0.3 &&
      Math.abs(aacLen - Math.abs(lag) - sampleAt(6)) <= 2048,
    `video ${vs?.nb_read_frames} frames; sound ${aacLen} samples (${sampleAt(6)} wanted, ${lag} of delay); ` +
      `like the cut sound ${likeCut.toFixed(3)}, like the uncut one ${likeStraight.toFixed(3)}`,
  );
  check('skipping: the preview plays to its last frame', !!gaps.preview, gaps.preview);
  await writeFile(
    join(shots, 'gaps.json'),
    `${JSON.stringify({ layoutTimeline: gapLayout.timeline, keep, held: heldSha, kept: keptSha, fades, mp4: { likeCut, likeStraight, lag, samples: aacLen }, asked: gaps.asked, plans: gaps.plans }, null, 2)}\n`,
  );
  await shot('video-gaps');

  // ④ la tira de grises en cianotipia, desde los clics: las hojas del
  // ejemplo como negativos con la tira, copiadas en azul con exposiciones,
  // papeles y escáneres distintos (la hoja 1 bien, la 2 subexpuesta, en papel
  // más cálido y con un escáner que tiñe). Activar la opción, cambiar la
  // copia de referencia y quitarla sólo recolorea los recortes ya hechos: la
  // copia de referencia queda byte a byte como se escaneó y las demás no.
  if (tabs) {
    await screen('sheets');
    // sin marcadores no se ofrecen QR ni tira; con las pocas hojas del
    // ejemplo, el QR tampoco
    const reg = await driver.run<{ off: string[]; on: string[] }>(
      step(`
      const label = (re) => [...document.querySelectorAll('#view-sheets label')].find((l) => re.test(l.textContent));
      const seen = () => [/^Markers/, /Add a QR code/, /Gray strip/].filter((re) => label(re)?.getClientRects().length).map(String);
      const box = label(/ArUco markers/).querySelector('input');
      if (!box.checked) box.click();
      await new Promise((r) => setTimeout(r, 300));
      const on = seen();
      box.click();
      await new Promise((r) => setTimeout(r, 300));
      const off = seen();
      box.click();
      await new Promise((r) => setTimeout(r, 300));
      return { off, on };`),
    );
    check(
      'registration: QR and gray strip only with the markers, and no QR for a few sheets',
      reg.off.length === 0 && reg.on.join() === [/^Markers/, /Gray strip/].map(String).join(),
      `markers off: ${reg.off.join(' ') || 'nothing'}; on: ${reg.on.join(' ')}`,
    );
    const negatives = await driver.run<string>(
      step(`
      const label = (re) => [...document.querySelectorAll('#view-sheets label')].find((l) => re.test(l.textContent));
      const box = (re) => label(re).querySelector('input[type=checkbox]');
      for (const [re, on] of [[/CYANOTYPE MODE/, true], [/Gray strip/, true]]) {
        const b = box(re);
        if (b.checked !== on) b.click();
      }
      // 2×2: los seis dibujos del ejemplo en dos hojas
      for (const re of [/^Columns/, /^Rows/]) {
        const i = label(re).querySelector('input');
        i.value = '2';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const before = ui.downloads.length;
      ui.button(/Generate sheets/).click();
      const zip = await ui.until(() => ui.downloads.slice(before).find((d) => /\\.zip$/.test(d.name)), 180000, 'the cyanotype sheets ZIP');
      return await new Promise((res, rej) => {
        const f = new FileReader();
        f.onload = () => res(String(f.result).split(',')[1] ?? '');
        f.onerror = () => rej(f.error);
        f.readAsDataURL(zip.blob);
      });`),
    );
    const sheetFiles = await unzipAll(negatives);
    const layoutBuf = [...sheetFiles].find(([n]) => /layout\.json$/.test(n))?.[1];
    const layoutCy = JSON.parse(layoutBuf?.toString('utf8') ?? '{}') as {
      parche_grises?: unknown;
      hojas?: { numero: number; frames?: Record<string, unknown> }[];
    };
    const pngs = [...sheetFiles]
      .filter(([n]) => /_p\d+\.png$/.test(n))
      .sort(([a], [b]) => a.localeCompare(b));
    const sheetOf = new Map<string, number>();
    for (const h of layoutCy.hojas ?? [])
      for (const et of Object.keys(h.frames ?? {})) sheetOf.set(`${et}.png`, h.numero);
    check(
      'cyanotype: every sheet carries the gray strip',
      !!layoutCy.parche_grises && pngs.length >= 2,
      `${pngs.length} negatives, strip ${layoutCy.parche_grises ? 'in the layout' : 'missing'}: ${pngs.map(([n]) => n).join(', ')}`,
    );
    await screen('scans');
    const strip = await driver.run<{
      error?: string;
      options?: string[];
      chosen?: string;
      onMs?: number;
      swapMs?: number;
      offMs?: number;
      notes?: string[];
      frames?: number;
      viewOn?: string[];
      viewOff?: string[];
      askedRef?: string;
      refHiddenOff?: boolean;
    }>(
      step(`
      const sheets = ${JSON.stringify(pngs.slice(0, 2).map(([n, b]) => [n, b.toString('base64')]))};
      // la copia: el negativo al derecho, su transparencia expone el azul
      const print = async ([name, b64], gamma, paper, blue, gain, off) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext('2d');
        x.translate(bmp.width, 0);
        x.scale(-1, 1);
        x.drawImage(bmp, 0, 0);
        bmp.close();
        const im = x.getImageData(0, 0, c.width, c.height);
        const d = im.data;
        for (let i = 0; i < d.length; i += 4) {
          const t = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
          const b = t ** gamma;
          for (let k = 0; k < 3; k++) d[i + k] = (paper[k] * (1 - b) + blue[k] * b) * gain[k] + off[k];
        }
        x.putImageData(im, 0, 0);
        const png = await c.convertToBlob({ type: 'image/png' });
        return new File([png], name.replace(/^.*\\//, '').replace(/\\.png$/, '_print.png'), { type: 'image/png' });
      };
      const files = [
        await print(sheets[0], 1, [245, 242, 230], [23, 49, 92], [1, 1, 1], [0, 0, 0]),
        await print(sheets[1], 1.6, [240, 230, 205], [23, 49, 92], [0.82, 0.78, 0.7], [28, 30, 22]),
      ];
      const n0 = ui.toasts.length;
      ui.button(/Clear results/)?.click();
      ui.button(/Use the current project layout/).click();
      const box = [...document.querySelectorAll('#view-scans label')].find((l) => /Normalize colours with the gray strip/.test(l.textContent)).querySelector('input');
      if (box.checked) box.click();
      const input = document.querySelector('#view-scans input[type=file][accept^=".tif"]');
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
      await ui.until(() => ui.toasts.slice(n0).some((t) => /Processing finished/.test(t)), 240000, 'processing the prints');
      const notes = () => [...document.querySelectorAll('#view-scans table.report td .hint')].map((h) => h.textContent);
      const scansIn = [...document.querySelectorAll('#view-scans table.report td.mono, #view-scans table.report td')].map((t) => t.textContent);
      const zip = async () => { ${PROCESSED_ZIP.replace(/^const ui = window.__ui; /, '')} };
      const sel = [...document.querySelectorAll('#view-scans label')].find((l) => /Reference print/.test(l.textContent)).querySelector('select');
      // con la opción apagada: el aviso pide activarla y elegir, y aún no hay selector
      const askedRef = ui.toasts.slice(n0).find((t) => /warn: Cyanotype prints: turn on/.test(t)) ?? '';
      const refHiddenOff = !sel.closest('label').getClientRects().length;
      const timed = async (act, done) => {
        const t0 = performance.now();
        act();
        await ui.until(done, 60000, 'the recolouring').catch((e) => {
          const rows = [...document.querySelectorAll('#view-scans table.report tr')].map((tr) => tr.textContent.slice(0, 160));
          throw new Error(e.message.split(' | ')[0] + ' | ref ' + sel?.value + ' | rows: ' + rows.join(' // '));
        });
        return Math.round(performance.now() - t0);
      };
      const raw = await zip();
      if (raw.error) return { error: raw.error };
      const onMs = await timed(() => box.click(), () => notes().some((n) => /Reference print./.test(n)) && notes().some((n) => /Matched to the reference/.test(n)));
      const options = [...sel.options].map((o) => o.textContent);
      const chosen = sel.value;
      // en el visor, «See original» sólo en la copia que cambia: para su
      // overlay y sus recortes, y muestra otra imagen
      const mean = (img) => {
        const c = new OffscreenCanvas(64, 64);
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0, 64, 64);
        const d = x.getImageData(0, 0, 64, 64).data;
        let r = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; b += d[i + 2]; }
        return Math.round(r / 4096) + '/' + Math.round(b / 4096);
      };
      const viewer = async () => {
        const out = [];
        for (const row of document.querySelectorAll('#view-scans .report-thumbs')) {
          for (const t of [...row.querySelectorAll('.thumb')].slice(0, 2)) {
            t.click();
            const lb = await ui.until(() => document.querySelector('.lightbox'), 5000, 'the viewer');
            const img = lb.querySelector('img');
            await img.decode();
            const btn = lb.querySelector('.lb-alt');
            const cap = lb.querySelector('figcaption').textContent.split(' · ')[0].split(':')[0];
            const kind = t.querySelector('.tag').textContent === 'alignment' ? 'alignment' : 'frame';
            if (btn.hidden) {
              out.push(cap + ' ' + kind + ' none');
            } else {
              const a = mean(img);
              const src = img.src;
              btn.click();
              await ui.until(() => img.src !== src, 5000, 'the raw image');
              await img.decode();
              out.push(cap + ' ' + kind + ' ' + a + '>' + mean(img) + ' ' + btn.getAttribute('aria-pressed'));
            }
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          }
        }
        return out;
      };
      const viewOn = await viewer();
      const on = await zip();
      const other = [...sel.options].find((o) => o.value !== chosen).value;
      const swapMs = await timed(() => { sel.value = other; sel.dispatchEvent(new Event('change')); },
        () => {
          const rows = [...document.querySelectorAll('#view-scans table.report tr')];
          // por la celda del escaneo: el selector de hoja de una fila nombra
          // también al otro escaneo ("already taken by …")
          const row = (scan) => rows.find((tr) => tr.cells[1]?.textContent === scan)?.textContent ?? '';
          return /Reference print./.test(row(other)) && /Matched to the reference/.test(row(chosen));
        });
      const swapped = await zip();
      const offMs = await timed(() => box.click(), () => !notes().some((n) => /Reference print.|Matched to the reference/.test(n)));
      const off = await zip();
      const viewOff = await viewer();
      return { askedRef, refHiddenOff, viewOn, viewOff, raw: raw.b64, on: on.b64, swapped: swapped.b64, off: off.b64, options, chosen, other, onMs, swapMs, offMs, notes: notes() };`),
    );
    if (strip.error) {
      check('cyanotype gray strip', false, strip.error);
    } else {
      const s = strip as unknown as Record<string, string> & typeof strip & { other: string };
      const [raw, on, swapped, off] = await Promise.all(
        [s.raw, s.on, s.swapped, s.off].map((b) => readProcessedZip(b)),
      );
      // número de hoja de cada copia, por su nombre en el selector ("sheet N · archivo")
      const sheetNum = (scan: string): number =>
        Number(/sheet (\d+)/.exec((s.options ?? []).find((o) => o.includes(scan)) ?? '')?.[1]);
      const same = (a: ProcessedZip, b: ProcessedZip, sheet: number): boolean[] =>
        Object.keys(b.frames)
          .filter((n) => sheetOf.get(n) === sheet)
          .map((n) => a.frames[n]?.sha256 === b.frames[n]?.sha256);
      const refA = sheetNum(s.chosen ?? '');
      const refB = sheetNum(s.other);
      const onRef = same(on, raw, refA);
      const onOther = same(on, raw, refB);
      const swRef = same(swapped, raw, refB);
      const swOther = same(swapped, raw, refA);
      const offAll = [...same(off, raw, refA), ...same(off, raw, refB)];
      check(
        'cyanotype strip: after scanning, a notice asks to turn it on and choose the reference',
        !!s.askedRef && s.refHiddenOff === true,
        `${s.askedRef}; reference field hidden while off: ${s.refHiddenOff}`,
      );
      check(
        'cyanotype strip: reference defaults to the lowest sheet, both prints offered',
        refA === 1 && (s.options ?? []).length === 2,
        `reference sheet ${refA}; options ${(s.options ?? []).join(' | ')}`,
      );
      check(
        'cyanotype strip on: the reference keeps its scanned frames, the other print is recoloured',
        onRef.length > 0 && onRef.every(Boolean) && onOther.length > 0 && !onOther.some(Boolean),
        `${onRef.filter(Boolean).length}/${onRef.length} reference frames untouched, ${onOther.filter((x) => !x).length}/${onOther.length} of the other recoloured, in ${s.onMs} ms`,
      );
      check(
        'cyanotype strip: choosing the other print as reference recolours the first instead',
        swRef.every(Boolean) && swRef.length > 0 && !swOther.some(Boolean) && swOther.length > 0,
        `${swRef.filter(Boolean).length}/${swRef.length} new-reference frames untouched, ${swOther.filter((x) => !x).length}/${swOther.length} of the first recoloured, in ${s.swapMs} ms`,
      );
      const vOn = s.viewOn ?? [];
      const vOff = s.viewOff ?? [];
      const changed = vOn.filter((v) => !v.endsWith(' none'));
      check(
        'cyanotype strip on: "See original" in the viewer only for the print that changes, showing other colours',
        vOn.length === 4 &&
          changed.length === 2 &&
          changed.every((v) => v.startsWith(s.other) && v.endsWith(' true')) &&
          changed.every((v) => {
            const [a, b] = v.split(' ')[2].split('>');
            return a !== b;
          }) &&
          vOff.length === 4 &&
          vOff.every((v) => v.endsWith(' none')),
        `on: ${vOn.join(' · ')} (mean red/blue, normalized>raw); off: ${vOff.join(' · ')}`,
      );
      check(
        'cyanotype strip off: every frame back to its scan',
        offAll.length > 0 && offAll.every(Boolean),
        `${offAll.filter(Boolean).length}/${offAll.length} frames as scanned, in ${s.offMs} ms`,
      );
      await writeFile(
        join(shots, 'gray-strip.json'),
        `${JSON.stringify({ options: s.options, reference: s.chosen, swappedTo: s.other, ms: { on: s.onMs, swap: s.swapMs, off: s.offMs }, notes: s.notes, frames: { raw: raw.frames, on: on.frames, swapped: swapped.frames, off: off.frames } }, null, 2)}\n`,
      );
    }
    await shot('gray-strip');
    // la vista con la opción puesta: la copia que cambia, en el visor sin normalizar
    await driver.run(
      step(`
      const box = [...document.querySelectorAll('#view-scans label')].find((l) => /Normalize colours with the gray strip/.test(l.textContent)).querySelector('input');
      box.click();
      await ui.until(() => [...document.querySelectorAll('#view-scans td')].some((t) => /Matched to the reference/.test(t.textContent)), 60000, 'the matched print');
      for (const t of document.querySelectorAll('#view-scans .report-thumbs .thumb')) {
        if (t.querySelector('.tag').textContent === 'alignment') continue;
        t.click();
        const lb = await ui.until(() => document.querySelector('.lightbox'), 5000, 'the viewer');
        const btn = lb.querySelector('.lb-alt');
        if (!btn.hidden) {
          btn.click();
          await new Promise((r) => setTimeout(r, 400));
          return true;
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }
      return false;`),
    );
    await shot('gray-strip-on');
    await driver.run(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;`,
    );
  }

  await screen('calibration');
  await screen('help');
  return { checks, mov: movBytes, mp4: Buffer.from(mp4.b64, 'base64') };
}

const { port, close } = await serveDist(DIST);
const report: Record<string, unknown> = {};
let passed = true;
let version = '';
for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  console.log(`\n── ${which}, ${name} (${viewport.width}×${viewport.height})`);
  const shots = join(ARTIFACT_DIR, 'ui', `${which}-${name}`);
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });
  const driver = await launch(which, viewport);
  version = driver.version;
  let checks: Check[] = [];
  try {
    // las pestañas una vez, en la ventana de escritorio: el disco es el mismo
    const out = await runFlow(driver, port, shots, name === 'desktop');
    checks = out.checks;
    if (out.mov) {
      // el MOV de la página, visto por el ffprobe de la máquina: PNG, del
      // tamaño de los recortes, un fotograma por posición de la línea de tiempo
      const file = join(shots, 'demo.mov');
      await writeFile(file, out.mov);
      const r = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_name,width,height,pix_fmt,nb_read_frames',
          '-of',
          'json',
          file,
        ],
        { encoding: 'utf8' },
      );
      const st = (JSON.parse(r.stdout || '{}') as { streams?: Record<string, unknown>[] })
        .streams?.[0];
      const ok = st?.codec_name === 'png' && Number(st?.nb_read_frames) === 6;
      checks.push({
        name: 'MOV decodes with ffmpeg: 6 PNG frames',
        ok,
        detail: JSON.stringify(st ?? r.stderr),
      });
      console.log(`${ok ? '✓' : '✗'} MOV decodes with ffmpeg: ${JSON.stringify(st)}`);
    }
    if (out.mp4) {
      // el MP4 que bajó la página: se reproduce en cualquier sitio (H.264 si
      // el navegador lo codifica), con un fotograma por posición
      const file = join(shots, 'demo.mp4');
      await writeFile(file, out.mp4);
      const r = spawnSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=codec_name,width,height,nb_read_frames',
          '-of',
          'json',
          file,
        ],
        { encoding: 'utf8' },
      );
      const st = (JSON.parse(r.stdout || '{}') as { streams?: Record<string, unknown>[] })
        .streams?.[0];
      const ok =
        ['h264', 'hevc', 'vp9', 'av1'].includes(String(st?.codec_name)) &&
        Number(st?.nb_read_frames) === 6 &&
        Number(st?.width) % 4 === 0;
      checks.push({
        name: 'MP4 decodes with ffmpeg: 6 frames',
        ok,
        detail: JSON.stringify(st ?? r.stderr),
      });
      console.log(`${ok ? '✓' : '✗'} MP4 decodes with ffmpeg: ${JSON.stringify(st)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'flow completed', ok: false, detail: msg });
    console.log(`✗ flow: ${msg}`);
    await writeFile(join(shots, 'failure.png'), await driver.screenshot()).catch(() => {});
  }
  if (driver.pageErrors.length)
    checks.push({ name: 'no uncaught errors', ok: false, detail: driver.pageErrors.join(' / ') });
  await driver.close();
  report[name] = { viewport, checks };
  if (!checks.every((c) => c.ok)) passed = false;
}
close();

const artifact = { suite: 'ui-flow', browser: which, version, passed, runs: report };
const json = `${JSON.stringify(artifact, null, 2)}\n`;
const file = `ui.${which}.json`;
await writeFile(join(ARTIFACT_DIR, file), json);
await writeFile(
  join(ARTIFACT_DIR, `${file}.sha256`),
  `${createHash('sha256').update(json).digest('hex')}  ${file}\n`,
);
console.log(`\n${passed ? '✅ UI OK' : '❌ UI FAILED'} — artifacts/e2e/${file}`);
process.exit(passed ? 0 : 1);
