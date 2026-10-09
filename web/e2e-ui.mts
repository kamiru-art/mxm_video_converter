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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    // C se abre: su barrido NO toca la carpeta de B, que dio señales de vida
    // hace un momento (podría ser una página en la caché de atrás/adelante)
    const tabC = await driver.newTab();
    await openApp(tabC, port, 'scans');
    const kept = await tabC.run<string[]>(`${UNTIL_SWEPT} ${FOLDER_OF(idB)}`);
    check(
      'a closed tab is kept while its last sign of life is recent',
      again === 'processed again' &&
        (opfs ? !!idB && kept.some((f) => /^processed-\d+\//.test(f)) : !idB),
      opfs
        ? `tab B's folder ${idB ? `holds ${kept.filter((f) => /\.png$/.test(f)).length} PNG files` : 'was not found'}`
        : 'no private disk in this browser: frames stay in memory',
    );
    // sin señal reciente (se borra su archivo alive, como si hubiera pasado
    // una hora) y sin candado (se cerró): el barrido de la siguiente pestaña
    // que se abre la vacía
    let swept: string[] = [];
    if (opfs && idB) {
      await tabC.run(
        `const t = await (await navigator.storage.getDirectory()).getDirectoryHandle('tabs'); await (await t.getDirectoryHandle('${idB}')).removeEntry('alive'); return true;`,
      );
      const tabD = await driver.newTab();
      await openApp(tabD, port, 'sheets');
      swept = await tabD.run<string[]>(`${UNTIL_SWEPT} ${FOLDER_OF(idB)}`);
      await tabD.close();
    }
    check(
      'a closed tab with no recent sign of life leaves no frames on disk',
      !opfs || (!!idB && swept.every((f) => f.startsWith('out/'))),
      opfs
        ? `tab B's folder after the sweep: ${swept.join(', ') || 'gone'}`
        : 'no private disk in this browser: frames stay in memory',
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
